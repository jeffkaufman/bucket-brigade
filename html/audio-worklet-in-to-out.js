
import * as lib from './lib.js';
import {LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';

lib.set_logging_context_id("audioworklet");
lib.log(LOG_INFO, "Audio worklet module loading");

const FRAME_SIZE = 128;  // by Web Audio API spec

class Player extends AudioWorkletProcessor {
  constructor () {
    lib.log(LOG_INFO, "Audio worklet object constructing");
    super();
    this.local_clock = null;
    this.play_buffer = [];
    this.min_buffer_size = 150;  // in frames of 128 samples / about 3ms
    this.max_buffer_size = 250;
    this.underflow_count = 0;
    this.started = false;
    this.debug_ctr = 0;
    this.port.onmessage = this.handle_message.bind(this);
  }

  handle_message(event) {
    var msg = event.data;
    if (msg.type == "log_params") {
      if (msg.log_level) {
        lib.set_log_level(msg.log_level);
      }
      if (msg.session_id) {
        lib.set_logging_session_id(msg.session_id);
        lib.log(LOG_INFO, "Audio worklet logging ready");
      }
      return;
    } else if (msg.type != "samples_in") {
      // XXX flip out
      return;
    }
    var play_samples = msg.samples;
    var play_clock = msg.clock;

    if (this.local_clock === null) {
      this.local_clock = play_clock;
    }

    if (this.debug_ctr % 10 == 0) {
      lib.log(LOG_DEBUG, "audio buffer length (samples): ", this.play_buffer.length, ", new input (samples): ", play_samples.length);
    }
    this.debug_ctr++;
    if (this.play_buffer.length >= FRAME_SIZE * this.max_buffer_size) {
      lib.log(LOG_WARNING, "OVERFLOW");
      return;
    }
    this.play_buffer = this.play_buffer.concat(play_samples);
  }

  process (inputs, outputs, parameters) {
    var write_clock = null;
    var read_clock = null;
    if (this.local_clock !== null) {
      this.local_clock += FRAME_SIZE;
      write_clock = this.local_clock - this.play_buffer.length * FRAME_SIZE;
      read_clock = this.local_clock;
    }
    // Before we fully start up, write_clock will be negative. The current server
    //   implementation should tolerate this, but it's quirky.
    this.port.postMessage([Array.from(inputs[0][0]), write_clock, read_clock]);

    // Buffer a bit before we get started.
    if (this.play_buffer.length < FRAME_SIZE * this.min_buffer_size && !this.started) {
      return true;
    }
    this.started = true;
    while (this.play_buffer.length >= FRAME_SIZE && this.underflow_count) {
      lib.log(LOG_WARNING, "dropping frame to compensate for underflow");
      this.play_buffer = this.play_buffer.slice(FRAME_SIZE);
      this.underflow_count--;
    }
    if (this.play_buffer.length < FRAME_SIZE) {
      lib.log(LOG_WARNING, "UNDERFLOW");
      this.underflow_count++;
      this.started = false;  // fill buffer back up to minimum
      return true;
    }
    var samples = this.play_buffer.slice(0, FRAME_SIZE);
    this.play_buffer = this.play_buffer.slice(FRAME_SIZE);
    for (var chan = 0; chan < outputs[0].length; chan++) {
      for (var i = 0; i < samples.length; i++) {
        outputs[0][chan][i] = samples[i];
      }
    }
    return true;
  }
}

registerProcessor('player', Player)
