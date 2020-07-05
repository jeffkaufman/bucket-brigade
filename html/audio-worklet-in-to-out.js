const FRAME_SIZE = 128;  // by Web Audio API spec

class Player extends AudioWorkletProcessor {
  constructor () {
    super();
    this.queue = [];
    this.min_buffer_size = 2;  // in frames of 128 samples / about 3ms
    this.started = false;
    this.debug_ctr = 0;
    this.port.onmessage = (event) => {
      if (this.debug_ctr % 10 == 0) {
        console.log("audio buffer length (samples): ", this.queue.length, ", new input (samples): ", event.data.length);
      }
      this.debug_ctr++;
      this.queue = this.queue.concat(event.data);
    }
  }
  process (inputs, outputs, parameters) {
    this.port.postMessage(Array.from(inputs[0][0]));
    // Buffer a bit before we get started.
    if (this.queue.length < FRAME_SIZE * this.min_buffer_size && !this.started) {
      return true;
    }
    this.started = true;
    if (this.queue < FRAME_SIZE) {
      console.log("UNDERFLOW");
      return true; // hack
    }
    var samples = this.queue.slice(0, FRAME_SIZE);
    this.queue = this.queue.slice(FRAME_SIZE);
    for (var chan = 0; chan < outputs[0].length; chan++) {
      for (var i = 0; i < samples.length; i++) {
        outputs[0][chan][i] = samples[i];
      }
    }
    return true;
  }
}

registerProcessor('player', Player)
