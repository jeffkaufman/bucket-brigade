import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';
import {LOG_LEVELS} from './lib.js';

// Work around some issues related to caching and error reporting
//   by forcing this to load up top, before we try to 'addModule' it.
import './audio-worklet.js';

const session_id = Math.floor(Math.random() * 2**32).toString(16);
lib.set_logging_session_id(session_id);
lib.set_logging_context_id("main");


const SAMPLE_BATCH_SIZE = 150;

lib.log(LOG_INFO, "Starting up");

function close_stream(stream) {
  stream.getTracks().forEach((track) => track.stop());
}

async function force_permission_prompt() {
  // In order to enumerate devices, we must first force a permission prompt by opening a device and then closing it again.
  // See: https://stackoverflow.com/questions/60297972/navigator-mediadevices-enumeratedevices-returns-empty-labels
  var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  close_stream(stream);
}

export async function wait_for_mic_permissions() {
  try {
    var perm_status = await navigator.permissions.query({name: "microphone"});
    if (perm_status.state == "granted" || perm_status.state == "denied") {
      return;
    }
  } catch {
    await force_permission_prompt();
    return;
  }

  force_permission_prompt();
  return new Promise((resolve, reject) => {
    perm_status.onchange = (e) => {
      if (e.target.state == "granted" || e.target.state == "denied") {
        resolve();
      }
    }
  });
}

var audioCtx;

var running = false;

export var start_hooks = [];
export var stop_hooks = [];
export var event_hooks = [];
export var learned_latency_hooks = [];
export var xhr_result_hooks = [];
export var mic_sample_hooks = [];
var event_data = [];
var alarms = {};
var alarms_fired = {};
var cur_clock_cbs = [];

export function declare_event(evid, offset) {
  cur_clock_cbs.push( (clock)=>{ event_data.push({evid,clock:clock-(offset||0)*sample_rate}); } );
  playerNode.port.postMessage({
    type: "request_cur_clock"
  });
}

async function configure_input_node(audioCtx, deviceId, {click_bpm}) {
  synthetic_audio_source = null;
  if (deviceId == "NUMERIC" ||
      deviceId == "CLICKS" ||
      deviceId == "ECHO") {
    synthetic_audio_source = deviceId;
    synthetic_click_interval = 60.0 / parseFloat(click_bpm);
    // Signal the audioworklet for special handling, then treat as "SILENCE" for other purposes.
    deviceId = "SILENCE";
  }

  if (deviceId == "SILENCE") {
    var buffer = audioCtx.createBuffer(1, 128, audioCtx.sampleRate);
    var source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopEnd = source.buffer.duration;
    source.start();
    return source;
  } else if (deviceId == "HAMILTON") {
    override_gain = 0.5;
    var hamilton_audio = hamilton_audio_span.getElementsByTagName('audio')[0];
    // Can't use createMediaElementSource because you can only
    //   ever do that once per element, so we could never restart.
    //   See: https://github.com/webAudio/web-audio-api/issues/1202
    var source = audioCtx.createMediaStreamSource(hamilton_audio.captureStream());
    // NOTE: You MUST NOT call "load" on the element after calling
    //   captureStream, or the capture will break. This is not documented
    //   anywhere, of course.
    hamilton_audio.muted = true;  // Output via stream only
    hamilton_audio.loop = true;
    hamilton_audio.controls = false;
    lib.log(LOG_DEBUG, "Starting playback of hamilton...");
    await hamilton_audio.play();
    lib.log(LOG_DEBUG, "... started");
    return source;
  }

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
      deviceId: { exact: deviceId }
    }
  });

  return new MediaStreamAudioSourceNode(audioCtx, { mediaStream: micStream });
}

function configure_output_node(audioCtx, deviceId) {
  synthetic_audio_sink = false;
  var dest = audioCtx.createMediaStreamDestination();

  if (deviceId == "NUMERIC") {
    // Leave the device empty, but signal the worklet for special handling
    synthetic_audio_sink = true;
  } else if (deviceId == "NOWHERE") {
    // Leave the device empty
  } else {
    var audio_out = new Audio();
    audio_out.srcObject = dest.stream;
    audio_out.setSinkId(deviceId);
    audio_out.play();
  }

  return dest;
}

// NOTE NOTE NOTE:
// * All `clock` variables are measured in samples.
// * All `clock` variables represent the END of an interval, NOT the
//   beginning. It's arbitrary which one to use, but you have to be
//   consistent, and trust me that it's slightly nicer this way.
var server_clock;
var playerNode;
var micStream;
var read_clock;
var mic_buf;
var mic_buf_clock;
var loopback_mode;
var server_path;
var audio_offset;
var xhrs_inflight;
var override_gain = 1.0;
var synthetic_audio_source;
var synthetic_audio_sink;
var synthetic_click_interval;
export var sample_rate = 11025;  // Firefox may get upset if we use a weird value here?
var local_latency_ms = 0;


async function query_server_clock() {
  if (loopback_mode == "main") {
    // I got yer server right here!
    server_clock = Math.round(Date.now() * sample_rate / 1000.0);
  } else {
    var target_url = new URL(server_path);
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
    server_clock = Math.round(metadata["server_clock"] + server_latency_ms * sample_rate / 1000.0);
    lib.log(LOG_INFO, "Server clock is estimated to be:", server_clock, " (", metadata["server_clock"], "+", server_latency_ms * sample_rate / 1000.0);
  }
}

var estimate_latency_mode = false;
export function estimate_latency_toggle() {
  estimate_latency_mode = !estimate_latency_mode;
  playerNode.port.postMessage({
    "type": "latency_estimation_mode",
    "enabled": estimate_latency_mode
  });
  return estimate_latency_mode;
}

var click_volume_getter = (() => 0);

export function register_click_volume_getter(cvg) {
  click_volume_getter = cvg;
}

export function click_volume_change() {
  playerNode.port.postMessage({
    "type": "click_volume_change",
    "value": click_volume_getter()
  });
}

var muted = false;
export function toggle_mute() {
  muted = !muted;
  playerNode.port.postMessage({
    "type": "mute_mode",
    "enabled": muted
  });
  return muted;
}

export async function start({input_device_id, output_device_id, input_opts, audio_offset, loopback, server_url}) {
  running = true;
  audio_offset = parseInt(audio_offset) * sample_rate;

  read_clock = null;
  mic_buf = [];
  mic_buf_clock = null;
  xhrs_inflight = 0;
  override_gain = 1.0;

  var AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext({ sampleRate: sample_rate });
  lib.log(LOG_DEBUG, "Audio Context:", audioCtx);

  loopback_mode = loopback;

  var micNode = await configure_input_node(audioCtx, input_device_id, input_opts);
  var spkrNode = configure_output_node(audioCtx, output_device_id);

  server_path = server_url;

  await audioCtx.audioWorklet.addModule('audio-worklet.js');
  playerNode = new AudioWorkletNode(audioCtx, 'player');
  // Stop if there is an exception inside the worklet.
  playerNode.addEventListener("processorerror", stop);
  playerNode.port.postMessage({
    type: "log_params",
    session_id: session_id,
    log_level: lib.log_level
  });

  await query_server_clock();
  read_clock = server_clock - audio_offset;
//  lib.log(LOG_DEBUG,{when:'just_set',read_clock,server_clock,audio_offset,sample_rate});

  // Send this before we set audio params, which declares us to be ready for audio
  send_local_latency();
  click_volume_change();
  var audio_params = {
    type: "audio_params",
    synthetic_source: synthetic_audio_source,
    click_interval: synthetic_click_interval,
    synthetic_sink: synthetic_audio_sink,
    loopback_mode: loopback_mode
  }
  console.log({audio_params});
  playerNode.port.postMessage(audio_params);

  playerNode.port.onmessage = handle_message;
  micNode.connect(playerNode);

  // This may not work in Firefox.
  playerNode.connect(spkrNode);

  alarms_fired = {};
  for (let hook of start_hooks) {
    hook();
  }

//  lib.log(LOG_DEBUG,{when:'finished start',read_clock});
  // To use the default output device, which should be supported on all browsers, instead use:
  // playerNode.connect(audioCtx.destination);
}

export function init_events() {
  let target_url = server_path + "reset_events";
  lib.log(LOG_DEBUG,{server_path,target_url,where:'init_events'});
  let xhr = new XMLHttpRequest();
  xhr.open("POST", target_url, true);
  xhr.send();
}

function send_local_latency() {
  // TODO: reimplement robustly if useful
  //  if (local_latency_ms > 0) {
  //    window.localStorage.setItem("local_latency", Math.round(local_latency_ms));
  //  }

  // Convert from ms to samples.
  var local_latency = Math.round(local_latency_ms * sample_rate / 1000);

  if (synthetic_audio_source !== null) {
    local_latency = 0;
  }
  playerNode.port.postMessage({
    "type": "local_latency",
    "local_latency": local_latency,
  });
}

function samples_to_worklet(samples, clock) {
  var message = {
    type: "samples_in",
    samples: samples,
    clock: clock
  };

  lib.log(LOG_SPAM, "Posting to worklet:", message);
  playerNode.port.postMessage(message);
}

// XXX
var sample_encoding = {
  client: Int8Array,
  server: "b",
  // Translate from/to Float32
  send: (x) => {
    x = x * override_gain * 128;
    x = Math.max(Math.min(x, 127), -128);
    return x;
  },
  recv: (x) => x / 127.0
};

function handle_message(event) {
  var msg = event.data;
  lib.log(LOG_VERYSPAM, "onmessage in main thread received ", msg);

//  lib.log(LOG_DEBUG,{when:'got msg',read_clock,msgt:msg.type});
  
  if (!running) {
    lib.log(LOG_WARNING, "Got message when done running");
    return;
  }

  if (msg.type == "exception") {
    lib.log(LOG_ERROR, "Exception thrown in audioworklet:", msg.exception);
    stop();
    return;
  } else if (msg.type == "latency_estimate") {
    local_latency_ms = msg.latency;
    for (let hook of learned_latency_hooks) {
      hook(msg);
    }
    send_local_latency();
  } else if (msg.type == "alarm") {
    if ((msg.time in alarms) && ! (msg.time in alarms_fired)) {
      alarms[msg.time]();
      alarms_fired[msg.time] = True;
    }
    return;
  } else if (msg.type == "cur_clock") {
    for (let cb of cur_clock_cbs) {
      cb(msg.clock);
    }
    cur_clock_cbs = [];
    return
  } else if (msg.type != "samples_out") {
    lib.log(LOG_ERROR, "Got message of unknown type:", msg);
    stop();
    return;
  }

  //XXX lib.log_every(10, "audioCtx", LOG_DEBUG, "audioCtx:", audioCtx);
  var mic_samples = msg.samples;
  mic_buf.push(mic_samples);

  var peak_in = 0.0;

  if (mic_buf.length == SAMPLE_BATCH_SIZE) {
    // Resampling here works automatically for now since we're copying sample-by-sample
    var outdata = new sample_encoding["client"](mic_buf.length * mic_samples.length);
    if (msg.clock !== null) {
      for (var i = 0; i < mic_buf.length; i++) {
        for (var j = 0; j < mic_buf[i].length; j++) {
          if (Math.abs(mic_buf[i][j]) > peak_in) {
            peak_in = Math.abs(mic_buf[i][j]);
          }
          outdata[i * mic_buf[0].length + j] = sample_encoding["send"](mic_buf[i][j]);
        }
      }
      for (let hook of mic_sample_hooks) {
        hook(peak_in);
      }
    } else {
      // Still warming up
      for (var i = 0; i < mic_buf.length; i++) {
        for (var j = 0; j < mic_buf[i].length; j++) {
          if (mic_buf[i][j] !== 0) {
            lib.log_every(12800, "nonzero_warmup", LOG_ERROR, "Nonzero mic data during warmup, huh?");
            //throw "Nonzero mic data during warmup, huh?"
          }
        }
      }
    }
    mic_buf = [];

    if (loopback_mode == "main") {
      lib.log(LOG_DEBUG, "looping back samples in main thread");
      var result = new Float32Array(outdata.length);
      for (var i = 0; i < outdata.length; i++) {
        result[i] = sample_encoding["recv"](outdata[i]);
      }
      // Clocks are at the _end_ of intervals; the longer we've been
      //   accumulating data, the more we have to read. (Trust me.)
      read_clock += outdata.length;
      samples_to_worklet(result, read_clock);
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = () => {
      if (xhr.readyState == 4 /* done*/) {
        handle_xhr_result(xhr);
      }
    };
    xhr.debug_id = Date.now();

    try {
      var target_url = new URL(server_path);
      var params = new URLSearchParams();
      // Response size always equals request size.
      // Clocks are at the _end_ of intervals; the longer we've been
      //   accumulating data, the more we have to read. (Trust me.)
      lib.log(LOG_DEBUG,{read_clock,odl:outdata.length});
      read_clock += outdata.length;
      params.set('read_clock', read_clock);
      if (msg.clock !== null) {
        params.set('write_clock', msg.clock);
      }
      params.set('encoding', sample_encoding["server"]);
      if (loopback_mode == "server") {
        params.set('loopback', true);
        lib.log(LOG_DEBUG, "looping back samples at server");
      }
      target_url.search = params.toString();

      // Arbitrary cap; browser cap is 8(?) after which they queue
      if (xhrs_inflight >= 4) {
        lib.log(LOG_WARNING, "NOT SENDING XHR w/ ID:", xhr.debug_id, " due to limit -- already in flight:", xhrs_inflight);
        // XXX: This is a disaster probably
        // Discard outgoing data.

        // Incoming data should take care of itself -- our outgoing
        //   request clocks are tied to the isochronous audioworklet
        //   process() cycle.
        return
      }

      lib.log(LOG_SPAM, "Sending XHR w/ ID:", xhr.debug_id, "already in flight:", xhrs_inflight++, "; data size:", outdata.length);
      xhr.open("POST", target_url, true);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-Event-Data", JSON.stringify(event_data));
      event_data = [];
      xhr.responseType = "arraybuffer";
      xhr.send(outdata);
      lib.log(LOG_SPAM, "... XHR sent.");
    } catch(e) {
      lib.log(LOG_ERROR, "Failed to make XHR:", e);
      stop();
      return;
    }
  }
}

// Only called when readystate is 4 (done)
function handle_xhr_result(xhr) {
  if (!running) {
    lib.log(LOG_WARNING, "Got XHR onreadystatechange w/ID:", xhr.debug_id, "for xhr:", xhr, " when done running; still in flight:", --xhrs_inflight);
    return;
  }

  if (xhr.status == 200) {
    var metadata = JSON.parse(xhr.getResponseHeader("X-Audio-Metadata"));
    lib.log(LOG_DEBUG, "metadata:", metadata);
    var result = new sample_encoding["client"](xhr.response);
    var play_samples = new Float32Array(result.length);
    var peak_out = 0;
    for (var i = 0; i < result.length; i++) {
      play_samples[i] = sample_encoding["recv"](result[i]);
      if (Math.abs(play_samples[i]) > peak_out) {
        peak_out = Math.abs(play_samples[i]);
      }
    }

    lib.log(LOG_SPAM, "Got XHR response w/ ID:", xhr.debug_id, "result:", result, " -- still in flight:", --xhrs_inflight);
    if (metadata["kill_client"]) {
      lib.log(LOG_ERROR, "Received kill from server");
      stop()
      return;
    }
    samples_to_worklet(play_samples, metadata["client_read_clock"]);

    for (let ev of metadata["events"]) {  
      alarms[ev["clock"]] = () => event_hooks.map(f=>f(ev["evid"]));
      lib.log(LOG_INFO, ev);  
      playerNode.port.postMessage({
        type: "set_alarm",
        time: ev["clock"]
      });
    }

    for (let hook of xhr_result_hooks) {
      hook(metadata, peak_out, play_samples.length);
    }
    
  } else {
    lib.log(LOG_ERROR, "XHR failed w/ ID:", xhr.debug_id, "stopping:", xhr, " -- still in flight:", --xhrs_inflight);
    stop();
    return;
  }
}

export async function stop() {
  running = false;

  lib.log(LOG_INFO, "Closing audio context and mic stream...");
  if (audioCtx) {
    await audioCtx.close();
    audioCtx = undefined;
  }
  if (micStream) {
    close_stream(micStream);
    micStream = undefined;
  }
  lib.log(LOG_INFO, "...closed.");

  for (let hook of stop_hooks) {
    hook();
  }
}


function set_log_level(value) {
  lib.set_log_level(parseInt(value));
  if (playerNode) {
    playerNode.port.postMessage({
      type: "log_params",
      log_level: lib.log_level
    });
  }
}
