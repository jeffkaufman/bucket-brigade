const FRAME_SIZE = 128;  // by Web Audio API spec

class Player extends AudioWorkletProcessor {
  constructor () {
    super();
    this.min_buffer_size = 1;  // in chunks of SAMPLE_BATCH_SIZE frames of 128 samples each
    this.max_buffer_size = 2
    this.queue = [];
    this.offset = 0;
    this.underflow_skip = 0;
    this.started = false;
    this.debug_ctr = 0;
    this.port.onmessage = (event) => {
      if (this.debug_ctr % 10 == 0) {
        console.log("audio buffer length (chunks of SAMPLE_BATCH_SIZE frames of 128 samples each): ", this.queue.length, ", new input (samples): ", event.data.length);
      }
      this.debug_ctr++;
      if (this.queue.length == this.max_buffer_size) {
        console.log("OVERFLOW");
        return;
      }
      this.queue.push(event.data);
    }
  }

  process (inputs, outputs, parameters) {
    // Transfer input data (don't copy) to main thread.
    this.port.postMessage(inputs[0][0], [inputs[0][0].buffer]);
    // Buffer a bit before we get started.
    if (this.queue.length < this.min_buffer_size && !this.started) {
      return true;
    }
    this.started = true;
    while (this.queue.length > 0 && this.underflow_skip > 0) {
      console.log("skip to compensate underflow");
      this.underflow_skip--;
      this.offset += FRAME_SIZE;
      if (this.offset == this.queue[0].length) {
        this.offset = 0;
        this.queue = this.queue.slice(1);
      }
    }
    if (this.queue.length == 0) {
      console.log("UNDERFLOW");
      this.underflow_skip++;
      this.started = false;  // Build back up to minimum buffer
      return true;
    }
    for (var chan = 0; chan < outputs[0].length; chan++) {
      outputs[0][chan].set(this.queue[0].slice(this.offset, this.offset +  FRAME_SIZE));
    }
    this.offset += FRAME_SIZE;
    if (this.offset == this.queue[0].length) {
      this.offset = 0;
      this.queue = this.queue.slice(1);
    }
    return true;
  }
}

registerProcessor('player', Player)
