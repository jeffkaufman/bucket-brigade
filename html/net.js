import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';
import {LOG_LEVELS} from './lib.js';
import {check} from './lib.js';
import {AudioChunk, PlaceholderChunk, CompressedAudioChunk, ServerClockReference, ClockInterval} from './audiochunk.js'

class ServerConnectionBase {
  constructor() {}

  // This is how much notional time we take up between getting audio and sending it back, server-to-server. ("Notional" becuase the flow of samples is not continuous, so for most purposes the size of the chunks we send to the server must be added to this.)
  get client_window_time() {
    return (this.read_clock - this.write_clock) / this.clock_reference.sample_rate;
  }

  // This is how far behind our target place in the audio stream we are. This must be added to the value above, to find out how closely it's safe to follow behind where we are _aiming_ to be. This value should be small and relatively stable, or something has gone wrong.
  get client_read_slippage() {
    return (this.last_server_clock - this.read_clock - this.audio_offset) / this.clock_reference.sample_rate;
  }
}

export class ServerConnection extends ServerConnectionBase {
  constructor({ target_url, audio_offset_seconds, userid, epoch }) {
    super();

    check(
      target_url !== undefined &&
      audio_offset_seconds !== undefined &&
      userid !== undefined,
      "target_url, audio_offset_seconds, userid must be provided as named parameters");
    check(target_url instanceof URL, "target_url must be a URL");
    check(typeof audio_offset_seconds == "number", "audio_offset_seconds must be a number");
    check(Number.isInteger(userid), "userid must be an integer")

    this.target_url = target_url;
    this.audio_offset_seconds = audio_offset_seconds;
    this.read_clock = null;
    this.write_clock = null;
    this.send_metadata = {
      userid
    };
    this.running = false;
    this.app_epoch = epoch;
  }

  async start() {
    if (this.running) {
      lib.log(LOG_WARNING, "ServerConnection already started, ignoring");
      return;
    }

    const server_clock_data = await query_server_clock(this.target_url);
    if (!server_clock_data) {
      return false;
    }
    var { server_clock, server_sample_rate } = server_clock_data;

    this.clock_reference = new ServerClockReference({ sample_rate: server_sample_rate });
    this.audio_offset = this.audio_offset_seconds * server_sample_rate;
    this.read_clock = server_clock - this.audio_offset;
    this.running = true;
    return true;
  }

  stop() {
    this.running = false;
  }

  set_metadata(send_metadata) {
    // Merge dictionaries
    Object.assign(this.send_metadata, send_metadata);
  }

  async send(chunk) {
    if (!this.running) {
      lib.log(LOG_WARNING, "Not sending to server because not running");
      return {
        metadata: {},
        epoch: this.app_epoch,
        chunk: null
      };
    }
    chunk.check_clock_reference(this.clock_reference);
    var chunk_data = null;

    if (!(chunk instanceof PlaceholderChunk)) {
      chunk_data = chunk.data;

      if (this.write_clock === null) {
        this.write_clock = chunk.start;
      }
      check(this.write_clock == chunk.start, "Trying to send non-contiguous chunk to server");
      // Remember:
      // * Our convention is clock at the END;
      // * We implicitly request as many samples we send, so the more we're sending, the further ahead we need to read from.
      // * For the VERY first request, this means we have to start the clock BEFORE we start accumulating audio to send.
      this.write_clock += chunk.length;  // ... = chunk.end;
    }
    this.read_clock += chunk.length;

    // These could change while we're alseep
    var saved_read_clock = this.read_clock;
    var saved_write_clock = this.write_clock;

    var response = await samples_to_server(chunk_data, this.target_url, {
      read_clock: this.read_clock,
      write_clock: this.write_clock,
      n_samples: chunk.length,
      ... this.send_metadata
    });
    if (!response) {
      return null;
    }
    if (!this.running) {
      lib.log(LOG_WARNING, "ServerConnection stopped while waiting for response from server");
      return {
        metadata: {},
        epoch: this.app_epoch,
        chunk: null
      };
    }

    var metadata = response.metadata;
    check(this.server_sample_rate == metadata.sample_rate, "wrong sample rate from server");
    check(saved_read_clock == metadata.client_read_clock, "wrong read clock from server");
    check(saved_write_clock === null || saved_write_clock == metadata.client_write_clock, "wrong write clock from server");
    this.last_server_clock = metadata.server_clock;

    var result_interval = new ClockInterval({
      reference: this.clock_reference,
      end: saved_read_clock,
      length: chunk.length  // assume we got what we asked for; since it's compressed we can't check, but when we decompress it we will check automatically
    });
    return {
      epoch: this.app_epoch,
      metadata,
      chunk: new CompressedAudioChunk({
        interval: result_interval,
        data: new Uint8Array(response.data)
      })
    };
  }
}

export class FakeServerConnection extends ServerConnectionBase {
  constructor({ sample_rate, epoch }) {
    super();

    check(sample_rate !== undefined, "sample_rate must be provided as a named parameter");
    check(Number.isInteger(sample_rate), "sample_rate must be an integer");

    this.clock_reference = new ServerClockReference({ sample_rate });
    this.read_clock = null;
    this.write_clock = null;
    this.running = false;
    this.app_epoch = epoch;
  }

  async start() {
    if (this.running) {
      lib.log(LOG_WARNING, "FakeServerConnection already started");
      return false;
    }

    this.running = true;
    this.read_clock = Math.round(Date.now() / 1000 * this.clock_reference.sample_rate);
    return true;
  }

  stop() {
    this.running = false;
  }

  set_metadata() {}

  async send(chunk) {
    if (!this.running) {
      lib.log(LOG_WARNING, "Not sending to fake server because not running");
      return {
        metadata: {},
        epoch: this.app_epoch,
        chunk: null
      };
    }
    chunk.check_clock_reference(this.clock_reference);
    var chunk_data = null;

    if (!(chunk instanceof PlaceholderChunk)) {
      chunk_data = chunk.data;

      if (this.write_clock === null) {
        this.write_clock = chunk.start;
      }
      check(this.write_clock == chunk.start, "Trying to send non-contiguous chunk to server");
      // Remember:
      // * Our convention is clock at the END;
      // * We implicitly request as many samples we send, so the more we're sending, the further ahead we need to read from.
      // * For the VERY first request, this means we have to start the clock BEFORE we start accumulating audio to send.
      this.write_clock += chunk.length;  // ... = chunk.end;
    }
    this.read_clock += chunk.length;

    // Adjust the time of chunks we get from the "server" to be contiguous.
    var result_interval = new ClockInterval({
      reference: chunk.reference,
      end: this.read_clock,
      length: chunk.length
    });
    chunk.interval = result_interval;

    return {
      epoch: this.app_epoch,
      metadata: {},
      chunk
    };
  }
}

function fetch_with_retry(resource, init) {
  return fetch(resource, init).catch(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
    return fetch_with_retry(resource, init);
  });
}

export async function query_server_clock(target_url) {
  var request_time_ms = Date.now();
  const fetch_init = {method: "get", cache: "no-store"};
  const fetch_result = await fetch(target_url, fetch_init)
    // Retry immediately on first failure; wait one second after subsequent ones
    .catch(() => fetch_with_retry(target_url, fetch_init));

  if (!fetch_result.ok) {
    throw({
      message: 'Server request gave an error. ' +
        'Talk to whoever is running things, or ' +
        'refresh and try again.',
      unpreventable: true,
    });
  }

  // We need one-way latency; dividing by 2 is unprincipled but probably close enough.
  // XXX: This is not actually correct. We should really be using the roundtrip latency here. Because we want to know not "what is the server clock now", but "what will the server clock be by the time my request reaches the server."
  // Proposed alternative:
  /*
    var request_time_samples = Math.round(request_time_ms * sample_rate / 1000.0);
    var metadata = JSON.parse(fetch_result.headers.get("X-Audio-Metadata"));
    // Add this to "our time now" to yield "server time when it gets our request."
    server_sample_offset = metadata["server_clock"] - request_time_samples;
    // Note: In the presence of network jitter, our message can get to the server either before or after the target server moment. This means that if our target server moment is "now", our actual requested moment could end up in the future. Someone on one side or the other has to deal with this. But in general if we are requesting "now" it means we do not expect to get audio data at all, so it should be okay for us to never ask for audio data in the case (and it should be ok for the server to give us zeros for "future" data, since we should never have asked, but that's what _would_ be there.)
  */
  var server_latency_ms = (Date.now() - request_time_ms) / 2.0;  // Wrong, see above
  var metadata = JSON.parse(fetch_result.headers.get("X-Audio-Metadata"));
  lib.log(LOG_DEBUG, "query_server_clock got metadata:", metadata);
  var server_sample_rate = parseInt(metadata["server_sample_rate"], 10);
  var server_clock = Math.round(metadata["server_clock"] + server_latency_ms * server_sample_rate / 1000.0);
  lib.log(LOG_INFO, "Server clock is estimated to be:", server_clock, " (", metadata["server_clock"], "+", server_latency_ms * server_sample_rate / 1000.0);
  return { server_clock, server_sample_rate };
}

var xhrs_inflight = 0;
export async function samples_to_server(outdata, target_url, send_metadata) {
  // Not a tremendous improvement over having too many parameters, but a bit.
  var { read_clock, write_clock, username, userid, chatsToSend, requestedLeadPosition, markStartSinging, markStopSinging,
        loopback_mode, n_samples, globalVolumeToSend, backingVolumeToSend,
        micVolumesToSend, backingTrackToSend, monitoredUserIdToSend,
        event_data,
      } = send_metadata;
  if (outdata === null) {
    outdata = new Uint8Array();
  }

  return new Promise((resolve) => {
    var xhr = new XMLHttpRequest();
    xhr.onerror = () => {
      resolve(null);
    }
    xhr.onreadystatechange = () => {
      if (xhr.readyState == 4 /* done*/) {
        handle_xhr_result(xhr, resolve);
      }
    };
    xhr.debug_id = Date.now();

    var params = new URLSearchParams();

    params.set('read_clock', read_clock);
    params.set('n_samples', n_samples);
    if (write_clock !== null) {
      params.set('write_clock', write_clock);
    }
    if (loopback_mode == "server") {
      params.set('loopback', true);
      lib.log(LOG_SPAM, "looping back samples at server");
    }
    params.set('username', username);
    params.set('userid', userid);
    if (chatsToSend.length) {
      params.set('chat', JSON.stringify(chatsToSend));
    }
    if (requestedLeadPosition) {
      params.set('request_lead', '1');
    }
    if (markStartSinging) {
      params.set('mark_start_singing', '1');
    }
    if (markStopSinging) {
      params.set('mark_stop_singing', '1');
    }
    if (globalVolumeToSend != null) {
      params.set('volume', globalVolumeToSend);
    }
    if (backingVolumeToSend != null) {
      params.set('backing_volume', backingVolumeToSend);
    }
    if (micVolumesToSend.length > 0) {
      params.set('mic_volume', JSON.stringify(micVolumesToSend));
    }
    if (backingTrackToSend) {
      params.set('track', backingTrackToSend);
    }
    if (monitoredUserIdToSend) {
      params.set('monitor', monitoredUserIdToSend);
    }

    target_url.search = params.toString();

    // Arbitrary cap; browser cap is 8(?) after which they queue
    if (xhrs_inflight >= 4) {
      lib.log(LOG_WARNING, "NOT SENDING XHR w/ ID:", xhr.debug_id, " due to limit -- already in flight:", xhrs_inflight);
      resolve(null);
    }

    lib.log(LOG_SPAM, "Sending XHR w/ ID:", xhr.debug_id, "already in flight:", xhrs_inflight++, "; data size:", outdata.length);
    xhr.open("POST", target_url, true);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Event-Data", JSON.stringify(event_data));
    xhr.responseType = "arraybuffer";
    xhr.send(outdata);
    lib.log(LOG_SPAM, "... XHR sent.");
  });
}

// Only called when readystate is 4 (done)
function handle_xhr_result(xhr, resolve) {
  /* XXX: this state is no longer shared with us easily
  if (!running) {
    lib.log(LOG_WARNING, "Got XHR onreadystatechange w/ID:", xhr.debug_id, "for xhr:", xhr, " when done running; still in flight:", --xhrs_inflight);
    return reject();
  }
  */

  if (xhr.status == 200) {
    var metadata = JSON.parse(xhr.getResponseHeader("X-Audio-Metadata"));
    lib.log(LOG_SPAM, "metadata:", metadata);
    lib.log(LOG_SPAM, "Got XHR response w/ ID:", xhr.debug_id, "result:", xhr.response, " -- still in flight:", --xhrs_inflight);
    if (metadata["kill_client"]) {
      lib.log(LOG_ERROR, "Received kill from server");
      resolve(null);
    }

    return resolve({
      metadata: metadata,
      data: xhr.response
    });
  } else {
    lib.log(LOG_ERROR, "XHR failed w/ ID:", xhr.debug_id, "stopping:", xhr, " -- still in flight:", --xhrs_inflight);
    resolve(null);
  }
}
