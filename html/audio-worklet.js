
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
      // TODO: Seeing an underflow should make us allocate more client slack

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

    // State related to peak detection processing:
    // clicks
    this.click_index = 0;
    this.beat_index = 0;
    const bpm = 105;
    this.click_frame_interval =
      Math.round(sampleRate / FRAME_SIZE * 60 / bpm);
    this.click_volume = 0;

    // peak detection
    this.window = [];
    this.last_peak = Date.now();
    this.background_noise = 0;
    this.background_samples = [];
    this.max_background_samples = sampleRate * 3 / FRAME_SIZE;  // 3s
    this.frames_since_last_beat = 0;

    // tuning params
    this.peak_ratio = 10;
    this.min_peak_interval_ms = 200;
    this.window_size_samples = 20;
    this.click_interval_samples = 3000;

    this.latencies = [];
    this.local_latency = 150;  // rough initial guess
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
        this.synthetic_source = msg.synthetic_source;
        this.click_interval = msg.click_interval;
        this.synthetic_sink = msg.synthetic_sink;
        this.loopback_mode = msg.loopback_mode;

        // This is _extra_ slack on top of the size of the server request.
        this.client_slack = sampleRate * .3;  // 300ms

        // 15 seconds of total buffer, `this.slack` seconds of leadin, force things to round to FRAME_SIZE
        this.play_buffer = new ClockedRingBuffer(
          Float32Array,
          Math.round(15 * sampleRate / FRAME_SIZE) * FRAME_SIZE,
          Math.round(this.client_slack / FRAME_SIZE) * FRAME_SIZE);

        this.ready = true;
        return;
      } else if (msg.type == "local_latency") {
        this.local_latency = msg.local_latency;
        return;
      } else if (msg.type == "latency_estimation_mode") {
        this.latency_measurement_mode = msg.enabled;
        this.click_index = 0;
        this.beat_index = 0;
        return;
      } else if (msg.type == "mute_mode") {
        this.mute_mode = msg.enabled;
        return;
      } else if (msg.type == "click_volume_change") {
        this.set_click_volume(msg.value/100);
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
      if (ex != "Buffer overflow") {
        throw ex;
      }
    }
  }

  set_click_volume(linear_volume) {
    // https://www.dr-lex.be/info-stuff/volumecontrols.html
    this.click_volume = Math.exp(6.908 * linear_volume)/1000;
  }

  // Only for debugging
  synthesize_input(input) {
    lib.log(LOG_SPAM, "synthesizing fake input");
    if (!this.synthetic_source_counter) {
      lib.log(LOG_INFO, "Starting up synthetic source");
      this.synthetic_source_counter = 0;
    }
    // This is probably not very kosher...
    for (var i = 0; i < input.length; i++) {
      input[i] = this.synthetic_source_counter;
      this.synthetic_source_counter++;
    }
  }

  synthesize_clicks(input, interval) {
    lib.log(LOG_SPAM, "synthesizing clicks");
    if (!this.synthetic_source_counter) {
      lib.log(LOG_INFO, "Starting up clicks");
      this.synthetic_source_counter = 0;
    }

    var sound_level = 0.0;
    if (this.synthetic_source_counter % Math.round(sampleRate * interval / FRAME_SIZE) == 0) {
      sound_level = this.click_volume;
    }

    // This is probably not very kosher...
    for (var i = 0; i < input.length; i++) {
      input[i] = sound_level;
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
        if (output[i] == 0) {
          // No problem, leading zeroes are fine.
          this.synthetic_sink_leading_zeroes++;
        } else {
          lib.log(LOG_INFO, "Saw", this.synthetic_sink_leading_zeroes, "zeros in stream");
          this.synthetic_sink_counter++;
        }
      } else if (output[i] == this.synthetic_sink_counter + 1) {
        // No problem, incrementing numbers.
        this.synthetic_sink_counter++;
        if (this.synthetic_sink_counter % 100000 == 0) {
          lib.log(LOG_INFO, "Synthetic sink has seen", this.synthetic_sink_counter, "samples");
        }
      } else {
        lib.log(LOG_WARNING, "Misordered data in frame:", output);
        this.synthetic_sink_counter = output[i];
      }
    }
  }

  detect_peak(index, now) {
    var abs_sum = 0;
    for (var i = 0; i < this.window.length; i++) {
      abs_sum += Math.abs(this.window[i]);
    }

    if (abs_sum / this.window.length >
        this.background_noise / (this.background_samples.length*FRAME_SIZE) * this.peak_ratio &&
        now - this.last_peak > this.min_peak_interval_ms) {
      this.last_peak = now;
      var latency_samples = index + 128*this.frames_since_last_beat;
      var latency_ms = 1000.0 * latency_samples / sampleRate;
      if (latency_ms > 500) {
        latency_ms -= 1000;
      }

      this.latencies.push(latency_ms);
      const msg = {
        "type": "latency_estimate",
        "samples": this.latencies.length,
      }

      if (this.latencies.length > 5) {
        this.latencies.sort((a, b) => a-b);
        msg.p40 = this.latencies[Math.round(this.latencies.length * 0.4)];
        msg.p50 = this.latencies[Math.round(this.latencies.length * 0.5)];
        msg.p60 = this.latencies[Math.round(this.latencies.length * 0.6)];
      }

      this.port.postMessage(msg);
    }
  }

  process_latency_measurement(input, output) {
    this.click_index++;
    var is_beat = this.click_index % this.click_frame_interval == 0;
    if (is_beat) {
      this.frames_since_last_beat = 0;
      this.beat_index++;
    } else {
      this.frames_since_last_beat++;
    }

    const freq = 1024;
    const period = sampleRate / freq;

    for (var k = 0; k < output.length; k++) {
      if (is_beat) {
        output[k] = this.click_volume * Math.sin(Math.PI * 2 * k / period);
      } else {
        output[k] = 0;
      }
    }

    var now = Date.now();
    var noise = 0;
    for (var i = 0 ; i < input.length; i++) {
      noise += Math.abs(input[i]);

      this.window.push(input[i]);
      if (this.window.length > this.window_size_samples) {
        this.window.shift();
      }

      if (this.background_noise > 0) {
        this.detect_peak(i, now);
      }
    }

    this.background_samples.push(noise);
    this.background_noise += noise;
    if (this.background_samples.length > this.max_background_samples) {
      // Note: if this ends up using too much CPU we can use a circular buffer.
      this.background_noise -= Math.abs(this.background_samples.shift());
    }

    if (this.beat_index > 1 && this.background_noise == 0) {
      this.port.postMessage({type: "no_mic_input"});
    }
  }

  process_normal(input, output) {
    lib.log(LOG_VERYSPAM, "process_normal:", input);
    if (this.synthetic_source == "NUMERIC") {
      // Ignore our input and overwrite it with sequential numbers for debugging
      this.synthesize_input(input);
    } else if (this.synthetic_source == "CLICKS") {
      this.synthesize_clicks(input, this.click_interval);
    }

    if (this.loopback_mode === "worklet") {
      // Send input straight to output and do nothing else with it (only for debugging)
      output.set(input);
    } else {
      // Normal input/output handling
      lib.log(LOG_VERYSPAM, "about to output samples from", this.play_buffer, "with length", this.play_buffer.length);

      for (var i = 0; i < output.length; i++) {
        var val = this.play_buffer.read();
        output[i] = val;
        // This is the "opposite" of local loopback: There, we take whatever
        //   we hear on the mic and send to the speaker, whereas here we take
        //   whatever we're about to send to the speaker, and pretend we
        //   heard it on the mic.
        if (this.synthetic_source == "ECHO") {
          input[i] = val;
        }
      }
      var end_clock = this.play_buffer.get_read_clock();
      var server_write_clock = null;
      if (end_clock !== null) {
        server_write_clock = end_clock - this.local_latency;
      }
      this.port.postMessage({
        type: "samples_out",
        samples: input,
        clock: server_write_clock,
      }, [input.buffer]);
      // End normal handling
    }

    if (this.synthetic_sink) {
      // Check that our output looks like sequential numbers for debugging
      this.check_synthetic_output(output);
    }
  }

  process(inputs, outputs) {
    var input = inputs[0][0];
    var output = outputs[0][0];

    if (!this.ready) {
      lib.log_every(100, "process_before_ready", LOG_ERROR, "tried to process before ready");
      return true;
    }

    try {
      if (this.latency_measurement_mode || this.mute_mode) {
        if (this.latency_measurement_mode) {
          this.process_latency_measurement(input, output);
        }
        // Fake out the real processing function
        input = new Float32Array(input.length);
        output = new Float32Array(output.length);
      }
      this.process_normal(input, output);
    } catch (ex) {
      this.port.postMessage({
        type: "exception",
        exception: ex
      });
      throw ex;
    }
    for (var chan = 1; chan < outputs[0].length; chan++) {
      outputs[0][chan].set(outputs[0][0]);
    }
    return true;
  }
}

registerProcessor('player', Player);

}
