import * as lib from './lib.js';
import {LOG_LEVELS} from './lib.js';
import {learned_latency_hooks, xhr_result_hooks, mic_sample_hooks, register_click_volume_getter, toggle_mute, start, stop, click_volume_change, wait_for_mic_permissions, start_hooks, stop_hooks, estimate_latency_toggle, sample_rate} from './app.js';


var in_select = document.getElementById('inSelect');
var out_select = document.getElementById('outSelect');
var click_bpm = document.getElementById('clickBPM');

async function enumerate_devices() {
  navigator.mediaDevices.enumerateDevices().then((devices) => {
    // Clear existing entries
    in_select.options.length = 0;
    out_select.options.length = 0;

    devices.forEach((info) => {
      var el = document.createElement("option");
      el.value = info.deviceId;
      if (info.kind === 'audioinput') {
        el.text = info.label || 'Unknown Input';
        in_select.appendChild(el);
      } else if (info.kind === 'audiooutput') {
        el.text = info.label || 'Unknown Output';
        out_select.appendChild(el);
      }
    });

    var el = document.createElement("option");
    el.text = "---";
    el.disabled = true;
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "SILENCE";
    el.text = "SILENCE";
    in_select.appendChild(el);

    /* Disabled for more public test, since it wastes a lot
       of bandwidth re-downloading a giant MP3
    el = document.createElement("option");
    el.value = "HAMILTON";
    el.text = "HAMILTON";
    in_select.appendChild(el);
    */

    el = document.createElement("option");
    el.value = "CLICKS";
    el.text = "CLICKS";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "ECHO";
    el.text = "ECHO";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.value = "NUMERIC";
    el.text = "NUMERIC";
    in_select.appendChild(el);

    el = document.createElement("option");
    el.text = "---";
    el.disabled = true;
    out_select.appendChild(el);

    el = document.createElement("option");
    el.value = "NOWHERE";
    el.text = "NOWHERE";
    out_select.appendChild(el);

    el = document.createElement("option");
    el.value = "NUMERIC";
    el.text = "NUMERIC (use with NUMERIC source)";
    out_select.appendChild(el);
  });
}


function set_controls(is_running) {
  start_button.disabled = is_running;
  estimate_latency_button.disabled = !is_running;
  click_volume_slider.disabled = !is_running;
  stop_button.disabled = !is_running;
  mute_button.disabled = !is_running;
  loopback_mode_select.disabled = is_running;
  in_select.disabled = is_running;
  click_bpm.disabled = is_running;
  out_select.disabled = is_running;
  server_path_text.disabled = is_running;
  audio_offset_text.disabled = is_running;
}

start_hooks.push(set_controls.bind(null,true));
stop_hooks.push(set_controls.bind(null,false));

var log_level_select = document.getElementById('logLevel');

LOG_LEVELS.forEach((level) => {
  var el = document.createElement("option");
  el.value = level[0];
  el.text = level[1];
  if (lib.log_level == level[0]) {
    el.selected = true;
  }
  log_level_select.appendChild(el);
});

log_level_select.addEventListener("change", () => {
  set_log_level(parseInt(log_level_select.value));
});

var start_button = document.getElementById('startButton');
var stop_button = document.getElementById('stopButton');
var mute_button = document.getElementById('muteButton');
var estimate_latency_button = document.getElementById('estimateLatencyButton');
var click_volume_slider = document.getElementById('clickVolumeSlider');
var loopback_mode_select = document.getElementById('loopbackMode');
var server_path_text = document.getElementById('serverPath');
var audio_offset_text = document.getElementById('audioOffset');
var web_audio_output_latency_text = document.getElementById('webAudioOutputLatency');
var latency_compensation_text = document.getElementById('latencyCompensationText');
var latency_compensation_label = document.getElementById('latencyCompensationLabel');
var latency_compensation_apply_button = document.getElementById('latencyCompensationApply');
var sample_rate_text = document.getElementById('sampleRate');
var peak_in_text = document.getElementById('peakIn');
var peak_out_text = document.getElementById('peakOut');
var hamilton_audio_span = document.getElementById('hamiltonAudioSpan');
var output_audio_span = document.getElementById('outputAudioSpan');
var audio_graph_canvas = document.getElementById('audioGraph');
var client_total_time = document.getElementById('clientTotalTime');
var client_read_slippage = document.getElementById('clientReadSlippage');


async function initialize() {
  await wait_for_mic_permissions();
  await enumerate_devices();
  set_controls(false);

  var saved_local_latency = window.localStorage.getItem("local_latency");
  if (saved_local_latency) {
    saved_local_latency = parseInt(saved_local_latency, 10);
    if (saved_local_latency > 0 && saved_local_latency < 500) {
      latency_compensation_text.value = saved_local_latency;
    }
  }

  if (document.location.hostname == "localhost") {
    // Better default
    server_path_text.value = "http://localhost:8081/"
  }

  var hash = window.location.hash;
  if (hash && hash.length > 1) {
    var audio_offset = parseInt(hash.substr(1), 10);
    if (audio_offset >= 0 && audio_offset <= 60) {
      audio_offset_text.value = audio_offset;
    }
  }
}

var coll = document.getElementsByClassName("collapse");
for (var i = 0; i < coll.length; i++) {
  coll[i].addEventListener("click", function() {
    //this.classList.toggle("active");
    var otherlabel = this.dataset.otherlabel;
    this.dataset.otherlabel = this.textContent;
    this.textContent = otherlabel;
    var content = this.nextElementSibling;
    if (content.style.display === "block") {
      content.style.display = "none";
    } else {
      content.style.display = "block";
    }
  });
}

estimate_latency_button.value = "Start latency estimation";
estimate_latency_button.addEventListener("click", ()=>{
  let currently_estimating = estimate_latency_toggle();
  estimate_latency_button.innerText = (currently_estimating?"Stop":"Start") + " latency estimation";
});


register_click_volume_getter( ()=>click_volume_slider.value );
click_volume_slider.addEventListener("change", click_volume_change);

learned_latency_hooks.push((msg)=>{
  latency_compensation_text.value = msg.latency;
  latency_compensation_label.innerText = "(Median of " + msg.samples + " samples.)"
});

var peak_in = 0;
mic_sample_hooks.push((mic_peak_in)=>{
  if (mic_peak_in>peak_in) peak_in=mic_peak_in;
  requestAnimationFrame(() => {
    peak_in_text.value = peak_in;
  });
});

var peak_out = 0;
xhr_result_hooks.push((metadata, xhr_peak_out, play_samples_length)=>{
  // Defer touching the DOM, just to be safe.
  requestAnimationFrame(() => {
    if (xhr_peak_out>peak_out) peak_out=xhr_peak_out;
    peak_out_text.value = peak_out;

    let audio_offset = audio_offset_text.value;
    let queue_summary = metadata["queue_summary"];
    let queue_size = metadata["queue_size"];
    
    client_total_time.value = (metadata["client_read_clock"] - metadata["client_write_clock"] + play_samples_length) / sample_rate;
    client_read_slippage.value = (metadata["server_clock"] - metadata["client_read_clock"] - audio_offset) / sample_rate;

    // Don't touch the DOM unless we have to
    if (audio_graph_canvas.width != audio_graph_canvas.clientWidth) {
      audio_graph_canvas.width = audio_graph_canvas.clientWidth;
    }
    var ctx = audio_graph_canvas.getContext('2d');
    var horz_mult = audio_graph_canvas.clientWidth / queue_size;
    ctx.setTransform(horz_mult, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, queue_size, 100);
    ctx.fillStyle = 'rgb(255, 0, 0)';
    if (queue_summary.length % 2 != 0) {
      queue_summary.push(queue_size);
    }
    for (var i = 0; i < queue_summary.length; i += 2) {
      ctx.fillRect(queue_summary[i], 0, queue_summary[i+1] - queue_summary[i], 50);
    }
    ctx.fillStyle = 'rgb(0, 0, 0)';
    ctx.fillRect(Math.round(metadata["server_clock"] / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillRect(Math.round(metadata["last_request_clock"] / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillStyle = 'rgb(0, 255, 0)';
    ctx.fillRect(Math.round(metadata["client_read_clock"] / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillRect(Math.round((metadata["client_read_clock"] - play_samples_length) / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillStyle = 'rgb(0, 0, 255)';
    ctx.fillRect(Math.round(metadata["client_write_clock"] / 128) % queue_size, 0, 1 / horz_mult, 100);
    ctx.fillRect(Math.round((metadata["client_write_clock"] - play_samples_length) / 128) % queue_size, 0, 1 / horz_mult, 100);
  });
});


start_button.addEventListener("click", ()=>{
  start({ input_device_id: in_select.value,
          output_device_id: out_select.value,
          input_opts: { click_bpm: click_bpm.value },
          audio_offset: audio_offset_text.value,
          loopback: loopback_mode_select.value,
          server_url: server_path_text.value,
        });
});

stop_button.addEventListener("click", stop);

mute_button.addEventListener("click", ()=>{
  let mute = toggle_mute();
  mute_button.innerText = mute ? "Unmute" : "Mute";
});

initialize();
