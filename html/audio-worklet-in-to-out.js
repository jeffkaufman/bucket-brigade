
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
    this.play_buffer = new Float32Array(5 * 44100);
    this.rd_ptr = 0;
    this.wr_ptr = 44100;  // start effective buffer size at 1s
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
      lib.log(LOG_DEBUG, "new input (samples): ", play_samples.length, "; current play buffer:", this.play_buffer, "pointers:", this.rd_ptr, this.wr_ptr);
    }
    this.debug_ctr++;

    // TODO: Deal with overflow.
    // TODO: Deal with out-of-order messages.
    for (var i = 0; i < play_samples.length; i++) {
      this.play_buffer[this.wr_ptr] = play_samples[i];
      this.wr_ptr = (this.wr_ptr + 1) % this.play_buffer.length;
    }
  }

  process (inputs, outputs, parameters) {
    var write_clock = null;
    var read_clock = null;
    if (this.local_clock !== null) {
      this.local_clock += FRAME_SIZE;
      write_clock = this.local_clock - ((this.wr_ptr - this.rd_ptr) % this.play_buffer.length);
      read_clock = this.local_clock;
    }
    // Before we fully start up, write_clock will be negative. The current server
    //   implementation should tolerate this, but it's quirky.
    this.port.postMessage([inputs[0][0], write_clock, read_clock], [inputs[0][0].buffer]);

    for (var i = 0; i < outputs[0][0].length; i++) {
      for (var chan = 0; chan < outputs[0].length; chan++) {
        outputs[0][chan][i] = this.play_buffer[this.rd_ptr];
      }
      this.rd_ptr = (this.rd_ptr + 1) % this.play_buffer.length;
    }
    return true;
  }
}

registerProcessor('player', Player);
