import {check} from './lib.js';
import {AudioChunk, PlaceholderChunk, CompressedAudioChunk, ServerClockReference, ClockInterval} from './audiochunk.js'

// This gates all the logs that put references to REALLY HUGE objects into the console
//   very frequently. When this is on, having the console open eventually causes the
//   browser to lag severely and dev tools to lag/hang/crash. Don't use this unless
//   you actually need it.
const LOG_ULTRA_VERBOSE = false;
// XXX:
console.debug = () => {}

class ServerConnectionBase {
  constructor() {}

  // This is how much notional time we take up between getting audio and sending it back, server-to-server. ("Notional" because the flow of samples is not continuous, so for most purposes the size of the chunks we send to the server must be added to this.)
  get client_window_time() {
    if (!this.running || !this.read_clock || !this.write_clock || !this.clock_reference.sample_rate) {
      return undefined;
    }
    return (this.read_clock - this.write_clock) / this.clock_reference.sample_rate;
  }

  // This is how far behind our target place in the audio stream we are. This must be added to the value above, to find out how closely it's safe to follow behind where we are _aiming_ to be. This value should be small and relatively stable, or something has gone wrong.
  get clientReadSlippage() {
    if (!this.running) {
      return undefined;
    }
    return (this.last_server_clock - this.read_clock - this.audio_offset) / this.clock_reference.sample_rate;
  }
}

export class ServerConnection extends ServerConnectionBase {
  constructor({ target_url, audio_offset_seconds, userid, receive_cb, failure_cb }) {
    super();

    check(
      target_url !== undefined &&
      audio_offset_seconds !== undefined &&
      userid !== undefined,
      "target_url, audio_offset_seconds, userid, receive_cb must be provided as named parameters");
    check(target_url instanceof URL, "target_url must be a URL");
    check(typeof audio_offset_seconds == "number", "audio_offset_seconds must be a number");
    check(Number.isInteger(userid), "userid must be an integer")

    this.target_url = target_url;
    this.audio_offset_seconds = audio_offset_seconds;
    this.read_clock = null;
    this.write_clock = null;
    this.userid = userid;
    this.send_metadata = {};
    this.json_kvs = {}
    this.running = false;
    this.receive_cb = receive_cb;
    this.failure_cb = failure_cb;
  }

  async start() {
    if (this.running || this.starting) {
      console.warn("ServerConnection already started, ignoring");
      return;
    }
    this.starting = true;

    const server_clock_data = await query_server_clock(this.target_url);
    if (!server_clock_data || !this.starting) {
      return false;
    }
    var { server_clock, server_sample_rate } = server_clock_data;

    this.clock_reference = new ServerClockReference({ sample_rate: server_sample_rate });
    this.audio_offset = this.audio_offset_seconds * server_sample_rate;
    this.read_clock = server_clock - this.audio_offset;
    this.running = true;
    this.starting = false;
    return true;
  }

  stop() {
    this.starting = false;
    this.running = false;
  }

  set_metadata(send_metadata) {
    this.send_metadata = send_metadata;
  }

  set_json_kv(key, value) {
    this.json_kvs[key] = value;
  }

  send(chunk) {
    if (!this.running) {
      console.warn("Not sending to server because not running");
      return;
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

    // These could change while we're asleep
    var saved_read_clock = this.read_clock;
    var saved_write_clock = this.write_clock;

    let json_kvs_str = JSON.stringify(this.json_kvs);
    if (json_kvs_str === "{}") {
      json_kvs_str = null;
    }
    this.json_kvs = {};
    samples_to_server(chunk_data, this.target_url, json_kvs_str, {
      read_clock: this.read_clock,
      write_clock: this.write_clock,
      n_samples: chunk.length,
      userid: this.userid,
      ... this.send_metadata
    }).then(this.server_response.bind(this), this.server_failure.bind(this));
  }

  server_failure(e) {
    console.warn("Failure talking to server:", e);
    this.failure_cb();
    this.stop();
    return;
  }

  server_response(response) {
    if (!response) {
      this.server_failure("No server response");
      return;
    }
    if (!this.running) {
      console.warn("ServerConnection stopped while waiting for response from server");
      return;
    }

    var metadata = response.metadata;
    try {
      check(this.server_sample_rate == metadata.sample_rate, "wrong sample rate from server");
      // XXX check(saved_read_clock == metadata.client_read_clock, "wrong read clock from server");
      // XXX check(saved_write_clock === null || saved_write_clock == metadata.client_write_clock, "wrong write clock from server");
    } catch(e) {
      this.server_failure(e);
      return;
    }

    this.last_server_clock = metadata.server_clock;

    var result_interval = new ClockInterval({
      reference: this.clock_reference,
      end: metadata.client_read_clock,
      length: metadata.n_samples,
    });

    metadata.user_summary = [];

    let data = response.data;
    if (data.byteLength > 0) {
      const users_in_summary =
            new DataView(data).getUint16(0, /*littleEndian=*/false);
      const utf8decoder = new TextDecoder();

      let pos = 2;
      for (var user_index = 0; user_index < users_in_summary;
           user_index++) {
        // getUint64 doesn't exist, but we know here that it's < MAX_SAFE_INT
        const useridView = new DataView(data.slice(pos, pos + 8));
        const left =  useridView.getUint32(0, /*littleEndian=*/false);
        const right = useridView.getUint32(4, /*littleEndian=*/false);
        const userid = "" + (2**32*left + right);
        pos += 8;

        let name = "<undecodable>";
        try {
          name = utf8decoder.decode(data.slice(pos, pos + 32)).replace(/\0/g, "");
        } catch {}
        pos += 32;

        const mic_volume =
              new DataView(data.slice(pos, pos + 4)).getFloat32(0);
        pos += 4;

        const rms_volume =
              new DataView(data.slice(pos, pos + 4)).getFloat32(0);
        pos += 4;

        const delay =
              new DataView(data.slice(pos, pos + 2)).getUint16(
                0, /*littleEndian=*/false);
        pos += 2;

        const bits =
              new DataView(data.slice(pos, pos + 1)).getUint8(0);
        const muted = bits & 0b00000001;
        const is_monitored = bits & 0b00000010;
        pos += 1;

        metadata.user_summary.push([
          delay, name, mic_volume, userid, rms_volume, muted, is_monitored]);
      }
      data = data.slice(pos);
    }

    data = new Uint8Array(data)
    this.receive_cb({
      epoch: this.app_epoch,
      metadata,
      chunk: new CompressedAudioChunk({
        interval: result_interval,
        data
      })
    });
  }
}

// XXX this is not great, we will just hang around chaining 1s promises forever until the server comes back up... maybe that's what we want? but there's no higher-level control over the process.
function fetch_with_retry(resource, init) {
  return fetch(resource, init).catch(async () => {
    await new Promise((resolve) => {
      console.warn("fetch_with_retry failed, waiting 1s", resource);
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
    .catch(() => {
      console.warn("First fetch failed in query_server_clock, retrying");
      return fetch_with_retry(target_url, fetch_init)
    });

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
  // Ref: https://github.com/gwillen/solstice-audio-test/issues/38
  var server_latency_ms = (Date.now() - request_time_ms) / 2.0;  // Wrong, see above
  var metadata = JSON.parse(fetch_result.headers.get("X-Audio-Metadata"));
  console.debug("query_server_clock got metadata:", metadata);
  var server_sample_rate = parseInt(metadata["server_sample_rate"], 10);
  var server_clock = Math.round(metadata["server_clock"] + server_latency_ms * server_sample_rate / 1000.0);
  console.info("Server clock is estimated to be:", server_clock, " (", metadata["server_clock"], "+", server_latency_ms * server_sample_rate / 1000.0);
  return { server_clock, server_sample_rate };
}

var xhrs_inflight = 0;
export async function samples_to_server(
     outdata, target_url, json_kvs_str, send_metadata) {
  console.debug("samples_to_server send_metadata:", send_metadata,
                "json_kvs_str", json_kvs_str);
  if (outdata === null) {
    outdata = new Uint8Array();
  }

  if (json_kvs_str) {
    const json_kvs_bytes = (new TextEncoder()).encode(json_kvs_str);
    send_metadata.json_len = json_kvs_bytes.length;

    const combined_outdata =
          new Uint8Array(json_kvs_bytes.length + outdata.length);
    combined_outdata.set(json_kvs_bytes);
    combined_outdata.set(outdata, json_kvs_bytes.length);
    outdata = combined_outdata;
  }

  return new Promise((resolve, reject) => {
    var xhr = new XMLHttpRequest();
    xhr.onerror = () => {
      reject("xhr.onerror fired");
    }
    xhr.onreadystatechange = () => {
      if (xhr.readyState == 4 /* done*/) {
        handle_xhr_result(xhr, resolve, reject);
      }
    };
    xhr.debug_id = Date.now();

    var params = new URLSearchParams();

    // Going forward, I would like to simplify by:
    // (1) using the same names for parameters on the server and the client
    // (2) only setting parameters if we want to send them, and always sending them as-is
    // The below has been carefully crafted to preserve the exact behavior we had before, when we had a separate "if" statement for every single parameter.

    const param_map = {
      chats: 'chat',
      requestedLeadPosition: 'request_lead',
      markStartSinging: 'mark_start_singing',
      markStopSinging: 'mark_stop_singing',
      globalVolume: 'volume',
      backingVolume: 'backing_volume',
      micVolumes: 'mic_volume',
      backingTrack: 'track',
      loopback_mode: 'loopback',
    }

    const skip_params = []
    const truthy_params = ['track', 'monitor'];
    const nonnull_params = ['write_clock', 'volume', 'backing_volume', 'bpm', 'repeats', 'bpr'];
    const stringify_params = ['chat', 'mic_volume', 'event_data', 'client_telemetry'];
    const flag_params = ['request_lead', 'mark_start_singing', 'mark_stop_singing'];

    for (var k in send_metadata) {
      var v = send_metadata[k];
      //console.log("BEFORE MAPPING:", k, v);

      if (k in param_map) {
        k = param_map[k];
      }

      var send_v = v;
      if (skip_params.includes(k))
        continue;
      if (truthy_params.includes(k) && !v)
        continue;
      if (nonnull_params.includes(k) && v === null)
        continue;
      if (stringify_params.includes(k))
        send_v = JSON.stringify(v);
      if (flag_params.includes(k))
        send_v = '1';
      if (k == "loopback") {
        if (v == "server") {
          console.debug("SPAM", "looping back samples at server");
          send_v = true;
        } else {
          continue;
        }
      }

      //console.log("AFTER MAPPING:", k, send_v);
      // Default is to send the parameter exactly as we received it
      params.set(k, send_v);
    }

    target_url.search = params.toString();

    // Arbitrary cap; browser cap is 8(?) after which they queue
    if (xhrs_inflight >= 4) {
      console.warn("NOT SENDING XHR w/ ID:", xhr.debug_id, " due to limit -- already in flight:", xhrs_inflight);
      return resolve(null);
    }

    console.debug("SPAM", "Sending XHR w/ ID:", xhr.debug_id, "already in flight:", xhrs_inflight++, "; data size:", outdata.length);
    xhr.open("POST", target_url, true);
    xhr.responseType = "arraybuffer";
    xhr.send(outdata);
    if (LOG_ULTRA_VERBOSE) {
      console.debug("SPAM", "... XHR sent.");
    }
  });
}

// Only called when readystate is 4 (done)
function handle_xhr_result(xhr, resolve, reject) {
  --xhrs_inflight;

  if (xhr.status == 200) {
    let metadata = JSON.parse(xhr.getResponseHeader("X-Audio-Metadata"));
    let data = xhr.response;

    const metadata_len = metadata.metadata_len;
    if (metadata_len) {
      metadata = JSON.parse(new TextDecoder('utf8').decode(
        data.slice(0, metadata_len)));
      data = data.slice(metadata_len);
    }

    if (LOG_ULTRA_VERBOSE) {
      console.debug("SPAM", "metadata:", metadata);
      console.debug("SPAM", "Got XHR response w/ ID:", xhr.debug_id, "result:", xhr.response, " -- still in flight:", xhrs_inflight);
    }

    return resolve({metadata, data});
  } else {
    console.error("XHR failed w/ ID:", xhr.debug_id, "stopping:", xhr, " -- still in flight:", xhrs_inflight);
    var metadata_raw = xhr.getResponseHeader("X-Audio-Metadata");

    if (metadata_raw) {
      try {
        var metadata = JSON.parse(metadata_raw);
        console.warning("metadata on failed XHR:", metadata);
        if (metadata.kill_client) {
          console.error("Received kill from server:", metadata.message);
          return reject("Received kill from server: " + metadata.message);
        }
      } catch { /* ignore JSON parse failure when already failing */ }
    }

    return reject("XHR failed w/ status " + xhr.status);
  }
}
