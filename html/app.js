import {check} from './lib.js';

import {ServerConnection, FakeServerConnection} from './net.js';
import {AudioChunk, CompressedAudioChunk, AudioChunkBase, PlaceholderChunk, concat_chunks, ClockInterval, ClientClockReference, ServerClockReference} from './audiochunk.js';

// Work around some issues related to caching and error reporting
//   by forcing this to load up top, before we try to 'addModule' it.
import './audio-worklet.js';

// We fall back exponentially until we find a good size, but we need a
// place to start that should be reasonably fair.
const INITIAL_MS_PER_BATCH = 600; // XXX 180;  // XXX: probably make sure this is a multiple of our opus frame size (60ms), but it should in theory work without
// If we have fallen back so much that we are now taking this long,
// then give up and let the user know things are broken.
const MAX_MS_PER_BATCH = 900;

// this must be 2.5, 5, 10, 20, 40, or 60.
const OPUS_FRAME_MS = 60;

// don't let people be louder than this
const TARGET_MAX_RMS_VOL = 20;

// This gates all the logs that put references to REALLY HUGE objects into the console
//   very frequently. When this is on, having the console open eventually causes the
//   browser to lag severely and dev tools to lag/hang/crash. Don't use this unless
//   you actually need it.
const LOG_ULTRA_VERBOSE = false;
// XXX:
console.debug = () => {}

function close_stream(stream) {
  stream.getTracks().forEach((track) => track.stop());
}


// Will optimistically request mic permissions as soon as it's constructed, but will not actually enumerate mics until asked for them.
export class MicEnumerator {
  async force_permission_prompt() {
    // In order to enumerate devices, we must first force a permission prompt by opening a device and then closing it again.
    // See: https://stackoverflow.com/questions/60297972/navigator-mediadevices-enumeratedevices-returns-empty-labels
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    close_stream(stream);
  }

  async wait_for_mic_permissions() {
    var perm_status = await navigator.permissions.query({name: "microphone"}).catch(() => null);
    if (!perm_status) {
      this.force_permission_prompt();
      return;
    }
    if (perm_status.state == "granted" || perm_status.state == "denied") {
      return;
    }
    this.force_permission_prompt();
    return new Promise((resolve, reject) => {
      perm_status.onchange = (e) => {
        if (e.target.state == "granted" || e.target.state == "denied") {
          resolve();
        }
      }
    });
  }

  constructor() {
    // Start the process but don't actually await since this is a constructor.
    this.wait_for_mic_permissions();
  }

  async mics() {
    try {
      await this.wait_for_mic_permissions();
      var devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      console.error("Failed to get mics:", e);
      return undefined;
    }
    return devices.filter(d => d.kind === 'audioinput');
  }
}

export async function openMic(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,  // Unfortunately this tends to kill long held notes, which is bad; but people's levels being wildly different is also bad. Manage it ourselves?
        deviceId: { exact: deviceId }
      }
    });
  } catch (e) {
    console.error("Unable to open specified mic device", deviceId);
    return undefined;
  }
}

// NOTE NOTE NOTE:
// * All `clock` variables are measured in samples.
// * All `clock` variables represent the END of an interval, NOT the
//   beginning. It's arbitrary which one to use, but you have to be
//   consistent, and trust me that it's slightly nicer this way.
var server_connection;
var loopback_mode;

// XXX: I'm pretty sure these are dead, not sure if they wish to be revived.
var synthetic_audio_source;
var synthetic_click_interval;

class AudioEncoder {
  constructor(path) {
    this.worker = new Worker(path);
    this.client_clock = null;
    this.server_clock = null;
    this.next_request_id = 0;
    this.request_queue = [];
    this.worker.onmessage = this.handle_message.bind(this);
  }

  handle_message(ev) {
    if (ev.data?.type === 'exception') {
      throw ev.data.exception;
    }
    if (this.request_queue.length == 0) {
      // This may happen if we were reset, and is okay.
      console.warn("AudioEncoder got response when no requests in flight", ev);
      return;
    }
    var response_id = ev.data.request_id;
    if(this.request_queue[0][0] != response_id) {
      // This may happen if we were reset, and is okay.
      console.warn("AudioEncoder got response not matching first in-flight request, discarding", ev, this.request_queue[0]);
      return;
    }
    var queue_entry = this.request_queue.shift();
    if (ev.data.status != 0) {
      throw new Error("AudioEncoder RPC failed: " + JSON.stringify(ev.data));
    }
    queue_entry[1](ev.data);
  }

  async worker_rpc(msg, transfer) {
    var request_id = this.next_request_id;
    var _this = this;
    this.next_request_id += 1;
    return new Promise(function (resolve, _) {
      _this.request_queue.push([request_id, resolve]);
      // console.debug("VERYSPAM", "Posting to port", _this.worker, "msg", msg, "transfer", transfer);
      _this.worker.postMessage({ request_id, ...msg }, transfer);
    });
  }

  // MUST be called AND COMPLETE before ANY other RPCs
  async setup(cfg) {
    this.client_clock_reference = new ClientClockReference({
      sample_rate: cfg.sampling_rate
    });
    this.server_clock_reference = new ServerClockReference({
      sample_rate: cfg.codec_sampling_rate || 48000  // keep in sync with encoder.js
    })
    this.queued_chunk = null;
    return this.worker_rpc(cfg);
  }

  async encode_chunk(chunk) {
    chunk.check_clock_reference(this.client_clock_reference);
    check(this.client_clock === null || !(chunk instanceof PlaceholderChunk), "Can't send placeholder chunks once clock has started");

    if (this.queued_chunk !== null) {
      chunk = concat_chunks([this.queued_chunk, chunk]);
      this.queued_chunk = null;
    }

    if (chunk instanceof PlaceholderChunk) {
      var result_length = Math.round(chunk.length / this.client_clock_reference.sample_rate * this.server_clock_reference.sample_rate);
      var opus_samples = OPUS_FRAME_MS * this.server_clock_reference.sample_rate / 1000;
      var send_length = Math.round(result_length / opus_samples) * opus_samples;

      // This is ugly.
      var leftover_length = Math.round((result_length - send_length) * this.client_clock_reference.sample_rate / this.server_clock_reference.sample_rate);
      if (leftover_length > 0) {
        this.queued_chunk = new PlaceholderChunk({
          reference: this.client_clock_reference,
          length: leftover_length
        });
      }

      return new PlaceholderChunk({
        reference: this.server_clock_reference,
        length: send_length
      });
    }

    if (this.client_clock === null) {
      this.client_clock = chunk.start;

      // This isn't ideal, but the notion is that we only do this once, so there is no accumulating rounding error.
      this.server_clock = Math.round(this.client_clock
        / this.client_clock_reference.sample_rate
        * this.server_clock_reference.sample_rate);
    }
    if (this.client_clock != chunk.start) {
      throw new Error("Cannot encode non-contiguous chunks!");
    }
    this.client_clock = chunk.end;

    var { packets, samples_encoded, buffered_samples } = await this.encode({
      samples: chunk.data
    });

    this.server_clock += samples_encoded
    // At this point server_clock is behind chunk.end by buffered_samples, the amount of stuff remaining buffered inside the encoder worker
    var server_clock_adjusted = this.server_clock + buffered_samples;
    var client_clock_hypothetical = server_clock_adjusted / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate;

    // XXX: we'll see about this? I believe as long as the resampler is buffering correctly, this should never exceed 1, and should not be subject to accumulated roundoff error.
    // NOTE: We have to use chunk.end here, and not this.client_clock, which may have moved on while we were waiting for the decoder.
    console.debug("SPAM", "net sample rate clock error:", chunk.end - client_clock_hypothetical);
    if (Math.abs(chunk.end - client_clock_hypothetical) > 5 /* arbitrary */) {
      console.warn("Sample rate clock slippage excessive in encoder; why is this happening?", chunk.end, client_clock_hypothetical, this.server_clock, buffered_samples, server_clock_adjusted, this.server_clock_reference.sample_rate, this.client_clock_reference.sample_rate);
      // TODO: Is this error always spurious? What should we do here, or how should we prevent it?
      // throw new Error("sample rate clock slippage excessive; what happened?");
    }

    var enc_buf = [];
    packets.forEach((packet) => {
      enc_buf.push(new Uint8Array(packet.data));
    });
    var outdata = pack_multi(enc_buf);

    var result_interval = new ClockInterval({
      reference: this.server_clock_reference,
      end: this.server_clock,
      length: samples_encoded
    });
    return new CompressedAudioChunk({
      interval: result_interval,
      data: outdata
    });
  }

  async encode(in_data) {
    var data = await this.worker_rpc(in_data);
    if (data.packets === undefined) {
      throw new Error("encode returned no packets:" + JSON.stringify(data));
    }
    return data;
  }

  async reset() {
    this.client_clock = null;
    this.server_clock = null;
    this.request_queue = [];
    return this.worker_rpc({
      reset: true
    });
  }
}

class AudioDecoder {
  constructor(path) {
    this.worker = new Worker(path);
    this.server_clock = null;
    this.client_clock = null;
    this.next_request_id = 0;
    this.request_queue = [];
    this.worker.onmessage = this.handle_message.bind(this);
  }

  handle_message(ev) {
    if (ev.data?.type === 'exception') {
      throw ev.data.exception;
    }
    if (this.request_queue.length == 0) {
      // This may happen if we were reset, and is okay.
      console.warn("AudioDecoder got response when no requests in flight", ev);
      return;
    }
    var response_id = ev.data.request_id;
    if(this.request_queue[0][0] != response_id) {
      // This may happen if we were reset, and is okay.
      console.warn("AudioDecoder got response not matching first in-flight request, discarding", ev, this.request_queue[0]);
      return;
    }
    var queue_entry = this.request_queue.shift();
    if (ev.data.status != 0) {
      throw new Error("AudioDecoder RPC failed: " + JSON.stringify(ev.data));
    }
    queue_entry[1](ev.data);
  }

  async worker_rpc(msg, transfer) {
    var request_id = this.next_request_id;
    var _this = this;
    this.next_request_id += 1;
    return new Promise(function (resolve, _) {
      _this.request_queue.push([request_id, resolve]);
      // console.debug("VERYSPAM", "Posting to port", _this.worker, "msg", msg, "transfer", transfer);
      _this.worker.postMessage({ request_id, ...msg }, transfer);
    });
  }

  // MUST be called before ANY other RPCs
  async setup(cfg) {
    this.client_clock_reference = new ClientClockReference({
      sample_rate: cfg.sampling_rate
    });
    this.server_clock_reference = new ServerClockReference({
      sample_rate: cfg.codec_sampling_rate || 48000  // keep in sync with decoder.js
    })
    return this.worker_rpc(cfg);
  }

  async reset() {
    this.client_clock = null;
    this.server_clock = null;
    this.request_queue = [];
    return this.worker_rpc({
      reset: true
    });
  }

  async decode_chunk(chunk) {
    chunk.check_clock_reference(this.server_clock_reference);

    if (chunk instanceof PlaceholderChunk) {
      var result_interval = new ClockInterval({
        reference: this.client_clock_reference,
        length: Math.round(chunk.length / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate),
        end: Math.round(chunk.end / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate),
      });
      // Wrap this in a promise so that it resolves asynchronously and does not return "too fast".
      // XXX doesn't help
      return Promise.resolve(new PlaceholderChunk({
        reference: result_interval.reference,
        length: result_interval.length,
        interval: result_interval
      }));
    }

    if (this.server_clock === null) {
      this.server_clock = chunk.start;

      // This isn't ideal, but the notion is that we only do this once, so there is no accumulating rounding error.
      this.client_clock = Math.round(this.server_clock
        / this.server_clock_reference.sample_rate
        * this.client_clock_reference.sample_rate);
    }
    if (this.server_clock != chunk.start) {
      throw new Error("Cannot decode non-contiguous chunks!");
    }
    this.server_clock = chunk.end;

    var indata = chunk.data;
    var packets = unpack_multi(indata);

    // Make all the calls FIRST, and THEN gather the results. This will prevent us from interleaving with other calls to decode_chunk. (Assuming certain things about in-order dispatch and delivery of postMessage, which I hope are true.)
    // console.debug("VERYSPAM", "Starting to decode sample packets", packets);
    var decoding_promises = [];
    for (var i = 0; i < packets.length; ++i) {
      decoding_promises.push(this.decode({
        data: packets[i].buffer
      }));
    }

    // console.debug("VERYSPAM", "Forcing decoding promises", decoding_promises);
    var decoded_packets = [];
    for (var i = 0; i < decoding_promises.length; ++i) {
      var p_samples = await decoding_promises[i];
      // console.debug("VERYSPAM", "Decoded samples:", p_samples);
      decoded_packets.push(new Float32Array(p_samples.samples));
    }

    var play_samples = concat_typed_arrays(decoded_packets, Float32Array);
    var decoded_length_expected = chunk.length / chunk.reference.sample_rate * this.client_clock_reference.sample_rate;
    // XXX: This is janky, in reality our chunk length divides evenly so it should be 0, if it doesn't I'm not sure what we should expect here?
    check(Math.abs(decoded_length_expected - play_samples.length) < 5, "Chunk decoded to wrong length!", chunk, play_samples);
    this.client_clock += play_samples.length;
    if (LOG_ULTRA_VERBOSE) {
      console.debug("SPAM", "Decoded all samples from server:", decoded_packets);
    }

    var result_interval = new ClockInterval({
      reference: this.client_clock_reference,
      end: this.client_clock,
      length: play_samples.length
    });
    return new AudioChunk({
      interval: result_interval,
      data: play_samples
    });
  }

  async decode(packet) {
    return await this.worker_rpc(packet, [packet.data]);
  }
}

export class BucketBrigadeContext extends EventTarget {
  constructor(options) {
    var {micStream} = options;
    super();

    this.audioCtx = null;
    this.worklet_is_ready = null;
    this.worklet_cookie = null;
    this.micNode = null;
    this.playerNode = null;
    this.encoder = null;
    this.decoder = null;
    this.encoding_latency_ms = null;
    this.micStream = micStream;
  }

  ms_to_samples(ms) {
    return this.audioCtx.sampleRate * ms / 1000;
  }

  samples_to_ms(samples) {
    return samples * 1000 / this.audioCtx.sampleRate;
  }

  ms_to_batch_size(ms) {
    return Math.round(this.ms_to_samples(ms) / 128);
  }

  batch_size_to_ms(batch_size) {
    return Math.round(this.samples_to_ms(batch_size * 128));
  }

  set_estimate_latency_mode(mode) {
    this.playerNode.port.postMessage({
      "type": "latency_estimation_mode",
      "enabled": mode
    });
  }

  send_ignore_input(mode) {
    this.playerNode.port.postMessage({
      "type": "ignore_input",
      "enabled": mode
    });
  }

  set_estimate_volume_mode(mode) {
    this.playerNode.port.postMessage({
      "type": "volume_estimation_mode",
      "enabled": mode
    });
  }

  click_volume_change(click_volume) {
    this.playerNode.port.postMessage({
      "type": "click_volume_change",
      "value": click_volume,
    });
  }

  set_mic_pause_mode(mode) {
    this.playerNode.port.postMessage({
      "type": "mic_pause_mode",
      "enabled": mode
    });
  }

  set_speaker_pause_mode(mode) {
    this.playerNode.port.postMessage({
      "type": "speaker_pause_mode",
      "enabled": mode
    });
  }

  unsubscribe_and_stop_worklet() {
    if (!this.active_handler) {
      console.warn("Tried to unsubscribe worklet, but nothing was subscribed!");
      // Continue anyway so that we stop the worklet, just in case; remove will
      //   fail silently
    }
    this.removeEventListener("workletMessage_", this.active_handler);
    this.active_handler = null;
    this.worklet_is_ready = false;  // This will immediately stop processing of inbound messages from the worklet (which shouldn't be required, but is conservative.)
    this.worklet_cookie = null;
    this.playerNode.port.postMessage({
      type: "stop"
    });
  }

  subscribe_and_start_worklet(handler) {
    if (this.active_handler) {
      console.error("Cannot have multiple active audio handlers on BucketBrigadeContext");
      return;
    }

    this.addEventListener("workletMessage_", handler);
    this.active_handler = handler
    this.worklet_is_ready = false;
    this.worklet_cookie = Math.round(Math.random() * 2**32);

    var audio_params = {
      type: "audio_params",
      synthetic_source: synthetic_audio_source,
      click_interval: synthetic_click_interval,
      cookie: this.worklet_cookie,
      loopback_mode,
    }
    // This will reset the audio worklet, flush its buffer, and start it up again.
    this.playerNode.port.postMessage(audio_params);
  }

  send_local_latency(local_latency_ms) {
    //var local_latency_ms = parseFloat(estLatency.innerText);

    // Account for the (small) amount of latency added by opus and the speex resampler.
    local_latency_ms += this.encoding_latency_ms;

    // Convert from ms to samples.
    var local_latency = Math.round(local_latency_ms * this.audioCtx.sampleRate / 1000); // XXX

    if (synthetic_audio_source) {
      local_latency = 0;
    }

    console.info("Sending local latency:", local_latency_ms, local_latency);
    this.playerNode.port.postMessage({
      "type": "local_latency",
      "local_latency": local_latency,
    });
  }

  send_input_gain(input_gain) {
    console.info("Sending input gain:", input_gain);
    this.playerNode.port.postMessage({
      type: "input_gain",
      input_gain,
    });
  }

  samples_to_worklet(chunk) {
    var message = {
      type: "samples_in",
      chunk,
    };

    if (LOG_ULTRA_VERBOSE) {
      console.debug("SPAM", "Posting to worklet:", message);
    }
    this.playerNode.port.postMessage(message);  // XXX huh, we aren't using transfer, and plausibly should be
  }

  handle_message(event) {
    var msg = event.data;
    if (msg.type === "exception") {
      throw msg.exception;
    }
    if (this.worklet_is_ready === null) {
        throw new Error("Worklet has not been started in SingerClient handle_message?");
    }
    if (msg.type === "ready" && msg.cookie === this.worklet_cookie) {
        this.worklet_is_ready = true;
        return;
    }
    if (this.worklet_is_ready === false) {
        // This will happen a lot
        // console.debug("Worklet is not ready, dropping messsage.");
        return;
    }
    this.dispatchEvent(new CustomEvent("workletMessage_", {
      detail: {
        msg
      }
    }));
    return;
  }

  silentMediaStream() {
    let ctx = this.audioCtx;
    let oscillator = ctx.createOscillator();
    let dst = oscillator.connect(ctx.createMediaStreamDestination());
    oscillator.start();
    dst.stream.getAudioTracks()[0].enabled = false;
    return dst.stream;
  }

  async start_bucket() {
    //switch_app_state(APP_STARTING);

    if (this.audioCtx) {
      throw new Error("NOT RUNNING, BUT ALREADY HAVE AUDIOCTX?");
      return;
    }

    // Do NOT set the sample rate to a fixed value. We MUST let the audioContext use
    // whatever it thinks the native sample rate is. This is becuse:
    // * Firefox does not have a resampler, so it will refuse to operate if we try
    //   to force a sample rate other than the native one
    // * Chrome does have a resampler, but it's buggy and has a habit of dropping
    //   frames of samples under load, which fucks everything up. (Note that even
    //   without resampling, Chrome still has a habit of dropping frames under
    //   load, but it happens a heck of a lot less often.)
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioContext({latencyHint: 'playback'});
    //sampleRate.value = this.audioCtx.sampleRate;
    console.debug("Audio Context:", this.audioCtx);

    // XXX: this all gets kind of gross with 44100, nothing divides nicely.
    // XXX: this should really be on the clients, not the context?
    this.sample_batch_size = this.ms_to_batch_size(INITIAL_MS_PER_BATCH);
    //window.msBatchSize.value = INITIAL_MS_PER_BATCH;

    console.log("micStream is", this.micStream);
    if (this.micStream === null) {
      this.micStream = this.silentMediaStream();
      console.log("No mic, using silence, micstream is now:", this.micStream);
    }
    try {
      this.micNode = new MediaStreamAudioSourceNode(this.audioCtx, { mediaStream: this.micStream });
    }
    catch (e) {
      alert("Please click the lock to the left of the URL, set 'Microphone' to 'Allow', and then click 'OK'");
      window.location.reload();
    }

    //XXX: the AudioWorkletProcessor just seems to get leaked here, every time we stop and restart. I'm not sure if there's a way to prevent that without reloading the page... (or avoiding reallocating it when we stop and start.)
    await this.audioCtx.audioWorklet.addModule('audio-worklet.js');
    try {
      this.playerNode = new AudioWorkletNode(this.audioCtx, 'player');
    } catch (e) {
      // This is insane and cannot possibly happen, however we observe it in
      //   production: "InvalidStateError: Failed to construct 'AudioWorkletNode':
      //   AudioWorkletNode cannot be created: The node name 'player' is not
      //   defined in AudioWorkletGlobalScope."
      //
      // As a hack, just wait a moment and try again:
      await new Promise(function(resolve){
        setTimeout(async function() {
          await this.audioCtx.audioWorklet.addModule('audio-worklet.js');
          this.playerNode = new AudioWorkletNode(this.audioCtx, 'player');
          resolve();
        }, 500);
      });
    }

    // XXX: this encoder decoder crap should probably all live in the SingerClient?
    // Avoid starting more than one copy of the encoder/decoder workers.
    if (!this.encoder) {
      this.encoder = new AudioEncoder('worker-encoder.js');
      var enc_cfg = {
          sampling_rate: this.audioCtx.sampleRate,  // This instructs the encoder what sample rate we're giving it. If necessary (i.e. if not equal to 48000), it will resample.
          num_of_channels: 1,
          frame_duration: OPUS_FRAME_MS,
      };
      console.debug("Setting up opus encoder. Encoder params:", enc_cfg);
      var { status, resampling } = await this.encoder.setup(enc_cfg);
      if (status != 0) {
        throw new Error("Encoder setup failed");
      }

      /** ENCODING/DECODING LATENCY NOTES:
        * In most normal modes, Opus adds a total of 6.5ms across encoding and decoding.
          * (see https://en.wikipedia.org/wiki/Opus_(audio_format) .)

        * Resampler latency figures from https://lastique.github.io/src_test/
          * (https://web.archive.org/web/20200918060257/https://lastique.github.io/src_test/):
          * For quality 5 (we are here), 0.8 - 1ms.
          * For quality 10, 2.6 - 3ms.

        * We run the resampler in both direction (if the system is not 48k), giving about 8.3ms of
          total added latency. (We can count the encoding and decoding together, even though they
          happen separately, because latency coming or going has the same effect.)
          * This is low enough that we SHOULD be ok to ignore it, but we will add it in to be sure.
      */

      this.encoding_latency_ms = 6.5;  // rudely hardcoded opus latency
      if (resampling) {
        this.encoding_latency_ms += 1.8;
      }
    }
    this.encoder.reset();

    if (!this.decoder) {
      this.decoder = new AudioDecoder('worker-decoder.js')
      var dec_cfg = {
          sampling_rate: this.audioCtx.sampleRate,  // This instructs the decoder what sample rate we want from it. If necessary (i.e. if not equal to 48000), it will resample.
          num_of_channels: 1,
          // Frame duration will be derived from the encoded data.
      };
      console.debug("Setting up opus decder. Decoder params:", dec_cfg);
      await this.decoder.setup(dec_cfg);
    }
    this.decoder.reset();

    // The encoder stuff absolutely has to finish getting initialized before we start getting messages for it, or shit will get regrettably real. (It is designed in a non-threadsafe way, which is remarkable since javascript has no threads.)

    this.playerNode.port.onmessage = this.handle_message.bind(this);
    this.micNode.connect(this.playerNode);
    this.playerNode.connect(this.audioCtx.destination);
  }

  close() {
    console.info("Closing BucketBrigadeContext");
    this.micNode.disconnect();
    this.micNode = null;
    this.playerNode.disconnect();
    this.playerNode = null;
    close_stream(this.micStream);
    this.micStream = null;
    this.audioCtx.close();
    this.audioCtx = null;
    this.encoder = null;
    this.decoder = null;
    console.info("Closed BucketBrigadeContext");
  }

  async reload_settings(startup) {
    // XXX: this function is dead and no longer called, but still need to figure out where alarm/hook stuff goes.

    alarms_fired = {};
    for (let hook of start_hooks) {
      hook();
    }
  }
}

export class SingerClient extends EventTarget {
  // Events we send:
  // * connectivityChange (see hasConnectivity)
  // * diagnosticChange (see diagnostics)
  // * newMark { "delay": [seconds until it happens], "data": [arbitrary] }
  // * backingTrackUpdate { "progress": [seconds since start of backing track, float] }
  // * markReached { "data" }
  // * x_metadataRecieved { metdata: { ... } }

  constructor(options) {
    super();

    var {speakerMuted, micMuted, context, secretId, apiUrl, offset, username} = options;

    check(context, "Cannot construct SingerClient without a valid context! Context is:", context);

    this.ctx = context;
    this.metadata_send_queue = [];
    this.telemetry_send_queue = [];

    this.audio_vol_adjustment_ = 1;

    this.offset = offset;
    this.secretId = secretId;
    this.username = username;
    this.apiUrl = apiUrl;

    this.hasConnectivity = false;  // XXX public readonly
    this.diagnostics = {};  // XXX public readonly, not part of formal API

    // XXX: direct port of event machinery, probably needs some reworking
    // XXX: not sure how it will fail if things happen during connectivity outages, but it probably will
    this.start_hooks = [];
    this.stop_hooks = [];
    this.event_hooks = [];

    this.alarms = {};
    this.alarms_fired = {};
    this.cur_clock_cbs = [];

    this.events_seen_already = {};

    // This is a bit of a hack, but whatever.
    this.backing_track_start_clock = null;

    this.handle_message_bound = this.handle_message.bind(this);

    // Hack on the new CustomEvent-based mark stuff into the old event_hooks system
    this.event_hooks.push((data) => {
      console.info("Mark fired:", data);
      this.dispatchEvent(new CustomEvent("markReached", {
        detail: {
          data
        }
      }));
    })

    this.connect_();

    this.speakerMuted = speakerMuted;
    this.micMuted = micMuted;
    this.send_telemetry("user_agent", navigator.userAgent);  // XXX: this is stupid, do this on the server
  }

  declare_event(evid, offset) {
    console.info("Going to send new mark: declare_event", evid, offset);
    this.with_cur_clock((clock) => {
      console.info("new mark at our clock", clock);
      const server_clock = this.client_to_server_clock(clock);
      console.info("corresponding server clock is", server_clock);
      console.info("Sending new mark:", evid, offset, server_clock-(offset||0)*this.server_sample_rate);
      this.x_send_metadata("event_data", {
        evid,
        clock:server_clock-(offset||0)*this.server_sample_rate}, true);  // XXX invasive coupling
    });
  }

  disconnect_() {
    this.hasConnectivity = false;
    this.dispatchEvent(new Event("connectivityChange"));

    this.ctx.unsubscribe_and_stop_worklet();

    this.connection.close();
    this.connection = null;
    this.mic_buf = [];  // Extra just-in-case flush of stale audio data
  }

  connect_() {
    if (this.connection || this.hasConnectivity) {
      console.error("Tried to connect_ an already-connected (or already-connecting) SingerClient, doing nothing... (This should never happen.)");
      return;
    }
    this.connection = new SingerClientConnection({
      receive_cb: this.server_response.bind(this),
      failure_cb: this.server_failure.bind(this),
      metadata_cb: this.server_metadata_received.bind(this),
      context: this.ctx,
      offset: this.offset,
      secretId: this.secretId,
      username: this.username,
      apiUrl: this.apiUrl,
    });
    this.mic_buf = [];  // Extra just-in-case flush of stale audio data

    this.connection.start_singing().then(result => {
      this.hasConnectivity = true;
      this.mic_buf = [];
      this.ctx.subscribe_and_start_worklet(this.handle_message_bound);
      if (this.metadata_send_queue.length != 0) {
        console.info("Connection established, sending queued metadata:", this.metadata_send_queue);
        for (const [key, value, append] of this.metadata_send_queue) {
          this.connection.x_send_metadata(key, value, append);
        }
        this.metadata_send_queue = [];
      }
      if (this.telemetry_send_queue.length != 0) {
        for (const [key, value, append] of this.telemetry_send_queue) {
          this.connection.send_telemetry(key, value, append);
        }
        this.telemetry_send_queue = [];
      }
      this.dispatchEvent(new Event("connectivityChange"));
    }, err => {
      this.close();
    });
  }

  get speakerMuted() {
    return this.speakerMuted_;
  }

  get micMuted() {
    return this.micMuted_;
  }

  set speakerMuted(mode) {
    this.speakerMuted_ = mode;
    this.ctx.set_speaker_pause_mode(mode);
    this.send_telemetry("speaker_muted", mode);
  }

  set micMuted(mode) {
    this.micMuted_ = mode;
    this.ctx.set_mic_pause_mode(mode);
    this.send_telemetry("mic_muted", mode);
  }

  close() {
    this.ctx.unsubscribe_and_stop_worklet();
    this.connection.close();

    // Try to reduce leaks of expensive objects, if we get leaked by mistake
    this.connection = null;
  }

  change_offset(new_offset) {
    this.offset = new_offset;
    if (!this.hasConnectivity) {
      // XXX: this is wrong, will fail to change our offset properly if we change it in the middle of an outage (but this prevents complex and annoying races)
      return;
    }

    this.disconnect_();
    this.connect_();
  }

  x_send_metadata(key, value, append) {
    if (this.connection && this.hasConnectivity) {
      this.connection.x_send_metadata(key, value, append);
    } else {
      this.metadata_send_queue.push([key, value, append]);
      console.warn("Can't send metadata yet; buffering until connected, queue is:", this.metadata_send_queue);
    }
  }

  send_telemetry(key, value, append) {
    // We're disabling this for now.
    return;

    if (this.connection && this.hasConnectivity) {
      this.connection.send_telemetry(key, value, append);
    } else {
      this.telemetry_send_queue.push([key, value, append]);
    }
  }

  handle_message(event) {
    var msg = event.detail.msg;

    if (msg.type == "alarm") {
      if ((msg.time in this.alarms) && ! (msg.time in this.alarms_fired)) {
        console.info("calling alarm at "+msg.time)
        this.alarms[msg.time]();
        this.alarms_fired[msg.time] = true;
      }
      return;
    } else if (msg.type == "cur_clock") {
      for (let cb of this.cur_clock_cbs) {
        cb(msg.clock);
        // console.warn("got clock "+msg.clock+" and event_data is now "+ send_metadata.event_data);
      }
      this.cur_clock_cbs = [];
      return;
    } else if (msg.type == "audio_lag" || msg.type === "underflow") {
      this.dispatchEvent(new Event("audioLag"));
      return;
    } else if (msg.type != "samples_out") {
      this.close();
      throw new Error("Got message of unknown type: " + JSON.stringify(msg));
    }

    // Tricky metaprogramming bullshit to recover the object-nature of an object sent via postMessage
    var chunk = thaw(msg.chunk);
    //console.debug("Got chunk, mic_buf len was:", this.mic_buf.length, "chunk is", chunk);
    if (chunk instanceof PlaceholderChunk && this.mic_buf.length > 0) {
      check(this.mic_buf[this.mic_buf.length - 1] instanceof PlaceholderChunk,
        "Tried to switch back from audio chunks to placeholder chunks in handle_message! This should never happen. Stale chunks in mic_buf?")
    }
    this.mic_buf.push(chunk);

    this.diagnostics.web_audio_jank = msg.jank / 1000.0;  // convert from ms to s
    this.diagnostics.web_audio_jank_frac = msg.jank / msg.jank_over;  // fraction of dropped callbacks
    this.diagnostics.dropped_calls = msg.dropped_calls;
    // XXX: just for debugging
    // XXX: window.msWebAudioJankCurrent.value = Math.round(msg.jank) + "ms";

    if (this.mic_buf.length >= this.ctx.sample_batch_size) { //XXX sbs should be on clients not context right?
      if (LOG_ULTRA_VERBOSE) {
        console.debug("Got enough chunks:", this.mic_buf);
      }
      var chunk = concat_chunks(this.mic_buf);
      this.normalize_volume(chunk);
      if (LOG_ULTRA_VERBOSE) {
        console.debug("SPAM", "Encoding chunk to send:", chunk);
      }
      this.mic_buf = [];
      this.connection.send_chunk(chunk);
    }
  }

  normalize_volume(chunk) {
    const chunk_data = chunk.data;
    let squared_sum = 0;
    for (let i = 0; i < chunk_data.length; i++) {
      squared_sum += chunk_data[i] * chunk_data[i];
    }
    const rms_volume = Math.sqrt(squared_sum);
    if (rms_volume > 0) {
      const candidate_vol_adjustment = TARGET_MAX_RMS_VOL/rms_volume;
      if (candidate_vol_adjustment < this.audio_vol_adjustment_) {
        this.audio_vol_adjustment_ = candidate_vol_adjustment;
        console.log("hit max volume, turned user down to:", this.audio_vol_adjustment_);
      }
    }
    for (let i = 0; i < chunk_data.length; i++) {
      chunk_data[i] *= this.audio_vol_adjustment_;
    }
  }


  server_response(chunk) {
    this.ctx.samples_to_worklet(chunk);
  }

  server_failure(e) {
    // The connection is already closed at this point, don't close it again
    this.connection = null;
    this.hasConnectivity = false;
    this.ctx.unsubscribe_and_stop_worklet();
    this.dispatchEvent(new Event("connectivityChange"));

    this.connect_();
  }

  get server_sample_rate() {
    return this.connection.server_connection.clock_reference.sample_rate;
  }

  get client_sample_rate() {
    return this.ctx.audioCtx.sampleRate;
  }

  server_to_client_clock(clock) {
    return Math.floor(
      clock
      / this.server_sample_rate
      * this.client_sample_rate);
  }

  client_to_server_clock(clock) {
    return Math.floor(
      clock
      * this.server_sample_rate
      / this.client_sample_rate);
  }

  with_cur_clock(cb) {
    this.cur_clock_cbs.push(cb);
    this.ctx.playerNode.port.postMessage({
      type: "request_cur_clock"
    });
  }

  server_metadata_received(metadata) {
    console.debug("Received metadata:", metadata);

    this.with_cur_clock((clock) => {
      if (this.backing_track_start_clock && (clock > this.backing_track_start_clock)) {
        if (LOG_ULTRA_VERBOSE) {
          console.debug("Firing backing track update:", (clock - this.backing_track_start_clock) / this.client_sample_rate, clock, this.backing_track_start_clock, this.client_sample_rate);
        }
        this.dispatchEvent(new CustomEvent("backingTrackUpdate", {
          detail: {
            progress: (clock - this.backing_track_start_clock) / this.client_sample_rate
          }
        }));
      }
    });

    var events = metadata["events"] || [];

    if (LOG_ULTRA_VERBOSE) {
      console.debug("got marks from server:", events, "already seen:", this.events_seen_already);
    }
    var new_events = [];
    for (const ev of events) {
      // This is  bit of a hack to get things working for solstice.
      // Note that this will give unpredictable (i.e. wrong) results if one song is started while the tail end of another is still going. Don't do that.
      if (ev["evid"] == "backingTrackStart") {
        this.backing_track_start_clock = this.server_to_client_clock(ev.clock);
      }
      if (!this.events_seen_already[ev["evid"]]) {
        console.info("unseen event:", ev);
        new_events.push(ev);
        // Making this a map in this way is kind of gross if our "event data"
        //   becomes something complex rather than a scalar... but it's how we
        //   do it on the server... XXX
        this.events_seen_already[ev["evid"]] = ev["clock"];
      }
    }

    if (new_events.length > 0) {
      console.info("Received new marks from server:", new_events);
    }

    for (let ev of new_events) {
      console.info("newMark:", ev);
      const client_clock = this.server_to_client_clock(ev.clock);
      this.with_cur_clock((clock) => {
        const delay_s = (client_clock - clock) / this.client_sample_rate;
        console.info("translated into local clock:", client_clock, "; from now:", delay_s)

        this.dispatchEvent(new CustomEvent("newMark", {
          detail: {
            data: ev["evid"],
            delay: delay_s
          }
        }));
      })

      this.alarms[client_clock] = () => this.event_hooks.map(f=>f(ev["evid"]));

      console.info("setting alarm to fire at server clock", ev["clock"], "our clock", client_clock)
      this.ctx.playerNode.port.postMessage({  // XXX invasive coupling, do this through ctx and have it translate the sample rates nicely!!
        type: "set_alarm",
        time: client_clock
      });
    }

    // XXX: This is a backdoor hack for bucket brigade that should mostly get refactored away
    this.dispatchEvent(new CustomEvent("x_metadataReceived", {
      detail: {
        metadata
      }
    }));

    // This is how closely it's safe to follow behind us, if you get as unlucky as possible (and try to read _just_ before we write).
    var client_window_time = this.connection?.server_connection?.client_window_time;
    if (client_window_time) {
      // We used to have access to the length of the chunk in seconds here, but it's missing since I split metadata handling from chunk handling, oops. So we divide.
      this.diagnostics.client_total_time = client_window_time + metadata.n_samples / metadata.server_sample_rate;
    }

    // This is how far behind our target place in the audio stream we are. This must be added to the value above, to find out how closely it's safe to follow behind where we are _aiming_ to be. This value should be small and relatively stable, or something has gone wrong.
    if (this.connection?.server_connection?.clientReadSlippage) {
      this.diagnostics.client_read_slippage = this.connection.server_connection.clientReadSlippage;
    }

    if (this.diagnostics.client_total_time && this.diagnostics.client_read_slippage) {
      // There are easier ways to compute this, but this works.
      this.diagnostics.client_time_to_next_client = this.diagnostics.client_total_time + this.diagnostics.client_read_slippage;
    }
    this.send_telemetry("diagnostics", this.diagnostics);  // A bit redundant since we're telling the server things it should already know...
    if (this.connection?.server_connection?.audio_offset) {
      this.send_telemetry("audio_offset", this.connection?.server_connection?.audio_offset);  // This is a very weird place to send this
    }
    this.dispatchEvent(new Event("diagnosticChange"));
  }
}

// This is useful because we can stop() it when we need to reload the connection,
// which gives us a place to cut off and consume stale callbacks / promises. The
// ones related to the server itself, we can do in ServerConnection (and we do),
// but the ones related to encoding/decoding we can't.
export class SingerClientConnection {
  constructor(options) {
    var {context, secretId, offset, username, apiUrl, receive_cb, failure_cb, metadata_cb} = options;
    // XXX: add loopback mode?

    this.receive_cb = receive_cb;
    this.failure_cb = failure_cb;
    this.metadata_cb = metadata_cb;

    this.apiUrl = apiUrl;

    this.audio_offset_seconds = offset;

    this.ctx = context;
    this.secretId = secretId;
    this.server_connection = new ServerConnection({
      target_url: new URL(this.apiUrl),
      audio_offset_seconds: this.audio_offset_seconds,
      userid: secretId,
      receive_cb: this.server_response.bind(this),
      failure_cb: this.server_failure.bind(this),
    });

    this.userid = secretId;
    this.username = username;

    this.metadata_to_send = {
      reset_user_state: true,  // on our first request from a new connection
    };
    // XXX: should probably have these on here instead of the context? Unless they leak stuff (do they?) and we don't want to recreate them.
    this.encoder = this.ctx.encoder;
    this.decoder = this.ctx.decoder;
    this.encoder.reset();
    this.decoder.reset();

    this.running = true;
  }

  async start_singing() {
    return this.server_connection.start();
  }

  close() {
    this.server_connection.stop();
    this.server_connection = null;
    this.decoder.reset();
    this.decoder = null;
    this.encoder.reset();
    this.encoder = null;
    this.receive_cb = null;
    this.failure_cb = null;
    this.metadata_cb = null;
    this.running = false;
  }

  // Backdoor for bucket brigade to send things that shouldn't really be required in the proper API
  x_send_metadata(key, value, append) {
    if (append) {
      if (!(key in this.metadata_to_send)) {
        this.metadata_to_send[key] = [];
      }
      this.metadata_to_send[key].push(value);
    } else {
      this.metadata_to_send[key] = value;
    }
  }

  send_telemetry(key, value, append) {
    var telemetry;
    if ("client_telemetry" in this.metadata_to_send) {
      telemetry = this.metadata_to_send.client_telemetry;
    } else {
      telemetry = {};
    }

    if (append) {
      if (!(key in telemetry)) {
        telemetry[key] = []
      }
      telemetry[key].push(value);
    } else {
      telemetry[key] = value;
    }
    this.metadata_to_send.client_telemetry = telemetry;
  }

  server_response(response) {
    if (!this.running) {
      return;
    }

    var { metadata, chunk: response_chunk } = response;
    if (!response_chunk) {  // In theory this should never happen now, it should call failure instead
      this.server_failure();
      return;
    }

    this.decoder.decode_chunk(response_chunk).then(play_chunk => {
      if (!this.running) {
        return;
      }
      if (LOG_ULTRA_VERBOSE) {
        console.debug("SPAM", "Decoded chunk from server:", play_chunk.interval, play_chunk);
      }
      this.receive_cb(play_chunk);
      this.metadata_cb(metadata);
      return;
    }, err => {
      this.server_failure(err);
      return;
    });
  }

  server_failure(e) {
    if (!this.running) {
      return;
    }
    this.failure_cb(e);
    this.close();
  }

  send_chunk(chunk) {
    this.encoder.encode_chunk(chunk).then(encoded_chunk => {
      if (!this.running) {
        return;
      }
      if (LOG_ULTRA_VERBOSE) {
        console.debug("SPAM", "Got encoded chunk to send:", encoded_chunk);
      }

      this.metadata_to_send.username = this.username;
      // XXX this.metadata_to_send.loopback_mode = loopback_mode;
      this.server_connection.set_metadata(this.metadata_to_send);
      this.metadata_to_send = {}
      // XXX: interesting, it does not seem that these promises are guaranteed to resolve in order... and the worklet's buffer uses the first chunk's timestamp to decide where to start playing back, so if the first two chunks are swapped it has a big problem.
      this.server_connection.send(encoded_chunk);
    }, err => {
      this.server_failure(err);
    });
  }
}

export class VolumeCalibrator extends EventTarget {
  constructor(options) {
    var {context} = options;
    super();

    this.ctx = context;
    this.hasMicInput = true;  // XXX should be readonly

    this.handle_message_bound = this.handle_message.bind(this);
    this.ctx.subscribe_and_start_worklet(this.handle_message_bound);

    // XXX etc.
    this.ctx.set_estimate_volume_mode(true);
  }

  close() {
    this.ctx.set_estimate_volume_mode(false);
    this.ctx.unsubscribe_and_stop_worklet();
  }

  handle_message(event) {
    var msg = event.detail.msg;
    if (msg.type == "no_mic_input") {
      this.hasMicInput = false;
      this.dispatchEvent(new Event("micInputChange"));
      return;
    } else if (msg.type == "current_volume") {
      // Inverse of Math.exp(6.908 * linear_volume)/1000;
      const human_readable_volume = Math.log(msg.volume * 1000) / 6.908;
      this.dispatchEvent(new CustomEvent("volumeChange", {
        detail: {
          volume: human_readable_volume,
        }
      }))
      return;
    } else if (msg.type == "input_gain") {
      this.dispatchEvent(new CustomEvent("volumeCalibrated", {
        detail: {
          inputGain: msg.input_gain,
        }
      }));
      this.close();
      return;
    }
  }
}

export class LatencyCalibrator extends EventTarget {
  constructor(options) {
    var {context, clickVolume} = options;
    super();

    this.ctx = context;
    this.click_volume_ = clickVolume;
    this.ctx.click_volume_change(this.click_volume_);
    this.hasMicInput = true;  // XXX should be readonly

    this.handle_message_bound = this.handle_message.bind(this);
    this.ctx.subscribe_and_start_worklet(this.handle_message_bound);

    // XXX: invasive coupling, and this maybe violates the desire to allow async construction of the context
    this.ctx.send_ignore_input(false);  // XXX: this actually appears to be ignored in this mode anyway
    this.ctx.set_estimate_latency_mode(true);
  }

  close() {
    this.ctx.set_estimate_latency_mode(false);
    this.ctx.unsubscribe_and_stop_worklet();
  }

  get clickVolume() {
    return this.click_volume_;
  }

  set clickVolume(new_volume) {
    this.click_volume_ = new_volume;
    this.ctx.click_volume_change(this.click_volume_);
  }

  handle_message(event) {
    var msg = event.detail.msg;
    if (msg.type == "no_mic_input") {
      this.hasMicInput = false;
      this.dispatchEvent(new Event("micInputChange"));
      return;
    } else if (msg.type == "latency_estimate") {
      if (!this.hasMicInput) {
        this.hasMicInput = true;
        this.dispatchEvent(new Event("micInputChange"));
      }

      var beepDetails = {
        done: false,
        samples: msg.samples,
      }

      if (msg.p50 !== undefined) {
        const latency_range = msg.p75 - msg.p25;

        beepDetails.est25to75 = latency_range;
        beepDetails.estLatency = msg.p50;
        beepDetails.jank = msg.jank;

        if (msg.samples >= 7) {
          this.close();
          beepDetails.done = true;

          if (latency_range <= 2) {
            beepDetails.success = true;
            // If we have measured latency within 2ms, that's good.
            this.ctx.send_local_latency(msg.p50);
          } else {
            beepDetails.success = false;
          }
        }
      }
      var e = new CustomEvent("beep", {
        detail: beepDetails
      });
      this.dispatchEvent(e);
      return;
    }
  }
}

export function init_events() {
  let target_url = serverPath.value + "reset_events";
  let xhr = new XMLHttpRequest();
  xhr.open("POST", target_url, true);
  xhr.send();
}

// Pack multiple subpackets into an encoded blob to send the server
// - Packet count: 1 byte
// - Each packet:
//   - Packet length (bytes): 2 bytes, big endian
//   - Packet data
function pack_multi(packets) {
  if (LOG_ULTRA_VERBOSE) {
    console.debug("SPAM", "Encoding packet for transmission to server! input:", packets);
  }
  var encoded_length = 1; // space for packet count
  packets.forEach((p) => {
    encoded_length += 2; // space for packet length
    encoded_length += p.length;
  });

  var outdata = new Uint8Array(encoded_length);
  outdata[0] = packets.length;
  var outdata_idx = 1;
  packets.forEach((p) => {
    if (p.constructor !== Uint8Array) {
      throw new Error("must be Uint8Array");
    }
    var len = p.length;  // will never exceed 2**16
    var len_b = [len >> 8, len % 256];
    outdata[outdata_idx] = len_b[0];
    outdata[outdata_idx + 1] = len_b[1];
    outdata.set(p, outdata_idx + 2);
    outdata_idx += len + 2;
  });
  if (LOG_ULTRA_VERBOSE) {
    console.debug("SPAM", "Encoded packet for transmission to server! Final outdata_idx:", outdata_idx, ", encoded_length:", encoded_length, ", num. subpackets:", packets.length, ", output:", outdata);
  }
  return outdata;
}

function unpack_multi(data) {
  if (LOG_ULTRA_VERBOSE) {
    console.debug("SPAM", "Unpacking multi-packet from server, data:", data);
  }
  if (data.constructor !== Uint8Array) {
    throw new Error("must be Uint8Array");
  }
  var packet_count = data[0];
  var data_idx = 1;
  var result = [];
  for (var i = 0; i < packet_count; ++i) {
    var len = (data[data_idx] << 8) + data[data_idx + 1];
    // console.debug("VERYSPAM", "Unpacking subpacket", i, "at offset", data_idx, "with len", len);
    var packet = new Uint8Array(len);
    data_idx += 2;
    packet.set(data.slice(data_idx, data_idx + len));
    data_idx += len;
    result.push(packet);
  }
  if (LOG_ULTRA_VERBOSE) {
    console.debug("SPAM", "Unpacked multi-packet from server! Final data_idx:", data_idx, ", total length:", data.length, ", num. subpackets:", packet_count, "final output:", result);
  }
  return result;
}

function concat_typed_arrays(arrays, _constructor) {
  if (arrays.length == 0 && _constructor === undefined) {
    throw new Error("cannot concat zero arrays without constructor provided");
  }
  var constructor = _constructor || arrays[0].constructor;
  var total_len = 0;
  arrays.forEach((a) => {
    check(a.constructor === constructor, "must concat arrays of same type", a.constructor, constructor);
    total_len += a.length;
  });
  var result = new constructor(total_len);
  var result_idx = 0;
  arrays.forEach((a) => {
    result.set(a, result_idx);
    result_idx += a.length;
  });
  return result;
}

/*
function rebless(o) {
  if (o.type !== undefined) {
    Object.setPrototypeOf(o, eval(o.type).prototype);
  }
  if (o.rebless) {
    o.rebless();
  }
  return o;
}
*/

function thaw(o) {
  if (o.type == "PlaceholderChunk") {
    o = PlaceholderChunk.thaw(o);
  } else if (o.type == "AudioChunk" || o.type == "CompressedAudioChunk") {
    o = AudioChunkBase.thaw(o);
  }
  return o;
}

