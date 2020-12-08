// This trick allows us to load this file as a regular module, which in turn
//   allows us to flush it from the cache when needed, as a workaround for
//   https://bugs.chromium.org/p/chromium/issues/detail?id=880784 .
if (typeof AudioWorkletProcessor === "undefined") {
  console.info("Audio worklet module preloading");
  // If we are loaded as a regular module, skip the entire rest of the file
  //   (which will not be valid outside the audio worklet context).
} else {

console.info("Audio worklet module loading");

// XXX start copy-pasted imports from lib.js

var log_counts = {}
function log_every(n, tag, ...args) {
  if (tag.constructor != String) {
    console.error("In log_every, tag must be a string! Got:", n, tag, args);
    return;
  }

  if (log_counts[tag] === undefined) {
    log_counts[tag] = 0;
  }
  if (log_counts[tag] % n == 0) {
    console.debug("<" + tag + "/" + n + ">", ...args);
  }
  log_counts[tag]++;
}

function check(condition, message, ...rest) {
  if (!condition) {
    console.error(message, ...rest);
    throw new Error(message);
  }
}

// XXX start copy-pasted imports from audiochunk.js

class ClockReference {
    constructor({ sample_rate }) {
        check(sample_rate !== undefined, "Must provide sample_rate as a named argument");
        check(Number.isInteger(sample_rate), "sample_rate must be integer");

        this.sample_rate = sample_rate;
        this.type = this.constructor.name;
    }

    equals(other) {
        return this.side == other.side && this.sample_rate == other.sample_rate;
    }

    static thaw(o) {
        var rv = new ClockReference({
                sample_rate: o.sample_rate
            });
        return rv;
    }
}

class ClockInterval {
    constructor({ reference, end, length }) {
        check(reference !== undefined, "Must provide reference as a named argument");
        check(Number.isInteger(end), "end must be an integer (measured in samples)", end);
        check(Number.isInteger(length), "length must be an integer (measured in samples)", length);
        check(reference instanceof ClockReference, "reference must be a ClockReference", reference);

        this.end = end;
        this.length = length;
        this.reference = reference;
    }

    get sample_rate() {
        return this.reference.sample_rate;
    }

    get length_seconds() {
        return this.length / this.sample_rate;
    }

    get start() {
        return this.end - this.length;
    }

    static thaw(o) {
        if (o === undefined) {
            return o;
        }
        var rv = new ClockInterval({
            reference: ClockReference.thaw(o.reference),
            end: o.end,
            length: o.length
        });
        return rv;
    }
}

class AudioChunk {
      constructor({ data, interval }) {
        check(data !== undefined && interval !== undefined, "Must provide data and interval as named arguments");
        check(interval instanceof ClockInterval, "interval must be a ClockInterval");
        check(interval.reference instanceof ClockReference, "reference must be a ClockReference");
        check(data instanceof Float32Array, "uncompressed audio data must be a Float32Array");
        check(data.length == interval.length, "interval length must match uncompressed data length");
        this.data = data;
        this.interval = interval;
        this.type = this.constructor.name;
    }

    check_clock_reference(clock_reference) {
        if (!clock_reference.equals(this.reference)) {
            throw new Error("Clock references unequal in AudioChunk.check_clock_reference");
        }
    }

    get start() { return this.interval.start; }
    get end() { return this.interval.end; }
    get length() { return this.interval.length; }
    get length_seconds() { return this.interval.length_seconds; }
    get reference() { return this.interval.reference; }
    get sample_rate() { return this.interval.sample_rate; }

    static thaw(o) {
        var rv = new AudioChunk({
            data: o.data,
            interval: ClockInterval.thaw(o.interval),
        });
        return rv;
    }
}

class PlaceholderChunk {
    constructor({ reference, length, interval }){
        check(reference !== undefined && length !== undefined, "Must provide reference and length as named arguments");
        check(reference instanceof ClockReference, "reference must be a ClockReference");
        check(Number.isInteger(length), "length must be an integer");
        if (interval !== undefined) {
            check(interval.length == length, "interval must match length");
            check(interval.reference == reference, "interval must match reference");
        }

        this.reference = reference;
        this.length = length;
        this.interval = interval;
        this.data = new Float32Array(length);  // This exists for convenience but is always all zeros
        this.type = this.constructor.name;
    }

    check_clock_reference(clock_reference) {
        if (!clock_reference.equals(this.reference)) {
            throw new Error("Clock references unequal in PlaceholderChunk.check_clock_reference");
        }
    }

    get start() { return this.interval.start; }
    get end() { return this.interval.end; }
    get length_seconds() { return this.interval.length_seconds; }
    get sample_rate() { return this.reference.sample_rate; }

    static thaw(o) {
        var rv = new PlaceholderChunk({
            reference: ClockReference.thaw(o.reference),
            length: o.length,
            interval: ClockInterval.thaw(o.interval),
        });
        return rv;
    }
}

// XXX end copy-pasted imports

function thaw(o) {
  // This is the only type of object we will ever be sent.
  return AudioChunk.thaw(o);
}

const FRAME_SIZE = 128;  // by Web Audio API spec

let input_gain = 1.0;

class ClockedRingBuffer {
  constructor(len_seconds, leadin_seconds, clock_reference, port) {
    if (leadin_seconds > len_seconds) {
      // Note that even getting close is likely to result in failure.
      console.error("leadin time must not exceed size");
      throw new Error("leadin time must not exceed size");
    }
    // Before the first write, all reads will be zero. After the first write,
    // the first leadin_samples read will be zero, then real reads will start.
    // (This allows a buffer to build up.)

    // Round both to FRAME_SIZE.
    this.leadin_samples = Math.round(leadin_seconds * sampleRate / FRAME_SIZE) * FRAME_SIZE;
    this.len = Math.round(len_seconds * sampleRate / FRAME_SIZE) * FRAME_SIZE;

    this.read_clock = null;
    this.buf = new Float32Array(this.len);
    this.buf.fill(NaN);

    if (clock_reference.sample_rate !== sampleRate) {
      throw new Error("clock_reference has wrong sample rate in ClockedRingBuffer constructor");
    }
    this.clock_reference = clock_reference;

    this.port = port;

    this.read_callbacks = {};
    // For debugging, mostly
    this.buffered_data = 0;
    this.last_write_clock = null;
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
      console.error("Bad offset:", offset);
      throw "Bad offset:" + offset;
    }
    return real_offset;
  }

  read_into(buf) {
    //console.debug("Reading chunk of size", buf.length);
    if (this.read_clock === null) {
      buf.fill(0);
      return new PlaceholderChunk({
        reference: this.clock_reference,
        length: buf.length
      });
    }

    var interval = new ClockInterval({
      reference: this.clock_reference,
      end: this.read_clock + buf.length,
      length: buf.length
    });
    var chunk = new AudioChunk({ data: buf, interval });
    var errors = [];
    let underflowed = false;
    for (var i = 0; i < chunk.data.length; i++) {
      var sample = this.read(chunk.interval.start + i);
      if (typeof sample === "number") {
        chunk.data[i] = sample;
      } else if (sample === null) {
        chunk.data[i] = 0;
        underflowed = true;
      } else {
        chunk.data[i] = 0;
        errors.push(sample);
      }
    }
    if (underflowed) {
      // XXX this.port.postMessage({type: "underflow"});
    }
    if (errors.length > 0) {
      var err_uniq = Array.from(new Set(errors));
      console.error("Errors while reading chunk", interval, err_uniq);
      throw new Error("Failed to read audio chunk from buffer in worklet because: " + JSON.stringify(err_uniq));
    }
    return chunk;
  }

  read() {
    log_every(128000, "buf_read", "leadin_samples:", this.leadin_samples, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left());
    if (this.read_clock === null) {
      return "no read clock" ;
    }
    if (this.leadin_samples > 0) {
      this.read_clock++;
      this.leadin_samples--;
      return 0;
    }
    var val = this.buf[this.real_offset(this.read_clock)];
    if (isNaN(val)) {
      // XXX TODO: Seeing an underflow should make us allocate more client slack .... but that's tricky because it will cause a noticeable glitch on the server as our window expands (but at this point it's probably too late to prevent that)
      // * It would also make sense to instead just try to drop some audio and recover. (Although audio trapped in the audiocontext pipeline buffers cannot be dropped without restarting the whole thing.)
      // XXX this used to be an error log
      log_every(12800, "buf_read underflow", "Buffer underflow :-( leadin_samples:", this.leadin_samples, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left(), "last_write_clock:", this.last_write_clock);
      this.read_clock++;
      this.buffered_data--;
      return null;
    }
    this.buf[this.real_offset(this.read_clock)] = NaN;  // Mostly for debugging
    this.read_clock++;
    this.buffered_data--;
    if (this.read_clock in this.read_callbacks) {
      console.info("Firing callback at ", this.read_clock);
      this.read_callbacks[this.read_clock]();
      delete this.read_callbacks[this.read_clock];
    }
    return val;
  }

  write_chunk(chunk) {
    console.debug("SPAM", "Writing chunk of size", chunk.length);
    chunk.check_clock_reference(this.clock_reference);
    for (var i = 0; i < chunk.data.length; i++) {
      this.write(chunk.data[i], chunk.start + i);
    }
  }

  // XXX: fix performance (take an entire slice at once)
  write(value, write_clock) {
    check(write_clock == Math.round(write_clock), "write_clock not an integer?!", write_clock);
    if (this.last_write_clock !== null) {
      if (write_clock != this.last_write_clock + 1) {
        // Ostensibly we allow this, but I think it should never happen and is always a bug...
        console.error("Write clock not incrementing?! Last write clock:", this.last_write_clock, ", new write clock:", write_clock, ", difference from expected:", write_clock - (this.last_write_clock + 1));
        throw new Exception("Write clock skipped or went backwards");
      }
    }
    this.last_write_clock = write_clock;
    // XXX(slow): lib.log_every(12800, "buf_write", "write_clock:", write_clock, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left());
    if (this.read_clock === null) {
      // It should be acceptable for this to end up negative
      this.read_clock = write_clock - this.leadin_samples;
    }
    if (this.space_left() == 0) {
      // This is a "true" buffer overflow, we have actually run completely out of buffer.
      console.error("Buffer overflow :-( write_clock:", write_clock, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left());
      throw new Error("Buffer overflow");
    }
    if (!isNaN(this.buf[this.real_offset(write_clock)])) {
      // This is a "false" buffer overflow -- we are overwriting some past data that the reader skipped over (presumably due to an underflow.) Just write it anyway. (XXX: this should never happen I think, and I never observe it.)
      // XXX this used to be a warning log
      log_every(12800, "sorta_overflow", "Writing over existing buffered data; write_clock:", write_clock, "read_clock:", this.read_clock, "buffered_data:", this.buffered_data, "space_left:", this.space_left());
    }
    if (this.buffered_data >= 0) {
      this.buf[this.real_offset(write_clock)] = value;
    } else {
      // Don't write into the buffer if we're behind the read pointer, it will just fuck us up later when we wrap around to it
      log_every(12800, "compensated_underflow", "Compensating for underflow by discarding data until we reach the read pointer");
    }
    this.buffered_data++;
  }
}

class LatencyCalibrator {
  constructor() {
    // State related to peak detection processing:
    // clicks
    this.click_index = 0;
    this.beat_index = 0;
    const bpm = 105;
    this.click_frame_interval =
      Math.round(sampleRate / FRAME_SIZE * 60 / bpm);
    this.click_index_samples = 0;
    this.click_length_samples = sampleRate / 64;

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
    this.min_n_latencies = 3;

    this.latencies = [];
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

      if (this.latencies.length >= this.min_n_latencies) {
        this.sorted_latencies = this.latencies.slice();
        this.sorted_latencies.sort((a, b) => a-b);
        msg.p25 = this.sorted_latencies[Math.round(this.latencies.length * 0.25)];
        msg.p50 = this.sorted_latencies[Math.round(this.latencies.length * 0.5)];
        msg.p75 = this.sorted_latencies[Math.round(this.latencies.length * 0.75)];
      }
      return msg;
    }

    return null;
  }

  process_latency_measurement(input, output, click_volume) {
    this.click_index++;
    var is_beat = this.click_index % this.click_frame_interval == 0;
    if (is_beat) {
      this.frames_since_last_beat = 0;
      this.click_index_samples = 0;
      this.beat_index++;
    } else {
      this.frames_since_last_beat++;
    }

    const freq = 1024;
    const period = sampleRate / freq;

    for (var k = 0; k < output.length; k++) {
      if (this.click_index_samples < this.click_length_samples) {
        output[k] = click_volume * Math.sin(Math.PI * 2 * this.click_index_samples / period);
        this.click_index_samples++;
      } else {
        output[k] = 0;
      }
    }

    var now = Date.now();
    var noise = 0;
    var final_result = null;
    for (var i = 0 ; i < input.length; i++) {
      noise += Math.abs(input[i]);

      this.window.push(input[i]);
      if (this.window.length > this.window_size_samples) {
        this.window.shift();
      }

      if (this.background_noise > 0) {
        var result = this.detect_peak(i, now);
        if (result !== null) {
          final_result = result;
        }
      }
    }

    this.background_samples.push(noise);
    this.background_noise += noise;
    if (this.background_samples.length > this.max_background_samples) {
      // Note: if this ends up using too much CPU we can use a circular buffer.
      this.background_noise -= Math.abs(this.background_samples.shift());
    }

    if (this.beat_index > 1 && this.background_noise == 0) {
      final_result = {type: "no_mic_input"};
    }

    return final_result;
  }
}

class VolumeCalibrator {
  constructor() {
    this.volumes = [];
    this.block_volumes = [];
    this.finished = false;
  }

  process_volume_measurement(input) {
    if (this.finished) {
      return null;
    }

    let volume = 0;
    for (var i = 0 ; i < input.length; i++) {
      volume += Math.abs(input[i]);
    }
    this.volumes.push(volume / input.length);

    if (this.volumes.length == 100) {
      var block_volume = 0;
      for (var i = 0; i < this.volumes.length; i++) {
        block_volume += this.volumes[i];
      }
      block_volume = block_volume / this.volumes.length;
      this.block_volumes.push(block_volume / this.volumes.length);
      this.volumes = [];

      // About 5s.
      if (this.block_volumes.length == 18) {
        this.finished = true;
        this.block_volumes.sort((a,b) => a-b);

        // 90th percentile volume
        const volume_90th =
              this.block_volumes[Math.trunc(this.block_volumes.length * .9)]

        const target_avg = 0.0004;
        input_gain = Math.min(target_avg / volume_90th, 10);
        console.info("90th percentile avg volume: " + volume_90th +
                "; input_gain: " + input_gain);

        return {
          "type": "input_gain",
          "input_gain": input_gain
        }
      } else {
        return {
          "type": "current_volume",
          "volume": block_volume
        }
      }
    }

    return null;
  }
}

class Player extends AudioWorkletProcessor {
  constructor () {
    super();
    this.try_do(() => {
      console.info("Audio worklet object constructing");
      this.ready = false;
      this.port.onmessage = (event) => {
        this.try_do(() => {
          this.handle_message(event);
        });
      };
      this.clock_reference = new ClockReference({ sample_rate: sampleRate });
      this.local_latency = 150 * sampleRate / 1000;  // rough initial guess;
      this.click_volume = 0;
    })
  }

  try_do(callback) {
    try {
      callback();
    } catch (err) {
      let {name, message, stack, unpreventable} = err ?? {};
      [name, message, stack] = [name, message, stack].map(String);
      unpreventable = Boolean(unpreventable);
      this.port.postMessage({
        type: "exception",
        exception: {name, message, stack, unpreventable},
      });
    }
  }

  handle_message(event) {
    var msg = event.data;
    // console.debug("VERYSPAM", "handle_message in audioworklet:", msg);

    if (msg.type == "audio_params") {
      // Reset and/or set up everything.
      this.latency_calibrator = null;
      this.latency_measurement_mode = false;
      this.volume_measurement_mode = false;

      this.epoch = msg.epoch;

      this.synthetic_source = msg.synthetic_source;
      this.click_interval = msg.click_interval;
      this.loopback_mode = msg.loopback_mode;

      // This is _extra_ slack on top of the size of the server request.
      this.client_slack = 1; // XXX .500;  // 500ms

      // 15 seconds of total buffer, `this.client_slack` seconds of leadin
      this.play_buffer = new ClockedRingBuffer(15, this.client_slack, this.clock_reference, this.port);

      this.ready = true;
      return;
    } else if (msg.type == "stop") {
      this.ready = false;
      return;
    } else if (msg.type == "local_latency") {
      this.local_latency = msg.local_latency;
      return;
    } else if (msg.type == "latency_estimation_mode") {
      console.debug("latency estimation mode in worklet:", msg.enabled);
      this.latency_measurement_mode = msg.enabled;
      if (this.latency_measurement_mode) {
        this.latency_calibrator = new LatencyCalibrator();
      } else {
        this.latency_calibrator = null;
      }
      return;
    } else if (msg.type == "ignore_input") {
      this.ignore_input = msg.enabled;
      return;
    } else if (msg.type == "volume_estimation_mode") {
      this.volume_measurement_mode = msg.enabled;
      if (this.volume_measurement_mode) {
        this.volume_calibrator = new VolumeCalibrator();
      } else {
        this.volume_calibrator = null;
      }
      return;
    } else if (msg.type == "mic_pause_mode") {
      this.mic_pause_mode = msg.enabled;
      return;
    } else if (msg.type == "speaker_pause_mode") {
      this.speaker_pause_mode = msg.enabled;
      return;
    } else if (msg.type == "click_volume_change") {
      this.set_click_volume(msg.value/100);
      return;
    } else if (msg.type == "request_cur_clock") {
      this.port.postMessage({
        type: "cur_clock",
        clock: this.play_buffer.read_clock
      });
      return;
    } else if (msg.type == "set_alarm") {
      console.info("audio worklet setting alarm", msg);
      let cb = ()=>{ this.port.postMessage({type:"alarm",time:msg.time }) };
      if (msg.time > this.play_buffer.read_clock) {
        console.info("alarm is in future");
        this.play_buffer.read_callbacks[msg.time] = cb;
      } else {
        console.info("alarm is in past");
        cb();
      }
      return;
    } else if (!this.ready) {
      console.error("received message before ready:", msg);
      return;
    } else if (msg.type != "samples_in") {
      console.error("Unknown message:", msg);
      return;
    }

    var chunk = thaw(msg.chunk);
    this.play_buffer.write_chunk(chunk);
    // console.debug("VERYSPAM", "new play buffer:", this.play_buffer);
  }

  set_click_volume(linear_volume) {
    // https://www.dr-lex.be/info-stuff/volumecontrols.html
    this.click_volume = Math.exp(6.908 * linear_volume)/1000;
  }

  synthesize_clicks(input, interval) {
    // console.debug("VERYSPAM", "synthesizing clicks");
    if (!this.synthetic_source_counter) {
      console.info("Starting up clicks");
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

  process_normal(input, output) {
    //// console.debug("VERYSPAM", "process_normal:", input);
    if (this.synthetic_source == "CLICKS") {
      this.synthesize_clicks(input, this.click_interval);
    }

    if (this.loopback_mode === "worklet") {
      // Send input straight to output and do nothing else with it (only for debugging)
      output.set(input);
    } else {
      // Normal input/output handling
      var play_chunk = this.play_buffer.read_into(output);
      // console.debug("VERYSPAM", "about to play chunk:", play_chunk);

      if (this.synthetic_source == "ECHO") {
        // This is the "opposite" of local loopback: There, we take whatever
        //   we hear on the mic and send to the speaker, whereas here we take
        //   whatever we're about to send to the speaker, and pretend we
        //   heard it on the mic. (This has zero latency.)
        input.set(play_chunk.data());
      }

      var mic_chunk = null;
      if (!(play_chunk instanceof PlaceholderChunk) && !this.ignore_input) { 
        var interval = new ClockInterval({
          reference: play_chunk.reference,
          length: input.length,
          // This is where the magic happens: outgoing chunks are timestamped NOT
          //   with when we got them, but with when we got the incoming audio
          //   that aligns them.
          end: play_chunk.end - this.local_latency,
        });

        for (var i = 0; i < input.length; i++) {
          input[i] *= input_gain;
        }

        mic_chunk = new AudioChunk({
          data: input,
          interval
        });
      } else {
        mic_chunk = new PlaceholderChunk({
          reference: play_chunk.reference,
          length: input.length
        });
      }

      // console.debug("VERYSPAM", "about to return heard chunk:", mic_chunk);
      this.port.postMessage({
        epoch: this.epoch,
        jank: this.acc_err,
        type: "samples_out",
        chunk: mic_chunk,
      }); // XXX don't transfer , [mic_chunk.data.buffer]);
      // End normal handling
    }
  }

  profile_web_audio() {
    var now_ms = Date.now();
    const process_history_len = 100;
    if (this.process_history_ms === undefined) {
      this.bad_sample_rate = 0;
      this.acc_err = 0;
      this.process_history_ms = new Array(process_history_len).fill(NaN);
    } else if (!isNaN(this.process_history_ms[0])) {
      var interval = now_ms - this.process_history_ms[0];
      var target_interval = process_history_len * 128 * 1000 / sampleRate;
      var err = interval - target_interval;
      var eff_rate = process_history_len * 128 * 1000 / interval;
      this.acc_err += err / process_history_len;
      log_every(500, "profile_web_audio", sampleRate, eff_rate, this.process_history_ms[0], now_ms, interval, target_interval, err, this.acc_err, this.acc_err / (128 * 1000 / 22050 /* XXX... */));

      // other parameters of interesst
      // XXX // console.debug("VERYSPAM", currentTime, currentFrame, /* getOutputTimestamp(), performanceTime, contextTime*/);

      if (eff_rate < 0.75 * sampleRate) {
        if (this.bad_sample_rate == 0) {
          console.warn("BAD SAMPLE RATE, WEB AUDIO BUG? Should be", sampleRate, "but seeing", eff_rate, ". Will try restarting momentarily if this persists.");
        }
        this.bad_sample_rate += 1;
        if (this.bad_sample_rate > 2000) {
          console.warn("SAMPLE RATE STILL BAD. Should be", sampleRate, "but seeing", eff_rate, ". Restarting app.");
          // Ask the main app to reload the audio input device
          this.killed = true;
          throw {
            message: "Your computer's audio system is lagging a lot, which is breaking the app. Please disconnect any bluetooth headphones or speakers, close unnecessary apps / reduce load on your computer, then refresh the page and try again.",
            unpreventable: true,
          };
        }
      }
    }
    this.process_history_ms.push(now_ms);
    this.process_history_ms.shift();
  }

  process(inputs, outputs) {
    let keep_alive = false;
    this.try_do(() => {
      // Gather some stats, and restart if things look wonky for too long.
      this.profile_web_audio()

      if (this.killed) {
        return;
      }
      if (!this.ready) {
        keep_alive = true;
        return;
      }

      if (!inputs || !inputs[0] || !inputs[0][0] || !outputs || !outputs[0] || !outputs[0][0]) {
        // Firefox has `inputs[0] == []` sometimes when first starting up; it
        //   may or may not arguably be permitted by the standard; in any case
        //   we ignore it and continue.
        //   * https://bugzilla.mozilla.org/show_bug.cgi?id=1629478
        keep_alive = true;
        return;
      }
      var input = inputs[0][0];
      var output = outputs[0][0];

      if (this.latency_measurement_mode) {
        var calibration_result = this.latency_calibrator.process_latency_measurement(input, output, this.click_volume);
        if (calibration_result !== null) {
          calibration_result.jank = this.acc_err;
          this.port.postMessage(calibration_result);
        }
        // Don't even send or receive audio in this mode.
      } else if (this.volume_measurement_mode) {
        var calibration_result = this.volume_calibrator.process_volume_measurement(input);
        if (calibration_result !== null) {
          this.port.postMessage(calibration_result);
        }
        output = new Float32Array(output.length);
      } else {
        if (this.mic_pause_mode || this.ignore_input) {
          // Mute the microphone by replacing the input with zeros.
          input = new Float32Array(input.length);
        }
        if (this.speaker_pause_mode) {
          // Mute the speaker by setting the output to empty.
          output = new Float32Array(output.length);
        }
        this.process_normal(input, output);
      }
      // Handle stereo output by cloning mono output.
      for (var chan = 1; chan < outputs[0].length; chan++) {
        outputs[0][chan].set(outputs[0][0]);
      }
      keep_alive = true;
    });
    return keep_alive;
  }
}

registerProcessor('player', Player);

}
