import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';
import {LOG_LEVELS} from './lib.js';
import {check} from './lib.js';

import {ServerConnection, FakeServerConnection} from './net.js';
import {AudioChunk, CompressedAudioChunk, PlaceholderChunk, concat_chunks, ClockInterval, ClientClockReference, ServerClockReference} from './audiochunk.js';

// Work around some issues related to caching and error reporting
//   by forcing this to load up top, before we try to 'addModule' it.
import './audio-worklet.js';

const APP_TUTORIAL = "tutorial";
const APP_INITIALIZING = "initializing";
const APP_STOPPED = "stopped";
const APP_STARTING = "starting";
const APP_RUNNING = "running";
const APP_CALIBRATING_LATENCY = "calibrating_latency";
const APP_CALIBRATING_VOLUME = "calibrating_volume";
const APP_STOPPING = "stopping";
const APP_RESTARTING = "restarting";

addEventListener('error', (event) => {
  if (document.getElementById('crash').style.display) {
    return;
  }
  event.preventDefault();
  document.getElementById('crash').style.display = 'block';
  const {name, message, stack, unpreventable} = event.error ?? {};
  if (unpreventable) {
    document.getElementById('crashMessage').textContent = message;
  } else {
    document.getElementById('crashBug').style.display = 'block';
    document.getElementById('crashTrace').textContent = `${name}: ${message}\n${stack}`;
  }
});
addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  throw event.reason;
});

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

const myUserid = Math.round(Math.random()*100000000000)

function close_stream(stream) {
  stream.getTracks().forEach((track) => track.stop());
}

function prettyTime(ms) {
  if (ms < 1000) {
    return "0s";
  }
  const sec = Math.round(ms / 1000);
  if (sec < 60) {
    return sec + "s";
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return min + "m";
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return hr + "h";
  }
  const d = Math.round(hr / 24);
  return d + "d";
}

function update_calendar() {
  fetch('https://www.googleapis.com/calendar/v3/calendars/gsc268k1lu78lbvfbhphdr0cs4@group.calendar.google.com/events?key=AIzaSyCDAG5mJmnmi9EaR5SujP70x8kLKOau4Is')
    .then(response => response.json())
    .then(data => {
      let currentEvent = null;
      let upcomingEvent = null;
      const now = Date.now();

      if ( ! data.items ) {
        // TODO: Save the error code?
        lib.log(LOG_WARNING, "No data from Google Calendar");
        return;
      }

      data.items.forEach(item => {
        // If an event is currently happening we want to check whether
        // that's what people are here for. Similarly, if an event is
        // going to be starting soon we should give people a heads up.
        if (item.status === "confirmed") {
          const msUntilStart = Date.parse(item.start.dateTime) - now;
          const msUntilEnd = Date.parse(item.end.dateTime) - now;
          const organizer = item.organizer.displayName || item.organizer.email;
          console.log(item.summary + " [" + msUntilStart + ":" + msUntilEnd + "]");
          if (msUntilStart <= 0 && msUntilEnd > 0) {
            currentEvent = {
              summary: item.summary,
              remainingMs: msUntilEnd,
              organizer: organizer,
            };
          } else if (msUntilStart > 0) {
            if (!upcomingEvent || upcomingEvent.futureMs > msUntilStart) {
              upcomingEvent = {
                summary: item.summary,
                futureMs: msUntilStart,
                organizer: organizer,
              }
            }
          }
        }
      });

      if (currentEvent) {
        window.currentEvent.innerText = "Current Event: " + currentEvent.summary;
        window.eventWelcome.innerText =
          "Right now " + currentEvent.organizer + " is running \"" +
          currentEvent.summary + "\".  If you were invited to attend, great! " +
          "Otherwise, please come back later.";
      } else if (upcomingEvent) {
        window.currentEvent.innerText = "Next Event: \"" + upcomingEvent.summary +
          "\" in " + prettyTime(upcomingEvent.futureMs);
        if (upcomingEvent.futureMs < 60*60*1000) {
          window.eventWelcome.innerText =
            "There are no events right now, but in " +
            prettyTime(upcomingEvent.futureMs) + " " +
            upcomingEvent.organizer + " is running \"" +
            upcomingEvent.summary + "\".";
        }
      } else {
        window.currentEvent.innerText = "No Events Scheduled";
      }
    });
}
update_calendar();

async function force_permission_prompt() {
  // In order to enumerate devices, we must first force a permission prompt by opening a device and then closing it again.
  // See: https://stackoverflow.com/questions/60297972/navigator-mediadevices-enumeratedevices-returns-empty-labels
  var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  close_stream(stream);
}

async function wait_for_mic_permissions() {
  var perm_status = await navigator.permissions.query({name: "microphone"}).catch(() => null);
  if (!perm_status) {
    force_permission_prompt();
    return;
  }
  if (perm_status.state == "granted" || perm_status.state == "denied") {
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

window.chatForm.addEventListener("submit", (e) => { sendChatMessage(); e.preventDefault(); });

let leadButtonState = "take-lead";
let requestedLeadPosition = false;
let markStartSinging = false;
let markStopSinging = false;
function takeLeadClick() {
  if (leadButtonState == "take-lead") {
    requestedLeadPosition = true;
    // Action doesn't take effect until server confirms.
  } else if (leadButtonState == "start-singing") {
    window.takeLead.textContent = "Stop Singing";
    markStartSinging = true;
    leadButtonState = "stop-singing";
  } else if (leadButtonState == "stop-singing") {
    window.takeLead.textContent = "Lead a Song";
    markStopSinging = true;
    leadButtonState = "take-lead";
    window.jumpToEnd.disabled = false;
  } else {
    throw new Error("unknown state " + leadButtonState);
  }
}

window.takeLead.addEventListener("click", takeLeadClick);

window.jumpToEnd.addEventListener("click", () => {
  audio_offset_text.value = 115;
  audio_offset_change();
});

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
  checkbox.checked = (prevVal === "true");

  checkbox.addEventListener("change", () => {
    localStorage.setItem(checkboxId, checkbox.checked);
  });
}

persist("userName");
persist_checkbox("disableTutorial");
persist_checkbox("disableLatencyMeasurement");
// Persisting select boxes is harder, so we do it manually for inSelect.

function setMainAppVisibility() {
  if (window.userName.value && app_state != APP_TUTORIAL) {
    window.mainApp.style.display = "block";
  }
}

setMainAppVisibility();
window.userName.addEventListener("change", setMainAppVisibility);

var in_select = document.getElementById('inSelect');
var click_bpm = document.getElementById('clickBPM');

in_select.addEventListener("change", in_select_change);

async function enumerate_devices() {
  navigator.mediaDevices.enumerateDevices().then((devices) => {
    // Clear existing entries
    in_select.options.length = 0;

    devices.forEach((info) => {
      var el = document.createElement("option");
      el.value = info.deviceId;
      if (info.kind === 'audioinput') {
        el.text = info.label || 'Unknown Input';
        if (info.deviceId && localStorage.getItem("inSelect") === info.deviceId) {
          el.selected = true;
        }
        in_select.appendChild(el);
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

    el = document.createElement("option");
    el.value = "CLICKS";
    el.text = "CLICKS";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "ECHO";
    el.text = "ECHO";
    in_select.appendChild(el);
  });
}

var audioCtx;

var start_button = document.getElementById('startButton');
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
var client_total_time = document.getElementById('clientTotalTime');
var client_read_slippage = document.getElementById('clientReadSlippage');

export var start_hooks = [];
export var stop_hooks = [];
export var event_hooks = [];
var event_data = [];
var alarms = {};
var alarms_fired = {};
var cur_clock_cbs = [];

export function declare_event(evid, offset) {
  cur_clock_cbs.push( (clock)=>{ event_data.push({evid,clock:clock-(offset||0)*audioCtx.sampleRate}); } );
  playerNode.port.postMessage({
    type: "request_cur_clock"
  });
}

function allStatesExcept(states) {
  return [...ALL_STATES].filter(state => !states.includes(state));
}


function setVisibleIn(element, enabled_states, visible='block') {
  element.style.display = enabled_states.includes(app_state) ? visible : 'none';
}

function setEnabledIn(element, enabled_states) {
  element.disabled = !enabled_states.includes(app_state);
}


function set_controls() {
  setVisibleIn(window.micToggleButton, [APP_RUNNING]);
  setVisibleIn(window.speakerToggleButton, [APP_RUNNING]);

  setEnabledIn(loopback_mode_select, [APP_STOPPED])
  setEnabledIn(click_bpm, allStatesExcept([APP_STOPPED]));

  setEnabledIn(in_select, allStatesExcept([APP_INITIALIZING, APP_RESTARTING]));
  setEnabledIn(start_button, allStatesExcept([APP_INITIALIZING, APP_RESTARTING]));

  setVisibleIn(start_button, allStatesExcept([APP_TUTORIAL]));

  setVisibleIn(window.tutorial, [APP_TUTORIAL]);

  start_button.textContent = ". . .";
  if (app_state == APP_STOPPED) {
    start_button.textContent = "Start";
  } else if (app_state != APP_INITIALIZING) {
    start_button.textContent = "Stop";
  }

  setVisibleIn(window.pleaseBeKind, allStatesExcept(ACTIVE_STATES));
  setVisibleIn(window.inputSelector,
               allStatesExcept(ACTIVE_STATES.concat([APP_TUTORIAL])));
  setVisibleIn(window.nameSelector,
               allStatesExcept(ACTIVE_STATES.concat([APP_TUTORIAL])));
  setEnabledIn(window.songControls, allStatesExcept([APP_RESTARTING]));
  setEnabledIn(window.chatPost, allStatesExcept([APP_RESTARTING]));
  setEnabledIn(audio_offset_text, allStatesExcept([APP_RESTARTING]));

  setVisibleIn(window.micToggleButton, [APP_RUNNING, APP_RESTARTING], "inline-block");
  setVisibleIn(window.speakerToggleButton, [APP_RUNNING, APP_RESTARTING], "inline-block");

  setVisibleIn(window.initialInstructions, [
    APP_INITIALIZING, APP_STOPPED, APP_CALIBRATING_LATENCY, APP_STOPPING]);
  setVisibleIn(window.latencyCalibrationInstructions, [
    APP_INITIALIZING, APP_STOPPED, APP_CALIBRATING_LATENCY, APP_STOPPING]);

  setVisibleIn(window.calibration, [APP_CALIBRATING_LATENCY]);

  setVisibleIn(window.volumeCalibration, [APP_CALIBRATING_VOLUME]);
  setEnabledIn(window.startVolumeCalibration, [APP_CALIBRATING_VOLUME]);

  setVisibleIn(window.runningInstructions, [APP_RUNNING, APP_RESTARTING]);

  setVisibleIn(window.noAudioInputInstructions, []);

  window.estSamples.innerText = "...";
  window.est40to60.innerText = "...";
  window.estLatency.innerText = "...";

  window.backingTrack.display = "none";

  setMainAppVisibility();
}

function in_select_change() {
  window.localStorage.setItem("inSelect", in_select.value);
  reset_if_running();
}

async function configure_input_node(audioCtx) {
  synthetic_audio_source = null;
  var deviceId = in_select.value;
  if (deviceId == "CLICKS" ||
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
  }

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,  // Unfortunately this tends to kill long held notes, which is bad; but people's levels being wildly different is also bad. Manage it ourselves?
      deviceId: { exact: deviceId }
    }
  });

  return new MediaStreamAudioSourceNode(audioCtx, { mediaStream: micStream });
}

function configure_output_node(audioCtx) {
  // Default output device.
  return audioCtx.destination;
}

// NOTE NOTE NOTE:
// * All `clock` variables are measured in samples.
// * All `clock` variables represent the END of an interval, NOT the
//   beginning. It's arbitrary which one to use, but you have to be
//   consistent, and trust me that it's slightly nicer this way.
var server_connection;
var loopback_mode;

var playerNode;
var micStream;
var synthetic_audio_source;
var synthetic_click_interval;

var mic_buf;
var encoder;
var decoder;
var encoding_latency_ms;

var app_state = APP_TUTORIAL;
if (window.disableTutorial.checked) {
   app_state = APP_INITIALIZING;
}

var app_initialized = false;

const ALL_STATES = [
  APP_TUTORIAL, APP_INITIALIZING, APP_STOPPED, APP_STARTING, APP_RUNNING,
  APP_CALIBRATING_LATENCY, APP_CALIBRATING_VOLUME, APP_STOPPING,
  APP_RESTARTING];

const ACTIVE_STATES = [
  APP_RUNNING, APP_CALIBRATING_LATENCY, APP_CALIBRATING_VOLUME, APP_RESTARTING
];

function switch_app_state(newstate) {
  lib.log(LOG_INFO, "Changing app state from", app_state, "to", newstate, ".");
  app_state = newstate;
  set_controls();
}
set_controls();

// Used to coordinate changes to various parameters while messages may still be in flight.
var epoch = 0;

function ms_to_samples(ms) {
  return audioCtx.sampleRate * ms / 1000;
}

function samples_to_ms(samples) {
  return samples * 1000 / audioCtx.sampleRate;
}

function ms_to_batch_size(ms) {
  return Math.round(ms_to_samples(ms) / 128);
}

function batch_size_to_ms(batch_size) {
  return Math.round(samples_to_ms(batch_size * 128));
}

// How many samples should we accumulate before sending to the server?
// In units of 128 samples. Set in start() once we know the sample rate.
var sample_batch_size;

function set_estimate_latency_mode(mode) {
  playerNode.port.postMessage({
    "type": "latency_estimation_mode",
    "enabled": mode
  });
}

function set_estimate_volume_mode(mode) {
  playerNode.port.postMessage({
    "type": "volume_estimation_mode",
    "enabled": mode
  });
}

function click_volume_change() {
  playerNode.port.postMessage({
    "type": "click_volume_change",
    "value": click_volume_slider.value
  });
}

var micPaused = false;
function toggle_mic() {
  micPaused = !micPaused;
  window.micToggleImg.alt = micPaused ? "turn mic on" : "turn mic off";
  window.micToggleImg.src =
    "images/mic-" + (micPaused ? "off" : "on") + ".png";
  playerNode.port.postMessage({
    "type": "mic_pause_mode",
    "enabled": micPaused
  });
}

var speakerPaused = false;
function toggle_speaker() {
  speakerPaused = !speakerPaused;
  window.speakerToggleImg.alt = speakerPaused ? "turn speaker on" : "turn speaker off";
  window.speakerToggleImg.src =
    "images/speaker-" + (speakerPaused ? "off" : "on") + ".png";
  playerNode.port.postMessage({
    "type": "speaker_pause_mode",
    "enabled": speakerPaused
  });
}

async function reset_if_running() {
  if (app_state == APP_RUNNING) {
    await stop();
    await start();
  }
}

async function audio_offset_change() {
  const new_value = parseInt(audio_offset_text.value);
  // TODO: stop using magic numbers about the buffer size
  if (isNaN(new_value) || new_value < 1 || new_value > 115) {
    audio_offset_text.value = 115;
  }

  if (app_state == APP_RUNNING) {
    await restart();
  }
}

async function start_stop() {
  if (app_state == APP_RUNNING) {
    await stop();
  } else if (app_state == APP_STOPPED) {
    await start();
  } else {
    lib.log(LOG_WARNING, "Pressed start/stop button while not stopped or running; stopping by default.");
    await stop();
  }
}

class AudioEncoder {
  constructor(path) {
    this.worker = new Worker(path);
    this.client_clock = null;
    this.server_clock = null;
    this.next_request_id = 0;
    this.request_queue = [];
    this.worker.onmessage = this.handle_message.bind(this);
  }

  handle_message(ev) {
    if (ev.data?.type === 'exception') {
      throw ev.data.exception;
    }
    var queue_entry = this.request_queue.shift();
    var response_id = ev.data.request_id;
    check(queue_entry[0] == response_id, "Responses out of order", queue_entry, ev.data);
    if (ev.data.status != 0) {
      throw new Error("AudioEncoder RPC failed: " + JSON.stringify(ev.data));
    }
    queue_entry[1](ev.data);
  }

  async worker_rpc(msg, transfer) {
    var request_id = this.next_request_id;
    var _this = this;
    this.next_request_id += 1;
    return new Promise(function (resolve, _) {
      _this.request_queue.push([request_id, resolve]);
      lib.log(LOG_VERYSPAM, "Posting to port", _this.worker, "msg", msg, "transfer", transfer);
      _this.worker.postMessage({ request_id, ...msg }, transfer);
    });
  }

  // MUST be called before ANY other RPCs
  async setup(cfg) {
    this.client_clock_reference = new ClientClockReference({
      sample_rate: cfg.sampling_rate
    });
    this.server_clock_reference = new ServerClockReference({
      sample_rate: cfg.codec_sampling_rate || 48000  // keep in sync with encoder.js
    })
    this.queued_chunk = null;
    return this.worker_rpc(cfg);
  }

  async encode_chunk(chunk) {
    chunk.check_clock_reference(this.client_clock_reference);
    check(this.client_clock === null || !(chunk instanceof PlaceholderChunk), "Can't send placeholder chunks once clock has started");

    if (this.queued_chunk !== null) {
      chunk = concat_chunks([this.queued_chunk, chunk]);
      this.queued_chunk = null;
    }

    if (chunk instanceof PlaceholderChunk) {
      var result_length = Math.round(chunk.length / this.client_clock_reference.sample_rate * this.server_clock_reference.sample_rate);
      var opus_samples = OPUS_FRAME_MS * this.server_clock_reference.sample_rate / 1000;
      var send_length = Math.round(result_length / opus_samples) * opus_samples;

      // This is ugly.
      var leftover_length = Math.round((result_length - send_length) * this.client_clock_reference.sample_rate / this.server_clock_reference.sample_rate);
      if (leftover_length > 0) {
        this.queued_chunk = new PlaceholderChunk({
          reference: this.client_clock_reference,
          length: leftover_length
        });
      }

      return new PlaceholderChunk({
        reference: this.server_clock_reference,
        length: send_length
      });
    }

    if (this.client_clock === null) {
      this.client_clock = chunk.start;

      // This isn't ideal, but the notion is that we only do this once, so there is no accumulating rounding error.
      this.server_clock = Math.round(this.client_clock
        / this.client_clock_reference.sample_rate
        * this.server_clock_reference.sample_rate);
    }
    if (this.client_clock != chunk.start) {
      throw new Error("Cannot encode non-contiguous chunks!");
    }
    this.client_clock = chunk.end;

    var { packets, samples_encoded, buffered_samples } = await this.encode({
      samples: chunk.data
    });

    this.server_clock += samples_encoded
    // At this point server_clock is behind chunk.end by buffered_samples, the amount of stuff remaining buffered inside the encoder worker
    var server_clock_adjusted = this.server_clock + buffered_samples;
    var client_clock_hypothetical = server_clock_adjusted / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate;

    // XXX: we'll see about this? I believe as long as the resampler is buffering correctly, this should never exceed 1, and should not be subject to accumulated roundoff error.
    // NOTE: We have to use chunk.end here, and not this.client_clock, which may have moved on while we were waiting for the decoder.
    lib.log(LOG_SPAM, "net sample rate clock error:", chunk.end - client_clock_hypothetical);
    if (Math.abs(chunk.end - client_clock_hypothetical) > 5 /* arbitrary */) {
      lib.log(LOG_WARNING, "Sample rate clock slippage excessive in encoder; why is this happening?", chunk.end, client_clock_hypothetical, this.server_clock, buffered_samples, server_clock_adjusted, this.server_clock_reference.sample_rate, this.client_clock_reference.sample_rate);
      // TODO: Is this error always spurious? What should we do here, or how should we prevent it?
      // throw new Error("sample rate clock slippage excessive; what happened?");
    }

    var enc_buf = [];
    packets.forEach((packet) => {
      enc_buf.push(new Uint8Array(packet.data));
    });
    var outdata = pack_multi(enc_buf);

    var result_interval = new ClockInterval({
      reference: this.server_clock_reference,
      end: this.server_clock,
      length: samples_encoded
    });
    return new CompressedAudioChunk({
      interval: result_interval,
      data: outdata
    });
  }

  async encode(in_data) {
    var data = await this.worker_rpc(in_data);
    if (data.packets === undefined) {
      throw new Error("encode returned no packets:" + JSON.stringify(data));
    }
    return data;
  }

  // XXX: should probably drain the queue?
  async reset() {
    this.client_clock = null;
    this.server_clock = null;
    return this.worker_rpc({
      reset: true
    });
  }
}

class AudioDecoder {
  constructor(path) {
    this.worker = new Worker(path);
    this.server_clock = null;
    this.client_clock = null;
    this.next_request_id = 0;
    this.request_queue = [];
    this.worker.onmessage = this.handle_message.bind(this);
  }

  handle_message(ev) {
    if (ev.data?.type === 'exception') {
      throw ev.data.exception;
    }
    var queue_entry = this.request_queue.shift();
    var response_id = ev.data.request_id;
    check(queue_entry[0] == response_id, "Responses out of order", queue_entry, ev.data);
    if (ev.data.status != 0) {
      throw new Error("AudioDecoder RPC failed: " + JSON.stringify(ev.data));
    }
    queue_entry[1](ev.data);
  }

  async worker_rpc(msg, transfer) {
    var request_id = this.next_request_id;
    var _this = this;
    this.next_request_id += 1;
    return new Promise(function (resolve, _) {
      _this.request_queue.push([request_id, resolve]);
      lib.log(LOG_VERYSPAM, "Posting to port", _this.worker, "msg", msg, "transfer", transfer);
      _this.worker.postMessage({ request_id, ...msg }, transfer);
    });
  }

  // MUST be called before ANY other RPCs
  async setup(cfg) {
    this.client_clock_reference = new ClientClockReference({
      sample_rate: cfg.sampling_rate
    });
    this.server_clock_reference = new ServerClockReference({
      sample_rate: cfg.codec_sampling_rate || 48000  // keep in sync with decoder.js
    })
    return this.worker_rpc(cfg);
  }

  // XXX: should probably drain the queue?
  async reset() {
    this.client_clock = null;
    this.server_clock = null;
    return this.worker_rpc({
      reset: true
    });
  }

  async decode_chunk(chunk) {
    chunk.check_clock_reference(this.server_clock_reference);

    if (chunk instanceof PlaceholderChunk) {
      var result_interval = new ClockInterval({
        reference: this.client_clock_reference,
        length: Math.round(chunk.length / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate),
        end: Math.round(chunk.end / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate),
      });
      // Wrap this in a promise so that it resolves asynchronously and does not return "too fast".
      // XXX doesn't help
      return Promise.resolve(new PlaceholderChunk({
        reference: result_interval.reference,
        length: result_interval.length,
        interval: result_interval
      }));
    }

    if (this.server_clock === null) {
      this.server_clock = chunk.start;

      // This isn't ideal, but the notion is that we only do this once, so there is no accumulating rounding error.
      this.client_clock = Math.round(this.server_clock
        / this.server_clock_reference.sample_rate
        * this.client_clock_reference.sample_rate);
    }
    if (this.server_clock != chunk.start) {
      throw new Error("Cannot decode non-contiguous chunks!");
    }
    this.server_clock = chunk.end;

    var indata = chunk.data;
    var packets = unpack_multi(indata);

    // Make all the calls FIRST, and THEN gather the results. This will prevent us from interleaving with other calls to decode_chunk. (Assuming certain things about in-order dispatch and delivery of postMessage, which I hope are true.)
    lib.log(LOG_VERYSPAM, "Starting to decode sample packets", packets);
    var decoding_promises = [];
    for (var i = 0; i < packets.length; ++i) {
      decoding_promises.push(decoder.decode({
        data: packets[i].buffer
      }));
    }

    lib.log(LOG_VERYSPAM, "Forcing decoding promises", decoding_promises);
    var decoded_packets = [];
    for (var i = 0; i < decoding_promises.length; ++i) {
      var p_samples = await decoding_promises[i];
      lib.log(LOG_VERYSPAM, "Decoded samples:", p_samples);
      decoded_packets.push(new Float32Array(p_samples.samples));
    }

    var play_samples = concat_typed_arrays(decoded_packets, Float32Array);
    var decoded_length_expected = chunk.length / chunk.reference.sample_rate * this.client_clock_reference.sample_rate;
    // XXX: This is janky, in reality our chunk length divides evenly so it should be 0, if it doesn't I'm not sure what we should expect here?
    check(Math.abs(decoded_length_expected - play_samples.length) < 5, "Chunk decoded to wrong length!", chunk, play_samples);
    this.client_clock += play_samples.length;
    lib.log(LOG_SPAM, "Decoded all samples from server:", decoded_packets);

    var result_interval = new ClockInterval({
      reference: this.client_clock_reference,
      end: this.client_clock,
      length: play_samples.length
    });
    return new AudioChunk({
      interval: result_interval,
      data: play_samples
    });
  }

  async decode(packet) {
    return await this.worker_rpc(packet, [packet.data]);
  }
}

async function start() {
  switch_app_state(APP_STARTING);

  if (audioCtx) {
    throw new Error("NOT RUNNING, BUT ALREADY HAVE AUDIOCTX?");
    return;
  }

  // Do NOT set the sample rate to a fixed value. We MUST let the audioContext use
  // whatever it thinks the native sample rate is. This is becuse:
  // * Firefox does not have a resampler, so it will refuse to operate if we try
  //   to force a sample rate other than the native one
  // * Chrome does have a resampler, but it's buggy and has a habit of dropping
  //   frames of samples under load, which fucks everything up. (Note that even
  //   without resampling, Chrome still has a habit of dropping frames under
  //   load, but it happens a heck of a lot less often.)
  var AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext({latencyHint: 'playback'});
  sample_rate_text.value = audioCtx.sampleRate;
  lib.log(LOG_DEBUG, "Audio Context:", audioCtx);

  // XXX: this all gets kind of gross with 44100, nothing divides nicely.
  sample_batch_size = ms_to_batch_size(INITIAL_MS_PER_BATCH);
  window.msBatchSize.value = INITIAL_MS_PER_BATCH;

  var micNode = await configure_input_node(audioCtx);
  var spkrNode = await configure_output_node(audioCtx);

  //XXX: the AudioWorkletProcessor just seems to get leaked here, every time we stop and restart. I'm not sure if there's a way to prevent that without reloading the page... (or avoiding reallocating it when we stop and start.)
  await audioCtx.audioWorklet.addModule('audio-worklet.js');
  playerNode = new AudioWorkletNode(audioCtx, 'player');
  playerNode.port.postMessage({
    type: "log_params",
    session_id: session_id,
    log_level: lib.log_level
  });

  // Avoid starting more than one copy of the encoder/decoder workers.
  if (!encoder) {
    encoder = new AudioEncoder('worker-encoder.js');
    var enc_cfg = {
        sampling_rate: audioCtx.sampleRate,  // This instructs the encoder what sample rate we're giving it. If necessary (i.e. if not equal to 48000), it will resample.
        num_of_channels: 1,
        frame_duration: OPUS_FRAME_MS,
    };
    lib.log(LOG_DEBUG, "Setting up opus encoder. Encoder params:", enc_cfg);
    var { status, resampling } = await encoder.setup(enc_cfg);
    if (status != 0) {
      throw new Error("Encoder setup failed");
    }

    /** ENCODING/DECODING LATENCY NOTES:
      * In most normal modes, Opus adds a total of 6.5ms across encoding and decoding.
        * (see https://en.wikipedia.org/wiki/Opus_(audio_format) .)

      * Resampler latency figures from https://lastique.github.io/src_test/
        * (https://web.archive.org/web/20200918060257/https://lastique.github.io/src_test/):
        * For quality 5 (we are here), 0.8 - 1ms.
        * For quality 10, 2.6 - 3ms.

      * We run the resampler in both direction (if the system is not 48k), giving about 8.3ms of
        total added latency. (We can count the encoding and decoding together, even though they
        happen separately, because latency coming or going has the same effect.)
        * This is low enough that we SHOULD be ok to ignore it, but we will add it in to be sure.
    */

    encoding_latency_ms = 6.5;  // rudely hardcoded opus latency
    if (resampling) {
      encoding_latency_ms += 1.8;
    }
  }
  encoder.reset();

  if (!decoder) {
    decoder = new AudioDecoder('worker-decoder.js')
    var dec_cfg = {
        sampling_rate: audioCtx.sampleRate,  // This instructs the decoder what sample rate we want from it. If necessary (i.e. if not equal to 48000), it will resample.
        num_of_channels: 1,
        // Frame duration will be derived from the encoded data.
    };
    lib.log(LOG_DEBUG, "Setting up opus decder. Decoder params:", dec_cfg);
    await decoder.setup(dec_cfg);
  }
  decoder.reset();

  // The encoder stuff absolutely has to finish getting initialized before we start getting messages for it, or shit will get regrettably real. (It is designed in a non-threadsafe way, which is remarkable since javascript has no threads.)

  playerNode.port.onmessage = handle_message;
  micNode.connect(playerNode);
  playerNode.connect(spkrNode);

  // XXX: This is not great, becase it will start the AudioWorklet, which will immediately proceed to start sending us audio, which we aren't ready for yet because we're about to go into calibration mode. However if we get enough to try to send to the server at this point, the ServerConnection will discard it anyway, since it hasn't been started yet.
  await reload_settings();

  if (!disable_latency_measurement_checkbox.checked) {
    set_estimate_latency_mode(true);
    switch_app_state(APP_CALIBRATING_LATENCY);
  } else {
    switch_app_state(APP_RUNNING);
    send_local_latency();

    await server_connection.start();
  }
}

// Should really be named "restart everything", which is what it does.
async function reload_settings(startup) {
  lib.log(LOG_INFO, "Resetting the world! Old epoch was:", epoch);
  epoch +=1;
  lib.log(LOG_INFO, "New epoch is:", epoch);

  // XXX: Not guaranteed to be immediate; we should wait for it to confirm.
  playerNode.port.postMessage({
    type: "stop"
  });

  if (server_connection) {
    server_connection.stop();
    server_connection = null;
  }

  lib.log(LOG_INFO, "Stopped audio worklet and server connection.");

  mic_buf = [];

  loopback_mode = loopback_mode_select.value;

  if (loopback_mode == "none" || loopback_mode == "server") {
    server_connection = new ServerConnection({
      // Support relative paths
      target_url: new URL(server_path_text.value, document.location),
      audio_offset_seconds: parseInt(audio_offset_text.value),
      userid: myUserid,
      epoch
    })
  } else {
    server_connection = new FakeServerConnection({
      sample_rate: 48000,
      epoch
    })
  }

  lib.log(LOG_INFO, "Created new server connection, resetting encoder and decoder.");

  await encoder.reset();
  await decoder.reset();

  lib.log(LOG_INFO, "Reset encoder and decoder, starting audio worket again.");

  // Send this before we set audio params, which declares us to be ready for audio
  click_volume_change();
  var audio_params = {
    type: "audio_params",
    synthetic_source: synthetic_audio_source,
    click_interval: synthetic_click_interval,
    loopback_mode,
    epoch,
  }
  // This will reset the audio worklett, flush its buffer, and start it up again.
  playerNode.port.postMessage(audio_params);

  alarms_fired = {};
  for (let hook of start_hooks) {
    hook();
  }
}

export function init_events() {
  let target_url = server_path_text.value + "reset_events";
  let xhr = new XMLHttpRequest();
  xhr.open("POST", target_url, true);
  xhr.send();
}

function send_local_latency() {
  var local_latency_ms = parseFloat(estLatency.innerText);

  // Account for the (small) amount of latency added by opus and the speex resampler.
  local_latency_ms += encoding_latency_ms;

  // Convert from ms to samples.
  var local_latency = Math.round(local_latency_ms * audioCtx.sampleRate / 1000);

  if (synthetic_audio_source !== null) {
    local_latency = 0;
  }
  playerNode.port.postMessage({
    "type": "local_latency",
    "local_latency": local_latency,
  });
}

function samples_to_worklet(chunk) {
  var message = {
    type: "samples_in",
    chunk,
  };

  lib.log(LOG_SPAM, "Posting to worklet:", message);
  playerNode.port.postMessage(message);  // XXX huh, we aren't using transfer, and plausibly should be
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
      throw new Error("must be Uint8Array");
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
  lib.log(LOG_SPAM, "Unpacking multi-packet from server, data:", data);
  if (data.constructor !== Uint8Array) {
    throw new Error("must be Uint8Array");
  }
  var packet_count = data[0];
  var data_idx = 1;
  var result = [];
  for (var i = 0; i < packet_count; ++i) {
    var len = (data[data_idx] << 8) + data[data_idx + 1];
    lib.log(LOG_VERYSPAM, "Unpacking subpacket", i, "at offset", data_idx, "with len", len);
    var packet = new Uint8Array(len);
    data_idx += 2;
    packet.set(data.slice(data_idx, data_idx + len));
    data_idx += len;
    result.push(packet);
  }
  lib.log(LOG_SPAM, "Unpacked multi-packet from server! Final data_idx:", data_idx, ", total length:", data.length, ", num. subpackets:", packet_count, "final output:", result);
  return result;
}

function concat_typed_arrays(arrays, _constructor) {
  if (arrays.length == 0 && _constructor === undefined) {
    throw new Error("cannot concat zero arrays without constructor provided");
  }
  var constructor = _constructor || arrays[0].constructor;
  var total_len = 0;
  arrays.forEach((a) => {
    check(a.constructor === constructor, "must concat arrays of same type", a.constructor, constructor);
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rebless(o) {
  if (o.type !== undefined) {
    Object.setPrototypeOf(o, eval(o.type).prototype);
  }
  if (o.rebless) {
    o.rebless();
  }
  return o;
}

async function handle_message(event) {
  var msg = event.data;
  if (msg.type === "exception") {
    throw msg.exception;
  }
  lib.log(LOG_VERYSPAM, "onmessage in main thread received ", msg);
  if (app_state != APP_RUNNING &&
      app_state != APP_CALIBRATING_LATENCY &&
      app_state != APP_CALIBRATING_VOLUME) {
    lib.log(LOG_WARNING, "Ending message handler early because not running or calibrating");
    return;
  }
  if (msg.epoch !== undefined && msg.epoch != epoch) {
    lib.log(LOG_WARNING, "Ignoring message from old epoch");
    return;
  }

  if (msg.type === "underflow") {
    window.lostConnectivity.style.display = "block";
    await restart();
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
      window.msClientLatency.value = Math.round(msg.p50) + "ms";
      window.msWebAudioJank.value = Math.round(msg.jank) + "ms";
      window.msTrueLatency.value = Math.round(msg.p50 - msg.jank) + "ms";

      if (latency_range < msg.samples / 2) {
        // Stop trying to estimate latency once were close enough. The
        // more claps the person has done, the more we lower our
        // standards for close enough, figuring that they're having
        // trouble clapping on the beat.
        send_local_latency();
        set_estimate_latency_mode(false);
        switch_app_state(APP_CALIBRATING_VOLUME);
      }
    }
    return;
  } else if (msg.type == "current_volume") {
    // Inverse of Math.exp(6.908 * linear_volume)/1000;
    const human_readable_volume = Math.log(msg.volume * 1000) / 6.908;
    window.reportedVolume.innerText =
      Math.round(100*human_readable_volume)/100 + "dB";
    return;
  } else if (msg.type == "input_gain") {
    window.inputGain.value = msg.input_gain;
    set_estimate_volume_mode(false);
    switch_app_state(APP_RUNNING);
    await server_connection.start();
    return;
  } else if (msg.type == "bluetooth_bug_restart") {
    // God help us, the following is a workaround for an issue we see on gwillen's machine:
    // * Google Chrome Version 86.0.4240.22 (Official Build) beta (x86_64)
    // * macOS 10.14.6 (18G103)
    // * MacBook Pro (15-inch, 2017)
    // * Bose QC35 Bluetooth headset
    //
    // After opening the mic, the headset takes a few seconds to switch codecs/profiles/something.
    // When it switches, it seems to change sample rate in a way that Chrome does not detect, causing
    // the entire AudioContext to start sampling at the wrong rate. We can work around this by
    // restarting the context and reopening the device once we see the wrong rate (which means that
    // the profile switch has happened.)
    window.bluetoothWarning.style.display = "block";
    await stop();
    await start();
    return;
  } else if (msg.type == "alarm") {
    if ((msg.time in alarms) && ! (msg.time in alarms_fired)) {
      lib.log(LOG_INFO,"calling alarm at "+msg.time)
      alarms[msg.time]();
      alarms_fired[msg.time] = true;
    }
    return;
  } else if (msg.type == "cur_clock") {
    for (let cb of cur_clock_cbs) {
      cb(msg.clock);
      lib.log(LOG_WARNING, "got clock "+msg.clock+" and event_data is now "+event_data);
    }
    cur_clock_cbs = [];
    return
  } else if (msg.type != "samples_out") {
    throw new Error("Got message of unknown type: " + JSON.stringify(msg));
  }

  // If we see this change at any point, that means stop what we're doing.
  var our_epoch = epoch;

  lib.log(LOG_SPAM, "Got heard chunk:", msg);

  // Tricky metaprogramming bullshit to recover the object-nature of an object sent via postMessage
  var chunk = rebless(msg.chunk);
  mic_buf.push(chunk);

  // XXX: just for debugging
  window.msWebAudioJankCurrent.value = Math.round(msg.jank) + "ms";

  if (mic_buf.length >= sample_batch_size) {
    var chunk = concat_chunks(mic_buf);
    lib.log(LOG_SPAM, "Encoding chunk to send:", chunk);
    mic_buf = [];

    var encoded_chunk = await encoder.encode_chunk(chunk);
    if (app_state != APP_RUNNING) {
      lib.log(LOG_WARNING, "Ending message handler early because not running");
      return;
    }
    if (our_epoch != epoch) {
      lib.log(LOG_WARNING, "Ending message handler early due to stale epoch");
      return;
    }
    lib.log(LOG_SPAM, "Got encoded chunk to send:", encoded_chunk);

    var send_metadata = {
      username: window.userName.value,
      chatsToSend,
      requestedLeadPosition,
      markStartSinging,
      markStopSinging,
      loopback_mode,
      globalVolumeToSend,
      backingVolumeToSend,
      micVolumesToSend,
      backingTrackToSend,
      monitoredUserIdToSend,
      event_data,
    };
    if (requestedLeadPosition) {
      requestedLeadPosition = false;
    }
    if (markStartSinging) {
      markStartSinging = false;
    }
    if (markStopSinging) {
      markStopSinging = false;
    }
    chatsToSend = [];
    globalVolumeToSend = null;
    backingVolumeToSend = null;
    micVolumesToSend = [];
    backingTrackToSend = null;
    monitoredUserIdToSend = null;
    event_data = [];

    server_connection.set_metadata(send_metadata);
    // XXX: interesting, it does not seem that these promises are guaranteed to resolve in order... and the worklet's buffer uses the first chunk's timestamp to decide where to start playing back, so if the first two chunks are swapped it has a big problem.
    const response = await server_connection.send(encoded_chunk);
    if (!response) {
      window.lostConnectivity.style.display = "block";
      await restart();
      return;
    }
    var { metadata, chunk: response_chunk, epoch: server_epoch } = response;
    if (!response_chunk) {
      return;
    }
    if (our_epoch != epoch) {
      lib.log(LOG_WARNING, "Ending message handler early due to stale epoch");
      return;
    }
    if (server_epoch != epoch) {
      lib.log(LOG_WARNING, "Ignoring message from server with old epoch");
      return;
    }
    if (app_state != APP_RUNNING) {
      lib.log(LOG_WARNING, "Ending message handler early because not running");
      return;
    }

    //lib.log(LOG_SPAM, "Got chunk from server:", response_chunk.interval, response_chunk, metadata);
    var play_chunk = await decoder.decode_chunk(response_chunk);
    if (our_epoch != epoch) {
      lib.log(LOG_WARNING, "Ending message handler early due to stale epoch");
      return;
    }
    if (app_state != APP_RUNNING) {
      lib.log(LOG_WARNING, "Ending message handler early because not running");
      return;
    }

    lib.log(LOG_SPAM, "Decoded chunk from server:", play_chunk.interval, play_chunk);
    samples_to_worklet(play_chunk);

    var queue_size = metadata["queue_size"];
    var user_summary = metadata["user_summary"] || [];
    var tracks = metadata["tracks"] || [];
    var chats = metadata["chats"] || [];
    var delay_seconds = metadata["delay_seconds"];
    var server_sample_rate = metadata["server_sample_rate"];
    var song_start_clock = metadata["song_start_clock"];
    var client_read_clock = metadata["client_read_clock"];

    for (let ev of metadata["events"]) {
      alarms[ev["clock"]] = () => event_hooks.map(f=>f(ev["evid"]));
      lib.log(LOG_INFO, ev);
      playerNode.port.postMessage({
        type: "set_alarm",
        time: ev["clock"]
      });
    }

    // Defer touching the DOM, just to be safe.
    const connection_as_of_message = server_connection;
    requestAnimationFrame(() => {
      if (song_start_clock && song_start_clock > client_read_clock) {
        window.startSingingCountdown.style.display = "block";
        window.countdown.innerText = Math.round(
          (song_start_clock - client_read_clock) / server_sample_rate) + "s";
      } else {
        window.startSingingCountdown.style.display = "none";
      }


      if (delay_seconds) {
        if (delay_seconds > 0) {
          audio_offset_text.value = delay_seconds;
          // This will restart the world, so don't try to continue.
          audio_offset_change();
          return;
        }
      }

      // XXX: DOM stuff below this line.
      update_active_users(user_summary, server_sample_rate);
      chats.forEach((msg) => receiveChatMessage(msg[0], msg[1]));
      update_backing_tracks(tracks);

      // This is how closely it's safe to follow behind us, if you get as unlucky as possible (and try to read _just_ before we write).
      client_total_time.value = connection_as_of_message.client_window_time + play_chunk.length_seconds;
      // This is how far behind our target place in the audio stream we are. This must be added to the value above, to find out how closely it's safe to follow behind where we are _aiming_ to be. This value should be small and relatively stable, or something has gone wrong.
      client_read_slippage.value = connection_as_of_message.client_read_slippage;
    });
  }
}

var peak_out = parseFloat(peak_out_text.value);
if (isNaN(peak_out)) {
  peak_out = 0.0;
}

let previous_backing_track_str = "";
function update_backing_tracks(tracks) {
  if (JSON.stringify(tracks) == previous_backing_track_str) {
    return;
  }
  previous_backing_track_str = JSON.stringify(tracks);

  while (window.backingTrack.firstChild) {
    window.backingTrack.removeChild(window.backingTrack.firstChild);
  }

  const initialOption = document.createElement('option');
  initialOption.textContent = "[optional] backing track";
  window.backingTrack.appendChild(initialOption);

  for (var i = 0; i < tracks.length; i++) {
    const option = document.createElement('option');
    option.textContent = tracks[i];
    window.backingTrack.appendChild(option);
  }
}

let backingTrackToSend = null;
window.backingTrack.addEventListener("change", (e) => {
  backingTrackToSend = window.backingTrack.value;
});

let previous_user_summary_str = "";
let previous_mic_volume_inputs_str = "";

let imLeading = false;

function update_active_users(user_summary, server_sample_rate) {
  for (var i = 0; i < user_summary.length; i++) {
    const userid = user_summary[i][3];
    if (userid != myUserid) {
      const is_monitoring = user_summary[i][4];
      if (window.monitorUserToggle.amMonitoring && is_monitoring) {
        // If someone else has started monitoring, we're done.
        endMonitoring(/*server_initiated=*/true);
      }
    }
  }

  if (window.monitorUserToggle.amMonitoring) {
    return;
  }

  if (JSON.stringify(user_summary) == previous_user_summary_str) {
    return;
  }
  previous_user_summary_str = JSON.stringify(user_summary);

  // Delete previous users.
  while (window.activeUsers.firstChild) {
    window.activeUsers.removeChild(window.activeUsers.lastChild);
  }

  const mic_volume_inputs = [];
  for (var i = 0; i < user_summary.length; i++) {
    const offset_s = user_summary[i][0];
    const name = user_summary[i][1];
    const mic_volume = user_summary[i][2];
    const userid = user_summary[i][3];

    if (i === 0) {
      const wasLeading = imLeading;
      imLeading = (userid == myUserid && offset_s < 5);

      if (imLeading && !wasLeading) {
        window.takeLead.textContent = "Start Singing";
        leadButtonState = "start-singing";
        window.jumpToEnd.disabled = true;
        window.backingTrack.style.display = "block";
        window.backingTrack.selectedIndex = 0;
      } else if (!imLeading && wasLeading) {
        window.takeLead.textContent = "Lead a Song";
        leadButtonState = "take-lead";
        window.jumpToEnd.disabled = false;
        window.backingTrack.style.display = "none";
      }
    }

    mic_volume_inputs.push([name, userid, mic_volume]);

    const tr = document.createElement('tr');

    const td1 = document.createElement('td');
    td1.textContent = offset_s;
    tr.appendChild(td1);

    const td2 = document.createElement('td');
    td2.textContent = name;
    tr.appendChild(td2);

    window.activeUsers.appendChild(tr);
  }

  mic_volume_inputs.sort();
  if (JSON.stringify(mic_volume_inputs) != previous_mic_volume_inputs_str) {
    while (window.monitorUserSelect.firstChild) {
      window.monitorUserSelect.removeChild(window.monitorUserSelect.lastChild);
    }
    const initialOption = document.createElement('option');
    initialOption.textContent = "Select User";
    window.monitorUserSelect.appendChild(initialOption);

    for (var i = 0; i < mic_volume_inputs.length; i++) {
      const option = document.createElement('option');

      const name = mic_volume_inputs[i][0];
      const userid = mic_volume_inputs[i][1];
      const vol = mic_volume_inputs[i][2];

      option.textContent = (vol === 1.0) ? name : (name + " -- " + vol);
      option.username = name;
      option.userid = userid;
      option.mic_volume = vol;

      window.monitorUserSelect.appendChild(option);
    }
  }
  previous_mic_volume_inputs_str = JSON.stringify(mic_volume_inputs);
}

let monitoredUserIdToSend = null;

function endMonitoring(server_initiated) {
  if (micPaused) {
    toggle_mic();
  }
  window.monitorUserToggle.innerText = "Begin Monitoring";
  window.monitorUserToggle.amMonitoring = false;
  if (!server_initiated) {
    monitoredUserIdToSend = "end";
  }
}

function beginMonitoring(option) {
  if (!micPaused) {
    toggle_mic();
  }
  window.monitorUserToggle.innerText = "End Monitoring";
  window.monitorUserToggle.amMonitoring = true;
  startMonitoringUser(option);
}

function startMonitoringUser(option) {
  window.micVolumeSetting.userid = option.userid;
  window.micVolumeSetting.value = option.mic_volume;
  monitoredUserIdToSend = option.userid;
}

window.monitorUserSelect.addEventListener("change", (e) => {
  if (window.monitorUserToggle.amMonitoring) {
    if (window.monitorUserSelect.selectedIndex > 0) {
      const option = window.monitorUserSelect.children[
        window.monitorUserSelect.selectedIndex];
      if (option.userid) {
        startMonitoringUser(option);
        return;
      }
    }
    endMonitoring(/*server_initiated=*/false);
  }
});

window.monitorUserToggle.addEventListener("click", (e) => {
  if (window.monitorUserSelect.selectedIndex < 0) {
    return;
  }
  const option = window.monitorUserSelect.children[
    window.monitorUserSelect.selectedIndex];
  if (!window.monitorUserToggle.amMonitoring && !option.userid) {
    // Not monitoring and no one to monitor, nothing to do.
    return;
  }

  if (!window.monitorUserToggle.amMonitoring) {
    beginMonitoring(option);
  } else {
    endMonitoring(/*server_initiated=*/false);
  }
});

let micVolumesToSend = [];
window.micVolumeApply.addEventListener("click", (e) => {
  const option = window.monitorUserSelect.children[
    window.monitorUserSelect.selectedIndex];
  option.mic_volume = window.micVolumeSetting.value;
  option.textContent = option.username + " -- " + option.mic_volume;
  micVolumesToSend.push([window.micVolumeSetting.userid,
                         parseFloat(window.micVolumeSetting.value)]);
});

async function restart() {
  if (app_state === APP_RESTARTING) {
    return;
  }
  switch_app_state(APP_RESTARTING);
  await reload_settings();
  await server_connection.start();
  window.lostConnectivity.style.display = "none";
  switch_app_state(APP_RUNNING);
}

async function stop() {
  if (app_state != APP_RUNNING &&
      app_state != APP_CALIBRATING_LATENCY &&
      app_state != APP_CALIBRATING_VOLUME) {
    lib.log(LOG_WARNING, "Trying to stop, but current state is not running or calibrating? Stopping anyway.");
  }
  switch_app_state(APP_STOPPING);

  if (micPaused) {
    toggle_mic();
  }

  if (speakerPaused) {
    toggle_speaker();
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

  for (let hook of stop_hooks) {
    hook();
  }

  switch_app_state(APP_STOPPED);
}

start_button.addEventListener("click", start_stop);
window.micToggleButton.addEventListener("click", toggle_mic);
window.speakerToggleButton.addEventListener("click", toggle_speaker);
click_volume_slider.addEventListener("change", click_volume_change);
audio_offset_text.addEventListener("change", audio_offset_change);

window.startVolumeCalibration.addEventListener("click", () => {
  window.startVolumeCalibration.disabled = true;
  set_estimate_volume_mode(true);
});

let globalVolumeToSend = null;
window.globalVolumeControl.addEventListener("change", () => {
  globalVolumeToSend = window.globalVolumeControl.value;
});

let backingVolumeToSend = null;
window.backingVolumeControl.addEventListener("change", () => {
  backingVolumeToSend = window.backingVolumeControl.value;
});

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

async function initialize() {
  await wait_for_mic_permissions();
  await enumerate_devices();

  if (document.location.hostname == "localhost") {
    // Better default for debugging.
    server_path_text.value = "http://localhost:8081/"
  }

  app_initialized = true;
  if (app_state != APP_TUTORIAL) {
    switch_app_state(APP_STOPPED);
  }
}

function hide_buttons_and_append_answer(element, answer) {
  for (var i = 0; i < element.children.length; i++) {
    element.children[i].style.display = "none";
  }
  const b = document.createElement('b');
  b.innerText = answer;
  element.appendChild(b);
};

function tutorial_answer(button) {
  const answer = button.innerText;
  const question = button.parentElement.id;
  hide_buttons_and_append_answer(button.parentElement, button.innerText);
  if (question === "q_headphones_present") {
    if (answer == "Yes") {
      window.q_headphones_wired.style.display = 'block';
    } else {
      window.q_wired_headphones_available.style.display = 'block';
    }
  } else if (question === "q_wired_headphones_available") {
    if (answer == "Yes") {
      window.final_attach_wired.style.display = 'block';
    } else {
      window.final_no_headphones.style.display = 'block';
    }
  } else if (question === "q_headphones_wired") {
    if (answer == "Yes") {
      window.final_wired_headphones.style.display = 'block';
      document.querySelectorAll(".headphoneAdvice").forEach(
        (element) => element.style.display = 'inline');
    } else {
      window.final_detach_wireless.style.display = 'block';
    }
  }
}

function hide_tutorial() {
  window.tutorial.style.display = 'none';
  window.nameSelector.display = 'block';
  window.mainApp.display = 'block';
}


document.querySelectorAll(".dismiss_tutorial").forEach(
  (button) => button.addEventListener("click", () => {
    switch_app_state(app_initialized ? APP_STOPPED : APP_INITIALIZING);
  }));

document.querySelectorAll("#tutorial_questions button").forEach(
  (button) => button.addEventListener("click", () => tutorial_answer(button)));

initialize();
