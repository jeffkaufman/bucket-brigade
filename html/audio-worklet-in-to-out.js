
import * as lib from './lib.js';
import {LOG_VERYSPAM, LOG_SPAM, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR} from './lib.js';

// This trick allows us to load this file as a regular module, which in turn
//   allows us to flush it from the cache when needed, as a workaround for
//   https://bugs.chromium.org/p/chromium/issues/detail?id=880784 .
if (typeof AudioWorkletProcessor === "undefined") {
  lib.log(LOG_INFO, "Audio worklet module preloading");
  // If we are loaded as a regular module, skip the entire rest of the file
  //   (which will not be valid outside the audio worklet context).
} else {

lib.set_logging_context_id("audioworklet");
lib.log(LOG_INFO, "Audio worklet module loading");

const FRAME_SIZE = 128;  // by Web Audio API spec

class RingBuffer {
  constructor(type, size) {
    this.len = size;
    this.buf = new type(size);
    this.buf.fill(0);  // Probably a no-op
  }

  real_offset(offset) {
    var len = this.len;
    var real_offset = ((offset % len) + len) % len;

    if (!(real_offset >= 0 && real_offset < len)) {
      throw "Bad offset:" + offset;
    }
    return real_offset;
  }

  wrapping_read(offset) {
    return this.buf[this.real_offset(offset)];
  }

  wrapping_write(offset, value) {
    this.buf[this.real_offset(offset)] = value;
  }
}

class Player extends AudioWorkletProcessor {
  constructor () {
    lib.log(LOG_INFO, "Audio worklet object constructing");
    super();
    this.ready = false;
    this.early_clock = undefined;
    this.play_buffer = new RingBuffer(Float32Array, 15 * 44100);  // 15 seconds
    this.debug_ctr = 0;
    this.port.onmessage = this.handle_message.bind(this);
  }

  handle_message(event) {
    var msg = event.data;
    lib.log(LOG_VERYSPAM, "handle_message in audioworklet:", msg);

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
      this.sample_rate = msg.sample_rate;
      this.offset = msg.offset;
      this.synthetic_source = msg.synthetic_source;
      this.synthetic_sink = msg.synthetic_sink;
      this.loopback_mode = msg.loopback_mode;

      this.slack = this.sample_rate * 1;  // 1 second of slack
      this.client_slack = this.slack / 2;
      this.server_slack = this.slack - this.client_slack;

      this.ready = true;
      return;
    } else if (!this.ready) {
      lib.log(LOG_ERROR, "received message before ready:", msg);
      return;
    } else if (msg.type != "samples_in") {
      lib.log(LOG_ERROR, "Unknown message:", msg);
      return;
    }
    var play_samples = msg.samples;
    var late_clock = msg.clock;

    if (this.early_clock === undefined) {
      this.early_clock = late_clock - this.client_slack;
    }

    lib.log_every(10, "new_samples", LOG_DEBUG, "new input (samples): ", play_samples.length, "; current play buffer:", this.play_buffer, "clocks:", this.early_clock, late_clock);

    // TODO: Deal with overflow.
    for (var i = 0; i < play_samples.length; i++) {
      this.play_buffer.wrapping_write(late_clock + i, play_samples[i]);
    }
    lib.log(LOG_VERYSPAM, "new play buffer:", this.play_buffer, "clocks:", this.early_clock, late_clock);
  }

  // Only for debugging
  synthesize_input(input) {
    lib.log(LOG_SPAM, "synthesizing fake input");
    if (!this.synthetic_source_counter) {
      lib.log(LOG_INFO, "Starting up synthetic source");
      this.synthetic_source_counter = 0;
    }
    // This is probably not very kosher...
    for (var i = 0; i < input[0].length; i++) {
      for (var chan = 0; chan < input.length; chan++) {
        input[chan][i] = this.synthetic_source_counter;
      }
      this.synthetic_source_counter++;
    }
  }

  // Only for debugging
  check_synthetic_output(output) {
    lib.log(LOG_SPAM, "validating synthesized data in output (channel 0 only):", output[0]);
    if (typeof this.synthetic_sink_counter === "undefined") {
      lib.log(LOG_INFO, "Starting up synthetic sink");
      this.synthetic_sink_counter = 0;
      this.synthetic_sink_leading_zeroes = 0;
    }
    for (var i = 0; i < FRAME_SIZE; i++) {
      if (this.synthetic_sink_counter == 0) {
        if (output[0][i] == 0) {
          // No problem, leading zeroes are fine.
          this.synthetic_sink_leading_zeroes++;
        } else {
          lib.log(LOG_INFO, "Saw", this.synthetic_sink_leading_zeroes, "zeros in stream");
          this.synthetic_sink_counter++;
        }
      } else if (output[0][i] == this.synthetic_sink_counter + 1) {
        // No problem, incrementing numbers.
        this.synthetic_sink_counter++;
        if (this.synthetic_sink_counter % 100000 == 0) {
          lib.log(LOG_INFO, "Synthetic sink has seen", this.synthetic_sink_counter, "samples");
        }
      } else {
        lib.log(LOG_WARNING, "Misordered data in frame:", output[0]);
        this.synthetic_sink_counter = output[0][i];
      }
    }
  }

  process (inputs, outputs, parameters) {
    if (!this.ready) {
      lib.log(LOG_ERROR, "tried to process before ready");
      return true;
    }

    try {
      var write_clock = null;
      var read_clock = null;

      if (this.early_clock !== undefined) {
        // Note: Incrementing first means that we have one frame less client-side buffer than set above. This is fine unless we accidentally set our buffer too small, in which case it contributes to glitches.
        this.early_clock += FRAME_SIZE;
        write_clock = this.early_clock;
        read_clock = this.early_clock + this.server_slack;
      }

      lib.log(LOG_VERYSPAM, "process inputs:", inputs);
      if (this.synthetic_source) {
        // Ignore our input and overwrite it with sequential numbers for debugging
        this.synthesize_input(inputs[0]);
      }

      if (this.loopback_mode === "worklet") {
        // Send input straight to output and do nothing else with it (only for debugging)
        for (var chan = 0; chan < outputs[0].length; chan++) {
          if (outputs[0].length == inputs[0].length) {
            outputs[0][chan].set(inputs[0][chan]);
          } else {
            outputs[0][chan].set(inputs[0][0]);
          }
        }
      } else {
        // Normal input/output handling
        this.port.postMessage({
          type: "samples_out",
          samples: inputs[0][0],
          write_clock: write_clock,
          read_clock: read_clock
        }, [inputs[0][0].buffer]);

        if (this.early_clock !== undefined) {
          lib.log(LOG_VERYSPAM, "about to output samples from", this.play_buffer, "with length", this.play_buffer.length, "early clock:", this.early_clock, "starting with:", this.play_buffer.wrapping_read(this.early_clock));
          for (var i = 0; i < outputs[0][0].length; i++) {
            for (var chan = 0; chan < outputs[0].length; chan++) {
              outputs[0][chan][i] = this.play_buffer.wrapping_read(this.early_clock + i);
            }
          }
        }
        // End normal handling
      }

      if (this.synthetic_sink) {
        // Check that our output looks like sequential numbers for debugging
        this.check_synthetic_output(outputs[0]);
      }

      return true;
    } catch (ex) {
      this.port.postMessage({
        type: "exception",
        exception: ex
      });
      throw ex;
    }
  }
}

registerProcessor('player', Player);

}
