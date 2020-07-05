const FRAME_SIZE = 128;  // by Web Audio API spec

class Player extends AudioWorkletProcessor {
  constructor () {
    super();
    this.local_clock = null;
    this.play_buffer = [];
    this.min_buffer_size = 150;  // in frames of 128 samples / about 3ms
    this.max_buffer_size = 250;
    this.underflow_count = 0;
    this.started = false;
    this.debug_ctr = 0;
    this.port.onmessage = (event) => {
      var play_samples = event.data[0];
      var play_clock = event.data[1];

      if (this.local_clock === null) {
        this.local_clock = play_clock;
      }

      if (this.debug_ctr % 10 == 0) {
        console.log("audio buffer length (samples): ", this.play_buffer.length, ", new input (samples): ", play_samples.length);
      }
      this.debug_ctr++;
      if (this.play_buffer.length >= FRAME_SIZE * this.max_buffer_size) {
        console.log("OVERFLOW");
        return;
      }
      this.play_buffer = this.play_buffer.concat(play_samples);
    }
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
      console.log("dropping frame to compensate for underflow");
      this.play_buffer = this.play_buffer.slice(FRAME_SIZE);
      this.underflow_count--;
    }
    if (this.play_buffer.length < FRAME_SIZE) {
      console.log("UNDERFLOW");
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
