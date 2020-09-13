import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';
import {LOG_LEVELS} from './lib.js';

export async function query_server_clock(loopback_mode, target_url, sample_rate) {
  if (loopback_mode == "main") {
    // I got yer server right here!
    return Math.round(Date.now() * sample_rate / 1000.0);
  } else {
    var request_time_ms = Date.now();
    var fetch_result = await fetch(target_url, {
      method: "get",  // default
      cache: "no-store",
    });
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
    var server_clock = Math.round(metadata["server_clock"] + server_latency_ms * sample_rate / 1000.0);
    lib.log(LOG_INFO, "Server clock is estimated to be:", server_clock, " (", metadata["server_clock"], "+", server_latency_ms * sample_rate / 1000.0);
    return server_clock;
  }
}

var xhrs_inflight = 0;
export async function samples_to_server(outdata, target_url, send_metadata) {
  // Not a tremendous improvement over having too many parameters, but a bit.
  var { read_clock, write_clock, username, chatsToSend, requestedLeadPosition,
    loopback_mode } = send_metadata;

  return new Promise((resolve, reject) => {
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = () => {
      if (xhr.readyState == 4 /* done*/) {
        handle_xhr_result(xhr, resolve, reject);
      }
    };
    xhr.debug_id = Date.now();

    try {
      var params = new URLSearchParams();

      params.set('read_clock', read_clock);
      if (write_clock !== null) {
        params.set('write_clock', write_clock);
      }
      if (loopback_mode == "server") {
        params.set('loopback', true);
        lib.log(LOG_DEBUG, "looping back samples at server");
      }
      if (username) {
        params.set('username', username);
      }
      if (chatsToSend.length) {
        params.set('chat', JSON.stringify(chatsToSend));
        chatsToSend = [];
      }
      if (requestedLeadPosition) {
        params.set('request_lead', '1');
        requestedLeadPosition = false;
      }

      target_url.search = params.toString();

      // Arbitrary cap; browser cap is 8(?) after which they queue
      if (xhrs_inflight >= 4) {
        lib.log(LOG_WARNING, "NOT SENDING XHR w/ ID:", xhr.debug_id, " due to limit -- already in flight:", xhrs_inflight);
        // XXX XXX try_increase_batch_size_and_reload();
        return reject();
      }

      lib.log(LOG_SPAM, "Sending XHR w/ ID:", xhr.debug_id, "already in flight:", xhrs_inflight++, "; data size:", outdata.length);
      xhr.open("POST", target_url, true);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.responseType = "arraybuffer";
      xhr.send(outdata);
      lib.log(LOG_SPAM, "... XHR sent.");
    } catch(e) {
      lib.log(LOG_ERROR, "Failed to make XHR:", e);
      //stop();
      return reject();
    }
  });
}

// Only called when readystate is 4 (done)
function handle_xhr_result(xhr, resolve, reject) {
  /* XXX: this state is no longer shared with us easily
  if (!running) {
    lib.log(LOG_WARNING, "Got XHR onreadystatechange w/ID:", xhr.debug_id, "for xhr:", xhr, " when done running; still in flight:", --xhrs_inflight);
    return reject();
  }
  */

  if (xhr.status == 200) {
    var metadata = JSON.parse(xhr.getResponseHeader("X-Audio-Metadata"));
    lib.log(LOG_DEBUG, "metadata:", metadata);

    lib.log(LOG_SPAM, "Got XHR response w/ ID:", xhr.debug_id, "result:", xhr.response, " -- still in flight:", --xhrs_inflight);
    if (metadata["kill_client"]) {
      lib.log(LOG_ERROR, "Received kill from server");
      //XXX reload_settings();
      return reject();
    }

    return resolve({
      metadata: metadata,
      data: xhr.response
    });
  } else {
    lib.log(LOG_ERROR, "XHR failed w/ ID:", xhr.debug_id, "stopping:", xhr, " -- still in flight:", --xhrs_inflight);

    //try_increase_batch_size_and_reload();
    return reject();
  }
}
