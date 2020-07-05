
class Player extends AudioWorkletProcessor {

  constructor () {
    super();
    this.queue = [];
    this.min_buffer_size = 100;
    this.started = false;
    this.debug_ctr = 0;
    this.port.onmessage = (event) => {
      if (this.debug_ctr % 100 == 0) {
        console.log("pushed to length ", this.queue.length);
      }
      this.debug_ctr++;
      this.queue = this.queue.concat(event.data);
    }
  }
  process (inputs, outputs, parameters) {
    this.frame_size = inputs[0][0].length;
    this.port.postMessage(Array.from(inputs[0][0]));
    if (this.queue.length < this.frame_size * this.min_buffer_size && !this.started) {
      return true;
    }
    this.started = true;
    if (this.queue < this.frame_size) {
      console.log("UNDERFLOW");
      return true; // hack
    }
    var samples = this.queue.slice(0, this.frame_size);
    this.queue = this.queue.slice(this.frame_size);
    for (var chan = 0; chan < outputs[0].length; chan++) {
      for (var i = 0; i < samples.length; i++) {
        outputs[0][chan][i] = samples[i];
      }
    }
    return true;
  }
}

registerProcessor('player', Player)
