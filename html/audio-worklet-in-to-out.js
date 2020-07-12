
import * as lib from './lib.js';
import {LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';

lib.set_logging_context_id("audioworklet");
lib.log(LOG_INFO, "Audio worklet module loading");

const FRAME_SIZE = 128;  // by Web Audio API spec

class Player extends AudioWorkletProcessor {
  constructor () {
    lib.log(LOG_INFO, "Audio worklet object constructing");
    super();
    this.offset = undefined;
    this.early_clock = null;
    this.play_buffer = new Float32Array(5 * 44100);
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
    } else if (msg.type == "audio_params") {
      this.offset = msg.offset;
      return;
    } else if (msg.type != "samples_in") {
      // XXX flip out
      return;
    }
    var play_samples = msg.samples;
    var late_clock = msg.clock;

    if (this.early_clock === null) {
      // Allocate half our "slack" to our client-side playback buffer.
      this.early_clock = late_clock - this.offset / 2;
    }

    if (this.debug_ctr % 10 == 0) {
      lib.log(LOG_DEBUG, "new input (samples): ", play_samples.length, "; current play buffer:", this.play_buffer, "clocks:", this.early_clock, late_clock);
    }
    this.debug_ctr++;

    // TODO: Deal with overflow.
    for (var i = 0; i < play_samples.length; i++) {
      this.play_buffer[(late_clock + i) % this.play_buffer.length] = play_samples[i];
    }
  }

  process (inputs, outputs, parameters) {
    var write_clock = null;
    var read_clock = null;
    var magic_offset = 44100; // ???;

    if (this.early_clock !== null) {
      this.early_clock += FRAME_SIZE;
      write_clock = this.early_clock;
      read_clock = this.early_clock + magic_offset;
    }
    // Before we fully start up, write_clock will be negative. The current server
    //   implementation should tolerate this, but it's quirky.
    this.port.postMessage([inputs[0][0], write_clock, read_clock], [inputs[0][0].buffer]);

    for (var i = 0; i < outputs[0][0].length; i++) {
      for (var chan = 0; chan < outputs[0].length; chan++) {
        outputs[0][chan][i] = this.play_buffer[(this.early_clock + i) % this.play_buffer.length];
      }
    }
    return true;
  }
}

registerProcessor('player', Player);
