import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';
import {LOG_LEVELS} from './lib.js';
import {query_server_clock, samples_to_server} from './net.js';

// Work around some issues related to caching and error reporting
//   by forcing this to load up top, before we try to 'addModule' it.
import './audio-worklet.js';

const session_id = Math.floor(Math.random() * 2**32).toString(16);
lib.set_logging_session_id(session_id);
lib.set_logging_context_id("main");

var log_level_select = document.getElementById('logLevel');

LOG_LEVELS.forEach((level) => {
  var el = document.createElement("option");
  el.value = level[0];
  el.text = level[1];
  if (lib.log_level == level[0]) {
    el.selected = true;
  }
  log_level_select.appendChild(el);
});

// We fall back exponentially until we find a good size, but we need a
// place to start that should be reasonably fair.
const INITIAL_MS_PER_BATCH = 600; // XXX 180;  // XXX: probably make sure this is a multiple of our opus frame size (60ms), but it should in theory work without
// If we have fallen back so much that we are now taking this long,
// then give up and let the user know things are broken.
const MAX_MS_PER_BATCH = 900;

// this must be 2.5, 5, 10, 20, 40, or 60.
const OPUS_FRAME_MS = 60;

lib.log(LOG_INFO, "Starting up");

const userid = Math.round(Math.random()*100000000000)

function set_error(msg) {
  window.errorBox.innerText = msg;
  window.errorBox.style.display = msg ? "block" : "none";
}

function clear_error() {
  set_error("");
}

function close_stream(stream) {
  stream.getTracks().forEach((track) => track.stop());
}

async function force_permission_prompt() {
  // In order to enumerate devices, we must first force a permission prompt by opening a device and then closing it again.
  // See: https://stackoverflow.com/questions/60297972/navigator-mediadevices-enumeratedevices-returns-empty-labels
  var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  close_stream(stream);
}

async function wait_for_mic_permissions() {
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

function receiveChatMessage(username, message) {
  const msg = document.createElement("div");
  const name_element = document.createElement("span");
  name_element.className = "chatName";
  name_element.innerText = username;
  const msg_body_element = document.createElement("span");
  msg_body_element.innerText = ": " + message;
  msg.appendChild(name_element);
  msg.appendChild(msg_body_element);
  window.chatDisplay.appendChild(msg);
  window.chatDisplay.scrollTop = window.chatDisplay.scrollHeight;
}

let chatsToSend = [];
function sendChatMessage() {
  if (!window.chatEntry.value) return;
  receiveChatMessage(window.userName.value, window.chatEntry.value);
  chatsToSend.push(window.chatEntry.value);
  window.chatEntry.value = "";
}

window.chatEntry.addEventListener("change", sendChatMessage);
window.chatPost.addEventListener("click", sendChatMessage);

let requestedLeadPosition = false;
function takeLeadPosition() {
  requestedLeadPosition = true;
}

window.takeLead.addEventListener("click", takeLeadPosition);

function persist(textFieldId) {
  const textField = document.getElementById(textFieldId);
  const prevVal = localStorage.getItem(textFieldId);
  if (prevVal !== null) {
    textField.value = prevVal;
  }

  textField.addEventListener("change", () => {
    localStorage.setItem(textFieldId, textField.value);
  });
}

function persist_checkbox(checkboxId) {
  const checkbox = document.getElementById(checkboxId);
  const prevVal = localStorage.getItem(checkboxId);
  if (prevVal !== null) {
    checkbox.checked = prevVal;
  }

  checkbox.addEventListener("change", () => {
    localStorage.setItem(checkboxId, checkbox.checked);
  });
}

persist("userName");
persist("audioOffset");
persist_checkbox("disableLatencyMeasurement");

function setMainAppVisibility() {
  if (window.userName.value) {
    window.mainApp.style.display = "block";
  }
}

setMainAppVisibility();
window.userName.addEventListener("change", setMainAppVisibility);

var in_select = document.getElementById('inSelect');
var out_select = document.getElementById('outSelect');
var click_bpm = document.getElementById('clickBPM');

in_select.addEventListener("change", reset_if_running);
out_select.addEventListener("change", reset_if_running);

async function enumerate_devices() {
  navigator.mediaDevices.enumerateDevices().then((devices) => {
    // Clear existing entries
    in_select.options.length = 0;
    out_select.options.length = 0;

    devices.forEach((info) => {
      var el = document.createElement("option");
      el.value = info.deviceId;
      if (info.kind === 'audioinput') {
        el.text = info.label || 'Unknown Input';
        in_select.appendChild(el);
      } else if (info.kind === 'audiooutput') {
        el.text = info.label || 'Unknown Output';
        out_select.appendChild(el);
      }
    });

    var el = document.createElement("option");
    el.text = "---";
    el.disabled = true;
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "SILENCE";
    el.text = "SILENCE";
    in_select.appendChild(el);

    /* Disabled for more public test, since it wastes a lot
       of bandwidth re-downloading a giant MP3
    el = document.createElement("option");
    el.value = "HAMILTON";
    el.text = "HAMILTON";
    in_select.appendChild(el);
    */

    el = document.createElement("option");
    el.value = "CLICKS";
    el.text = "CLICKS";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "ECHO";
    el.text = "ECHO";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "NUMERIC";
    el.text = "NUMERIC";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.text = "---";
    el.disabled = true;
    out_select.appendChild(el);

    el = document.createElement("option");
    el.value = "NOWHERE";
    el.text = "NOWHERE";
    out_select.appendChild(el);

    el = document.createElement("option");
    el.value = "NUMERIC";
    el.text = "NUMERIC (use with NUMERIC source)";
    out_select.appendChild(el);
  });
}

var audioCtx;

var start_button = document.getElementById('startButton');
var mute_button = document.getElementById('muteButton');
var click_volume_slider = document.getElementById('clickVolumeSlider');
var disable_latency_measurement_checkbox = document.getElementById('disableLatencyMeasurement');
var loopback_mode_select = document.getElementById('loopbackMode');
var server_path_text = document.getElementById('serverPath');
var audio_offset_text = document.getElementById('audioOffset');
var web_audio_output_latency_text = document.getElementById('webAudioOutputLatency');
var latency_compensation_label = document.getElementById('latencyCompensationLabel');
var latency_compensation_apply_button = document.getElementById('latencyCompensationApply');
var sample_rate_text = document.getElementById('sampleRate');
var peak_in_text = document.getElementById('peakIn');
var peak_out_text = document.getElementById('peakOut');
var hamilton_audio_span = document.getElementById('hamiltonAudioSpan');
var output_audio_span = document.getElementById('outputAudioSpan');
var client_total_time = document.getElementById('clientTotalTime');
var client_read_slippage = document.getElementById('clientReadSlippage');
var running = false;

function set_controls() {
  start_button.textContent = running ? "Stop" : "Start";

  mute_button.disabled = !running;
  loopback_mode_select.disabled = running;
  click_bpm.disabled = running;

  in_select.disabled = false;
  out_select.disabled = false;
}

async function initialize() {
  await wait_for_mic_permissions();
  await enumerate_devices();
  set_controls(running);

  if (document.location.hostname == "localhost" ||
      document.location.hostname == "www.jefftk.com") {
    // Better default
    server_path_text.value = "http://localhost:8081/"
  }

  var hash = window.location.hash;
  if (hash && hash.length > 1) {
    var audio_offset = parseInt(hash.substr(1), 10);
    if (audio_offset >= 0 && audio_offset <= 60) {
      audio_offset_text.value = audio_offset;
    }
  }
}

function debug_check_sample_rate(rate) {
  if (isNaN(parseInt(sample_rate_text.value)) /* warning text */) {
    lib.log(LOG_DEBUG, "First setting sample rate:", rate);
    sample_rate_text.value = rate;
  } else if (sample_rate_text.value == rate.toString()) {
    lib.log(LOG_DEBUG, "Sample rate is still", rate);
  } else {
    lib.log(LOG_ERROR, "SAMPLE RATE CHANGED from", sample_rate_text.value, "to", rate);
    sample_rate_text.value = "ERROR: SAMPLE RATE CHANGED from " + sample_rate_text.value + " to " + rate + "!!";
    stop();
  }
}

async function configure_input_node(audioCtx) {
  synthetic_audio_source = null;
  var deviceId = in_select.value;
  if (deviceId == "NUMERIC" ||
      deviceId == "CLICKS" ||
      deviceId == "ECHO") {
    synthetic_audio_source = deviceId;
    synthetic_click_interval = 60.0 / parseFloat(click_bpm.value);
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

function configure_output_node(audioCtx) {
  synthetic_audio_sink = false;
  var deviceId = out_select.value;
  var dest = audioCtx.createMediaStreamDestination();

  if (deviceId == "NUMERIC") {
    // Leave the device empty, but signal the worklet for special handling
    synthetic_audio_sink = true;
  } else if (deviceId == "NOWHERE") {
    // Leave the device empty
  } else {
    var audio_out = new Audio();
    audio_out.srcObject = dest.stream;
    // Android Chromedoes not have setSinkId:
    // https://bugs.chromium.org/p/chromium/issues/detail?id=648286
    if (audio_out.setSinkId) {
      audio_out.setSinkId(deviceId);
    }
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
var override_gain = 1.0;
var synthetic_audio_source;
var synthetic_audio_sink;
var synthetic_click_interval;
var sample_rate = 48000;  // Firefox may get upset if we use a weird value here? Also, we may not want to force this to a specific value?
var encoder;
var decoder;

function ms_to_samples(ms) {
  return sample_rate * ms / 1000;
}

function samples_to_ms(samples) {
  return samples * 1000 / sample_rate;
}

function ms_to_batch_size(ms) {
  return Math.round(ms_to_samples(ms) / 128);
}

function batch_size_to_ms(batch_size) {
  return Math.round(samples_to_ms(batch_size * 128));
}

// How many samples should we accumulate before sending to the server?
// In units of 128 samples.
var sample_batch_size = null;  // set by start()
var max_sample_batch_size = ms_to_batch_size(MAX_MS_PER_BATCH);

function set_estimate_latency_mode(mode) {
  playerNode.port.postMessage({
    "type": "latency_estimation_mode",
    "enabled": mode
  });
}

function click_volume_change() {
  playerNode.port.postMessage({
    "type": "click_volume_change",
    "value": click_volume_slider.value
  });
}

var muted = false;
function toggle_mute() {
  muted = !muted;
  mute_button.innerText = muted ? "Unmute" : "Mute";
  playerNode.port.postMessage({
    "type": "mute_mode",
    "enabled": muted
  });
}

async function reset_if_running() {
  if (running) {
    await start_stop();
    await start_stop();
  }
}

async function audio_offset_change() {
  if (running) {
    await reload_settings();
  }
}

async function start_stop() {
  const was_running = running;
  running = !was_running;
  set_controls();
  was_running ? stop() : start();
}

async function send_and_wait(port, msg, transfer) {
    return new Promise(function (resolve, _) {
        // XXX: I don't really trust this dynamic setting of onmessage business, but the example code does it so I'm leaving it for now... :-\
        port.onmessage = function (ev) {
            resolve(ev);
        }
        lib.log(LOG_VERYSPAM, "Posting to port", port, "msg", msg, "transfer", transfer);
        port.postMessage(msg, transfer);
    });
}

var expected_bogus_header = [
    79, 112, 117, 115, 72, 101, 97, 100, // "OpusHead"
    1, // version
    1, // channels
    0, 0, // pre-skip frames
    128, 187, 0, 0, // sample rate (48,000)
    0, 0, // output gain
    0 // channel mapping mode
];

class AudioEncoder {
    constructor(path) {
        this.worker = new Worker(path);
    }

    async worker_rpc(msg) {
        var ev = await send_and_wait(this.worker, msg);
        if (ev.data.status != 0) {
            throw ev.data;
        }
        return ev.data;
    }

    async setup(cfg) {
        var data = await this.worker_rpc(cfg);
        var packets = data.packets;
        // This opus wrapper library adds a bogus header, which we validate and then strip for our sanity.
        if (packets.length != 1 || packets[0].data.byteLength != expected_bogus_header.length) {
            throw { err: "Bad header packet", data: packets };
        }
        var bogus_header = new Uint8Array(packets[0].data);
        for (var i = 0; i < expected_bogus_header.length; i++) {
            if (bogus_header[i] != expected_bogus_header[i]) {
                throw { err: "Bad header packet", data: packets };
            }
        }
        // return nothing.
    }

    async encode(in_data) {
        var data = await this.worker_rpc(in_data);
        if (data.packets === undefined) {
            throw data;
        }
        return data.packets;
    }

    async reset() {
        return this.worker_rpc({
          reset: true
        });
    }
}

class AudioDecoder {
    constructor(path) {
        this.worker = new Worker(path);
    }

    async worker_rpc(msg, transfer) {
        var ev = await send_and_wait(this.worker, msg, transfer);
        if (ev.data.status != 0) {
            throw ev.data;
        }
        return ev.data;
    };

    async setup() {
        var bogus_header_packet = {
            data: Uint8Array.from(expected_bogus_header).buffer
        };
        return await this.worker_rpc({
            config: {},  // not used
            packets: [bogus_header_packet],
        });
    }

    async reset() {
        return this.worker_rpc({
          reset: true
        });
    }

    async decode(packet) {
        return await this.worker_rpc(packet, [packet.data]);
    }
}

async function start() {
  clear_error();

  sample_batch_size = ms_to_batch_size(INITIAL_MS_PER_BATCH);
  window.msBatchSize.value = batch_size_to_ms(sample_batch_size);

  var AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext({ sampleRate: sample_rate });
  lib.log(LOG_DEBUG, "Audio Context:", audioCtx);
  debug_check_sample_rate(audioCtx.sampleRate);

  var micNode = await configure_input_node(audioCtx);
  var spkrNode = configure_output_node(audioCtx);

  await audioCtx.audioWorklet.addModule('audio-worklet.js');
  playerNode = new AudioWorkletNode(audioCtx, 'player');
  // Stop if there is an exception inside the worklet.
  playerNode.addEventListener("processorerror", stop);
  playerNode.port.postMessage({
    type: "log_params",
    session_id: session_id,
    log_level: lib.log_level
  });

  encoder = new AudioEncoder('opusjs/encoder.js');
  decoder = new AudioDecoder('opusjs/decoder.js')

  var enc_cfg = {
      sampling_rate: audioCtx.sampleRate,
      num_of_channels: 1,
      params: {
          application: 2049,  // AUDIO
          sampling_rate: 48000,
          frame_duration: OPUS_FRAME_MS,
      }
  };
  lib.log(LOG_DEBUG, "Setting up opus encoder and decoder. Encoder params:", enc_cfg);
  await encoder.setup(enc_cfg);
  var info = await decoder.setup();
  lib.log(LOG_DEBUG, "Opus decoder returned parameters:", info);
  // The encoder stuff absolutely has to finish getting initialized before we start getting messages for it, or shit will get regrettably real. (It is designed in a non-threadsafe way, which is remarkable since javascript has no threads.)

  playerNode.port.onmessage = handle_message;
  micNode.connect(playerNode);

  // This may not work in Firefox.
  playerNode.connect(spkrNode);

  // To use the default output device, which should be supported on all browsers, instead use:
  // playerNode.connect(audioCtx.destination);

  await reload_settings();

  window.calibration.style.display = "block";

  if (!disable_latency_measurement_checkbox.checked) {
    set_estimate_latency_mode(true);
  } else {
    window.est40to60.innerText = "0ms";
    window.estLatency.innerText = "0ms";
    window.msClietLatency.value = "0ms";
    send_local_latency();
    window.initialInstructions.style.display = "none";
    window.calibration.style.display = "none";
    window.runningInstructions.style.display = "block";
  }
}

async function reload_settings() {
  audio_offset = parseInt(audio_offset_text.value) * sample_rate;

  read_clock = null;
  mic_buf = [];
  mic_buf_clock = null;
  override_gain = 1.0;

  loopback_mode = loopback_mode_select.value;
  server_path = server_path_text.value;

  // Support relative paths
  var target_url = new URL(server_path, document.location);
  server_clock = await query_server_clock(loopback_mode, target_url, sample_rate);
  read_clock = server_clock - audio_offset;

  // Send this before we set audio params, which declares us to be ready for audio
  click_volume_change();
  var audio_params = {
    type: "audio_params",
    synthetic_source: synthetic_audio_source,
    click_interval: synthetic_click_interval,
    synthetic_sink: synthetic_audio_sink,
    loopback_mode: loopback_mode
  }
  playerNode.port.postMessage(audio_params);
}

function send_local_latency() {
  var local_latency_ms = parseFloat(estLatency.innerText);

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

// Pack multiple subpackets into an encoded blob to send the server
// - Packet count: 1 byte
// - Each packet:
//   - Packet length (bytes): 2 bytes, big endian
//   - Packet data
function pack_multi(packets) {
  lib.log(LOG_SPAM, "Encoding packet for transmission to server! input:", packets);
  var encoded_length = 1; // space for packet count
  packets.forEach((p) => {
    encoded_length += 2; // space for packet length
    encoded_length += p.length;
  });

  var outdata = new Uint8Array(encoded_length);
  outdata[0] = packets.length;
  var outdata_idx = 1;
  packets.forEach((p) => {
    if (p.constructor !== Uint8Array) {
      throw "must be Uint8Array";
    }
    var len = p.length;  // will never exceed 2**16
    var len_b = [len >> 8, len % 256];
    outdata[outdata_idx] = len_b[0];
    outdata[outdata_idx + 1] = len_b[1];
    outdata.set(p, outdata_idx + 2);
    outdata_idx += len + 2;
  });
  lib.log(LOG_SPAM, "Encoded packet for transmission to server! Final outdata_idx:", outdata_idx, ", encoded_length:", encoded_length, ", num. subpackets:", packets.length, ", output:", outdata);
  return outdata;
}

function unpack_multi(data) {
  lib.log(LOG_SPAM, "Decoding packet from server, data:", data);
  if (data.constructor !== Uint8Array) {
    throw "must be Uint8Array";
  }
  var packet_count = data[0];
  var data_idx = 1;
  var result = [];
  for (var i = 0; i < packet_count; ++i) {
    var len = (data[data_idx] << 8) + data[data_idx + 1];
    lib.log(LOG_VERYSPAM, "Decoding subpacket", i, "at offset", data_idx, "with len", len);
    var packet = new Uint8Array(len);
    data_idx += 2;
    packet.set(data.slice(data_idx, data_idx + len));
    data_idx += len;
    result.push(packet);
  }
  lib.log(LOG_SPAM, "Decoded packet from server! Final data_idx:", data_idx, ", total length:", data.length, ", num. subpackets:", packet_count, "final output:", result);
  return result;
}

function concat_typed_arrays(arrays, _constructor) {
  if (arrays.length == 0 && _constructor === undefined) {
    throw "cannot concat zero arrays without constructor provided";
  }
  var constructor = _constructor || arrays[0].constructor;
  var total_len = 0;
  arrays.forEach((a) => {
    if (a.constructor !== constructor) {
      throw "must concat arrays of same type";
    }
    total_len += a.length;
  });
  var result = new constructor(total_len);
  var result_idx = 0;
  arrays.forEach((a) => {
    result.set(a, result_idx);
    result_idx += a.length;
  });
  return result;
}

async function handle_message(event) {
  var msg = event.data;
  lib.log(LOG_VERYSPAM, "onmessage in main thread received ", msg);

  if (!running) {
    lib.log(LOG_WARNING, "Got message when done running");
    return;
  }

  if (msg.type == "exception") {
    lib.log(LOG_ERROR, "Exception thrown in audioworklet:", msg.exception);
    reload_settings();
    return;
  } else if (msg.type == "no_mic_input") {
    window.noAudioInputInstructions.style.display = "block";
    return;
  } else if (msg.type == "latency_estimate") {
    window.estSamples.innerText = msg.samples;

    window.noAudioInputInstructions.style.display = "none";

    if (msg.p50 !== undefined) {
      const latency_range = msg.p60 - msg.p40;
      window.est40to60.innerText = Math.round(latency_range) + "ms";
      window.estLatency.innerText = Math.round(msg.p50) + "ms";
      window.msClietLatency.value = Math.round(msg.p50) + "ms";

      if (latency_range < msg.samples / 2) {
        // Stop trying to estimate latency once were close enough. The
        // more claps the person has done, the more we lower our
        // standards for close enough, figuring that they're having
        // trouble clapping on the beat.
        send_local_latency();
        window.initialInstructions.style.display = "none";
        window.calibration.style.display = "none";
        window.runningInstructions.style.display = "block";
        set_estimate_latency_mode(false);
      }
    }
    return;
  } else if (msg.type != "samples_out") {
    lib.log(LOG_ERROR, "Got message of unknown type:", msg);
    stop();
    return;
  }

  var mic_samples = msg.samples;
  var send_write_clock = msg.clock;
  mic_buf.push(mic_samples);
  lib.log(LOG_VERYSPAM, "added", mic_samples.length, "samples, for total of", mic_buf.length * 128, "with threshold", sample_batch_size);

  /*
  // Update the peak meter
  var peak_in = parseFloat(peak_in_text.value);
  if (isNaN(peak_in)) {
    peak_in = 0.0;
  }
  for (var i = 0; i < mic_samples.length; i++) {
    if (Math.abs(mic_samples[i]) > peak_in) {
      peak_in = Math.abs(mic_samples[i]);
    }
  }
  // XXX: touching the DOM
  peak_in_text.value = peak_in;
  */

  if (mic_buf.length >= sample_batch_size) {
    var samples = concat_typed_arrays(mic_buf, Float32Array);
    lib.log(LOG_SPAM, "Encoding samples:", mic_buf);
    mic_buf = [];
    // XXX: terrible.
    // await encoder.reset();
    var encoded_samples = await encoder.encode({ samples });
    var enc_buf = [];
    lib.log(LOG_SPAM, "Got encoded packets:", encoded_samples);
    encoded_samples.forEach((packet) => {
      enc_buf.push(new Uint8Array(packet.data));
    });
    var outdata = pack_multi(enc_buf);

    // Clocks are at the _end_ of intervals; the longer we've been
    //   accumulating data, the more we have to read. (Trust me.)
    var orig_read_clock = read_clock;
    var packet_contents_length = enc_buf.length * ms_to_samples(OPUS_FRAME_MS)
    // These SHOULD be equal IF we have managed to make our sample_back_size correctly a multiple of our OPUS_FRAME_MS. Otherwise they will be different, but hopefully still correct...
    lib.log(LOG_SPAM, "Calculated packet contents length:", packet_contents_length, "; amount of stuff fed to encoder:", samples.length);
    read_clock += packet_contents_length;

    if (loopback_mode == "main") {
      var packets = unpack_multi(outdata);
      // XXX: terrible.
      //lib.log(LOG_VERYSPAM, "resetting decoder...");
      //var reset_result = await decoder.reset();
      //lib.log(LOG_SPAM, "decoder reset:", reset_result);

      var decoded_packets = [];
      for (var i = 0; i < packets.length; ++i) {
        var p_samples = await decoder.decode({
          data: packets[i].buffer
        });
        lib.log(LOG_VERYSPAM, "Decoded samples:", p_samples);
        decoded_packets.push(new Float32Array(p_samples.samples));
      }
      lib.log(LOG_VERYSPAM, "Decoded packets looped back:", decoded_packets);
      var play_samples = concat_typed_arrays(decoded_packets, Float32Array);
      lib.log(LOG_SPAM, "Playing looped-back samples:", play_samples);
      samples_to_worklet(play_samples, read_clock);
      return;
    } else {
      var target_url = new URL(server_path, document.location);
      var send_metadata = {
        read_clock: read_clock,  // ???
        write_clock: send_write_clock,
        username: window.userName.value,
        userid,
        chatsToSend,
        requestedLeadPosition,
        loopback_mode
      };

      var response = await samples_to_server(outdata, target_url, send_metadata);
      var result = new Uint8Array(response.data);
      var packets = unpack_multi(result);
      var metadata = response.metadata;

      /*
      // Update the peak meter
      for (var i = 0; i < result.length; i++) {
        if (Math.abs(play_samples[i]) > peak_out) {
          peak_out = Math.abs(play_samples[i]);
        }
      }
      */

      // XXX: terrible.
      //var reset_result = await decoder.reset();
      //lib.log(LOG_DEBUG, "decoder reset:", reset_result);

      var decoded_packets = [];
      for (var i = 0; i < packets.length; ++i) {
        var samples = await decoder.decode({
          data: packets[i].buffer
        });
        decoded_packets.push(new Float32Array(samples.samples));
      }
      var play_samples = concat_typed_arrays(decoded_packets, Float32Array);
      samples_to_worklet(play_samples, metadata["client_read_clock"]);

      var queue_size = metadata["queue_size"];
      var user_summary = metadata["user_summary"];
      var chats = metadata["chats"];
      var delay_samples = metadata["delay_samples"];

      // Defer touching the DOM, just to be safe.
      requestAnimationFrame(() => {
        if (delay_samples) {
          delay_samples = parseInt(delay_samples, 10);
          if (delay_samples > 0) {
            audio_offset_text.value = Math.round(delay_samples / sample_rate);
            audio_offset_change();
          }
        }

        update_active_users(user_summary);

        chats.forEach((msg) => receiveChatMessage(msg[0], msg[1]));

        peak_out_text.value = peak_out;

        client_total_time.value = (metadata["client_read_clock"] - metadata["client_write_clock"] + play_samples.length) / sample_rate;
        client_read_slippage.value = (metadata["server_clock"] - metadata["client_read_clock"] - audio_offset) / sample_rate;
      });
    }
  }
}

var peak_out = parseFloat(peak_out_text.value);
if (isNaN(peak_out)) {
  peak_out = 0.0;
}

function update_active_users(user_summary) {
  // Delete previous users.
  while (window.activeUsers.firstChild) {
    window.activeUsers.removeChild(window.activeUsers.lastChild);
  }

  for (var i = 0; i < user_summary.length; i++) {
    const offset_s = Math.round(user_summary[i][0] / sample_rate);
    const name = user_summary[i][1];
    const tr = document.createElement('tr');

    const td1 = document.createElement('td');
    td1.textContent = offset_s;
    tr.appendChild(td1);

    const td2 = document.createElement('td');
    td2.textContent = name;
    tr.appendChild(td2);

    window.activeUsers.appendChild(tr);
  }
}

function try_increase_batch_size_and_reload() {
  if (sample_batch_size < max_sample_batch_size) {
    // Try increasing the batch size and restarting.
    sample_batch_size *= 1.3;  // XXX: do we care that this may not be integral??
    window.msBatchSize.value = batch_size_to_ms(sample_batch_size);
    reload_settings();
    return;
  } else {
    set_error("Failed to communicate with the server at a reasonable latency");
    stop();
  }
}

async function stop() {
  window.initialInstructions.style.display = "block";
  window.calibration.style.display = "none";
  window.runningInstructions.style.display = "none";
  window.noAudioInputInstructions.style.display = "none";

  window.estSamples.innerText = "...";
  window.est40to60.innerText = "...";
  window.estLatency.innerText = "...";

  if (muted) {
    toggle_mute();
  }

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
}

start_button.addEventListener("click", start_stop);
mute_button.addEventListener("click", toggle_mute);
click_volume_slider.addEventListener("change", click_volume_change);
audio_offset_text.addEventListener("change", audio_offset_change);

log_level_select.addEventListener("change", () => {
  lib.set_log_level(parseInt(log_level_select.value));
  if (playerNode) {
    playerNode.port.postMessage({
      type: "log_params",
      log_level: lib.log_level
    });
  }
});

var coll = document.getElementsByClassName("collapse");
for (var i = 0; i < coll.length; i++) {
  coll[i].addEventListener("click", function() {
    //this.classList.toggle("active");
    var otherlabel = this.dataset.otherlabel;
    this.dataset.otherlabel = this.textContent;
    this.textContent = otherlabel;
    var content = this.nextElementSibling;
    if (content.style.display === "block") {
      content.style.display = "none";
    } else {
      content.style.display = "block";
    }
  });
}

initialize();
