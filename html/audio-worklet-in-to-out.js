
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

class ClockedRingBuffer {
  constructor(type, size, leadin_samples) {
    if (leadin_samples > size) {
      // Note that even getting close is likely to result in failure.
      lib.log(LOG_ERROR, "leadin samples must not exceed size");
      throw "leadin samples must not exceed size";
    }
    // Before the first write, all reads will be zero. After the first write,
    // the first leadin_samples read will be zero, then real reads will start.
    // (This allows a buffer to build up.)
    this.leadin_samples = leadin_samples;
    this.read_clock = null;
    this.len = size;
    this.buf = new type(size);
    this.buf.fill(NaN);
    // For debugging, mostly
    this.buffered_data = 0;
  }

  buffered_data() {
    return this.buffered_data;
  }

  // Note: We can get writes out of order, so having space left is
  //   no guarantee that a given write will succeed.
  space_left() {
    return this.len - this.buffered_data;
  }

  real_offset(offset) {
    var len = this.len;
    // Hack to handle negative numbers (just in case)
    var real_offset = ((offset % len) + len) % len;

    if (!(real_offset >= 0 && real_offset < len)) {
      lib.log(LOG_ERROR, "Bad offset:", offset);
      throw "Bad offset:" + offset;
    }
    return real_offset;
  }

  get_read_clock() {
    return this.read_clock;
  }

  read() {
    lib.log_every(12800, "buf_read", LOG_DEBUG, "leadin_samples:", this.leadin_samples, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left());
    if (this.read_clock === null) {
      return 0;
    }
    if (this.leadin_samples > 0) {
      this.read_clock++;
      this.leadin_samples--;
      return 0;
    }
    var val = this.buf[this.real_offset(this.read_clock)];
    if (isNaN(val)) {
      // XXX: hardcoded interval matches size of our net requests
      lib.log_every(12800, LOG_ERROR, "Buffer underflow :-( leadin_samples:", this.leadin_samples, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left());
      this.read_clock++;
      return 0;
    }
    this.buf[this.real_offset(this.read_clock)] = NaN;  // Mostly for debugging
    this.read_clock++;
    this.buffered_data--;
    return val;
  }

  write(value, write_clock) {
    if (write_clock != Math.round(write_clock)) {
      lib.log(LOG_ERROR, "write_clock not an integer?!");
      throw "write_clock not an integer?!";
    }
    lib.log_every(12800, "buf_write", LOG_DEBUG, "write_clock:", write_clock, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left());
    if (this.read_clock === null) {
      // It should be acceptable for this to end up negative
      this.read_clock = write_clock - this.leadin_samples;
    }
    if (!isNaN(this.buf[this.real_offset(write_clock)])) {
      lib.log(LOG_ERROR, "Buffer overflow :-( write_clock:", write_clock, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left());
      // XXX: Perhaps be more graceful.
      // XXX: this should really never ever happen unless we are very close to full, but we do see it happening and I don't understand why.
      throw("Buffer overflow");
    }
    this.buf[this.real_offset(write_clock)] = value;
    this.buffered_data++;
  }
}

class Player extends AudioWorkletProcessor {
  constructor () {
    lib.log(LOG_INFO, "Audio worklet object constructing");
    super();
    this.ready = false;
    this.port.onmessage = this.handle_message.bind(this);
  }

  handle_message(event) {
    try {
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
        this.local_latency = msg.local_latency;
        this.synthetic_source = msg.synthetic_source;
        this.synthetic_sink = msg.synthetic_sink;
        this.loopback_mode = msg.loopback_mode;

        // This is _extra_ slack on top of the size of the server request.
        this.client_slack = this.sample_rate * 1.5;

        // 15 seconds of total buffer, `this.slack` seconds of leadin, force things to round to FRAME_SIZE
        this.play_buffer = new ClockedRingBuffer(
          Float32Array,
          Math.round(15 * this.sample_rate / FRAME_SIZE) * FRAME_SIZE,
          Math.round(this.client_slack / FRAME_SIZE) * FRAME_SIZE);

        this.ready = true;
        return;
      } else if (msg.type == "local_latency") {
        this.local_latency = msg.local_latency;
        return;
      } else if (!this.ready) {
        lib.log(LOG_ERROR, "received message before ready:", msg);
        return;
      } else if (msg.type != "samples_in") {
        lib.log(LOG_ERROR, "Unknown message:", msg);
        return;
      }
      var play_samples = msg.samples;

      lib.log_every(10, "new_samples", LOG_DEBUG, "new input (samples): ", play_samples.length, "; current play buffer:", this.play_buffer);

      for (var i = 0; i < play_samples.length; i++) {
        this.play_buffer.write(play_samples[i], msg.clock - play_samples.length + i);
      }
      lib.log(LOG_VERYSPAM, "new play buffer:", this.play_buffer);
    } catch (ex) {
      this.port.postMessage({
        type: "exception",
        exception: ex
      });
      throw ex;
    }
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

  synthesize_clicks(input) {
    lib.log(LOG_SPAM, "synthesizing clicks");
    if (!this.synthetic_source_counter) {
      lib.log(LOG_INFO, "Starting up synthetic source");
      this.synthetic_source_counter = 0;
    }

    var sound_level = 0.0;
    if (this.synthetic_source_counter % Math.round(this.sample_rate / FRAME_SIZE) == 0) {
      sound_level = 0.1;
    }

    // This is probably not very kosher...
    for (var i = 0; i < input[0].length; i++) {
      for (var chan = 0; chan < input.length; chan++) {
        input[chan][i] = sound_level;
      }
    }
    this.synthetic_source_counter++;
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
      lib.log_every(100, "process_before_ready", LOG_ERROR, "tried to process before ready");
      return true;
    }

    try {
      lib.log(LOG_VERYSPAM, "process inputs:", inputs);
      if (this.synthetic_source == "SYNTHETIC") {
        // Ignore our input and overwrite it with sequential numbers for debugging
        this.synthesize_input(inputs[0]);
      } else if (this.synthetic_source == "CLICKS") {
        this.synthesize_clicks(inputs[0]);
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
        lib.log(LOG_VERYSPAM, "about to output samples from", this.play_buffer, "with length", this.play_buffer.length);

        for (var i = 0; i < outputs[0][0].length; i++) {
          var val = this.play_buffer.read();
          for (var chan = 0; chan < outputs[0].length; chan++) {
            outputs[0][chan][i] = val;
            // This is the "opposite" of local loopback: There, we take whatever
            //   we hear on the mic and send to the speaker, whereas here we take
            //   whatever we're about to send to the speaker, and pretend we
            //   heard it on the mic.
            if (this.synthetic_source == "ECHO") {
              inputs[0][chan][i] = val;
            }
          }
        }
        var end_clock = this.play_buffer.get_read_clock();
        this.port.postMessage({
          type: "samples_out",
          samples: inputs[0][0],
          clock: end_clock
        }, [inputs[0][0].buffer]);
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
