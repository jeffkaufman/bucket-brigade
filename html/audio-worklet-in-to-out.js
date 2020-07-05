
class Player extends AudioWorkletProcessor {

  constructor () {
    super();
    this.queue = [];
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
    this.port.postMessage(Array.from(inputs[0][0]));
    if (this.queue.length < 100 && !this.started) {
      return true;
    }
    this.started = true;
    var samples = this.queue.shift();
    if (!samples) {
      console.log("UNDERFLOW");
      return true; // hack
    }
    for (var chan = 0; chan < outputs[0].length; chan++) {
      for (var i = 0; i < samples.length; i++) {
        outputs[0][chan][i] = samples[i];
      }
    }
    return true;
  }
}

registerProcessor('player', Player)
