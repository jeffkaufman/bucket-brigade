//import {browserLooksCompatible, MicEnumerator, openMic, BucketBrigadeContext, LatencyCalibrator, VolumeCalibrator, SingerClient, MonitorClient, AudioMark} from './app.js'

import * as bb from './app.js';

const APP_TUTORIAL = "tutorial";
const APP_INITIALIZING = "initializing";
const APP_STOPPED = "stopped";
const APP_STARTING = "starting";
const APP_RUNNING = "running";
const APP_CALIBRATING_LATENCY = "calibrating_latency";
const APP_CALIBRATING_LATENCY_CONTINUE = "calibrating_latency_continue";
const APP_CALIBRATING_VOLUME = "calibrating_volume";
const APP_STOPPING = "stopping";
const APP_RESTARTING = "restarting";

// Making these globals makes it easier to interrogate them in the Dev Tools console for debugging purposes.
window.bucket_ctx = null;
window.latency_calibrator = null;
window.volume_calibrator = null;
window.singer_client = null;

addEventListener('error', (event) => {
  event.preventDefault();
  console.warn("TOP LEVEL ERROR HANLDER FIRED:", event);
  if (document.getElementById('crash').style.display) {
    return;
  }
  document.getElementById('crash').style.display = 'block';
  const {name, message, stack, unpreventable} = event.error ?? {};
  if (unpreventable) {
    document.getElementById('crashMessage').textContent = message;
  } else {
    document.getElementById('crashBug').style.display = 'block';
    document.getElementById('crashTrace').textContent = `${name}: ${message}\n${stack}`;
  }

  // Avoid spamming the logs with further errors, if at all possible.
  stop();
});

addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  console.warn("UNHANDLED PROMISE REJECTION:", event);
  throw event.reason;
});

console.info("Starting up");

const myUserid = Math.round(Math.random()*100000000000)

function prettyTime(ms) {
  if (ms < 1000) {
    return "0s";
  }
  const sec = Math.round(ms / 1000);
  if (sec < 60) {
    return sec + "s";
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return min + "m";
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return hr + "h";
  }
  const d = Math.round(hr / 24);
  return d + "d";
}

function update_calendar() {
  fetch('https://www.googleapis.com/calendar/v3/calendars/gsc268k1lu78lbvfbhphdr0cs4@group.calendar.google.com/events?key=AIzaSyCDAG5mJmnmi9EaR5SujP70x8kLKOau4Is')
    .then(response => response.json())
    .then(data => {
      let currentEvent = null;
      let upcomingEvent = null;
      const now = Date.now();

      if ( ! data.items ) {
        // TODO: Save the error code?
        console.warn("No data from Google Calendar");
        window.currentEvent.innerText = "(Unable to communicate with Google Calendar.)";
        return;
      }

      data.items.forEach(item => {
        // If an event is currently happening we want to check whether
        // that's what people are here for. Similarly, if an event is
        // going to be starting soon we should give people a heads up.
        if (item.status === "confirmed") {
          const msUntilStart = Date.parse(item.start.dateTime) - now;
          const msUntilEnd = Date.parse(item.end.dateTime) - now;
          const organizer = item.organizer.displayName || item.organizer.email;
          console.log(item.summary + " [" + msUntilStart + ":" + msUntilEnd + "]");
          if (msUntilStart <= 0 && msUntilEnd > 0) {
            currentEvent = {
              summary: item.summary,
              remainingMs: msUntilEnd,
              organizer: organizer,
            };
          } else if (msUntilStart > 0) {
            if (!upcomingEvent || upcomingEvent.futureMs > msUntilStart) {
              upcomingEvent = {
                summary: item.summary,
                futureMs: msUntilStart,
                organizer: organizer,
              }
            }
          }
        }
      });

      if (currentEvent) {
        window.currentEvent.innerText = "Current Event: " + currentEvent.summary;
        window.eventWelcome.innerText =
          "Right now " + currentEvent.organizer + " is running \"" +
          currentEvent.summary + "\".  If you were invited to attend, great! " +
          "Otherwise, please come back later.";
      } else if (upcomingEvent) {
        window.currentEvent.innerText = "Next Event: \"" + upcomingEvent.summary +
          "\" in " + prettyTime(upcomingEvent.futureMs);
        if (upcomingEvent.futureMs < 60*60*1000) {
          window.eventWelcome.innerText =
            "There are no events right now, but in " +
            prettyTime(upcomingEvent.futureMs) + " " +
            upcomingEvent.organizer + " is running \"" +
            upcomingEvent.summary + "\".";
        }
      } else {
        window.currentEvent.innerText = "No Events Scheduled";
      }
    });
}
update_calendar();

function testEventGo() {
  if (!singer_client) {
    return;
  }
  singer_client.declare_event(testEventContents.value, testEventOffset.value);
}
window.testEventGo.addEventListener("click", testEventGo);

function testEventReceived(event_data) {
  receiveChatMessage("EVENT", JSON.stringify(event_data));
}

function receiveChatMessage(username, message) {
  const msg = document.createElement("div");
  const name_element = document.createElement("span");
  name_element.className = "chatName";
  name_element.innerText = username;
  const msg_body_element = document.createElement("span");
  msg_body_element.innerText = ": " + message;
  msg.appendChild(name_element);
  msg.appendChild(msg_body_element);
  window.chatDisplay.appendChild(msg);
  window.chatDisplay.scrollTop = window.chatDisplay.scrollHeight;
}

function sendChatMessage() {
  if (!window.chatEntry.value || !singer_client) {
    return;
  }
  receiveChatMessage(window.userName.value, window.chatEntry.value);
  singer_client.x_send_metadata("chats", window.chatEntry.value, true);
  window.chatEntry.value = "";
}

window.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();  // Do this first, or a thrown exception will cause the page to reload.
  sendChatMessage();
});

let leadButtonState = "take-lead";
function takeLeadClick() {
  if (!singer_client) {
    console.warn("Can't take lead when not singing");
    return;
  }
  if (leadButtonState == "take-lead") {
    singer_client.x_send_metadata("requestedLeadPosition", true);
    // Action doesn't take effect until server confirms.
  } else if (leadButtonState == "start-singing") {
    window.takeLead.textContent = "Stop Singing";
    singer_client.x_send_metadata("markStartSinging", true);
    leadButtonState = "stop-singing";
  } else if (leadButtonState == "stop-singing") {
    singer_client.x_send_metadata("markStopSinging", true);
    window.takeLead.textContent = "Lead a Song";
    leadButtonState = "take-lead";
    window.jumpToEnd.disabled = false;
  } else {
    throw new Error("unknown state " + leadButtonState);
  }
}

window.takeLead.addEventListener("click", takeLeadClick);

window.jumpToEnd.addEventListener("click", () => {
  audioOffset.value = 115;
  audio_offset_change();
});

window.bpmUpdate.addEventListener("click", () => {
  const newBpm = parseInt(window.bpm.value);
  if (isNaN(newBpm) || newBpm < 1 || newBpm > 500) {
    window.bpm.value = "invalid";
    return;
  }
  if (singer_client) {
    singer_client.x_send_metadata("bpm", newBpm);
  }
});

window.repeatsUpdate.addEventListener("click", () => {
  const newRepeats = parseInt(window.repeats.value);
  if (isNaN(newRepeats) || newRepeats < 0 || newRepeats > 20) {
    window.repeats.value = "invalid";
    return;
  }
  if (singer_client) {
    singer_client.x_send_metadata("repeats", newRepeats);
  }
});

window.bprUpdate.addEventListener("click", () => {
  const newBpr = parseInt(window.bpr.value);
  if (isNaN(newBpr) || newBpr < 0 || newBpr > 500) {
    window.bpr.value = "invalid";
    return;
  }
  if (singer_client) {
    singer_client.x_send_metadata("bpr", newBpr);
  }
});

window.latencyCalibrationRetry.addEventListener("click", () => {
  do_latency_calibration();
  switch_app_state(APP_CALIBRATING_LATENCY);
});

function enableSpectatorMode() {
  // This forcibly mutes us, ignoring the mute button.
  bucket_ctx.send_ignore_input(true);  // XXX: private

  // Make something up.
  window.estLatency.innerText = "150ms";
  bucket_ctx.send_local_latency(150);  // XXX: private

  // No reason to continue with volume calibration, go right to running.
  switch_app_state(APP_RUNNING);
  start_singing();
};

window.latencyCalibrationGiveUp.addEventListener("click", enableSpectatorMode); 

function persist(textFieldId) {
  const textField = document.getElementById(textFieldId);
  const prevVal = localStorage.getItem(textFieldId);
  if (prevVal !== null) {
    textField.value = prevVal;
  }

  textField.addEventListener("change", () => {
    localStorage.setItem(textFieldId, textField.value);
  });
}

function persist_checkbox(checkboxId) {
  const checkbox = document.getElementById(checkboxId);
  const prevVal = localStorage.getItem(checkboxId);
  checkbox.checked = (prevVal === "true");

  checkbox.addEventListener("change", () => {
    localStorage.setItem(checkboxId, checkbox.checked);
  });
}

persist("userName");
persist_checkbox("disableTutorial");
persist_checkbox("disableLatencyMeasurement");
// Persisting select boxes is harder, so we do it manually for inSelect.

function setMainAppVisibility() {
  if (window.userName.value && app_state != APP_TUTORIAL) {
    window.mainApp.style.display = "block";
  }
}

setMainAppVisibility();
window.userName.addEventListener("change", setMainAppVisibility);

inSelect.addEventListener("change", in_select_change);

async function enumerate_inputs() {
  var mic_enumerator = new bb.MicEnumerator();
  var mics = await mic_enumerator.mics();

  if (mics === undefined) {
    // Failed to enumerate, do something useful?
    console.error("Failed to enumerate input devices");
    return;
  }

  // Clear existing entries
  inSelect.options.length = 0;

  mics.forEach((info) => {
    var el = document.createElement("option");
    el.value = info.deviceId;
    el.text = info.label || 'Unknown Input';
    if (info.deviceId && localStorage.getItem("inSelect") === info.deviceId) {
      el.selected = true;
    }
    inSelect.appendChild(el);
  });

  var el = document.createElement("option");
  el.text = "---";
  el.disabled = true;
  inSelect.appendChild(el);

  el = document.createElement("option");
  el.value = "SILENCE";
  el.text = "SILENCE";
  inSelect.appendChild(el);

  el = document.createElement("option");
  el.value = "CLICKS";
  el.text = "CLICKS";
  inSelect.appendChild(el);

  el = document.createElement("option");
  el.value = "ECHO";
  el.text = "ECHO";
  inSelect.appendChild(el);
}

function allStatesExcept(states) {
  return [...ALL_STATES].filter(state => !states.includes(state));
}

function setVisibleIn(element, enabled_states, visible='block') {
  element.style.display = enabled_states.includes(app_state) ? visible : 'none';
}

function setEnabledIn(element, enabled_states) {
  element.disabled = !enabled_states.includes(app_state);
}

function set_controls() {
  setVisibleIn(window.micToggleButton, [APP_RUNNING]);
  setVisibleIn(window.speakerToggleButton, [APP_RUNNING]);

  setEnabledIn(loopbackMode, [APP_STOPPED])
  setEnabledIn(clickBPM, allStatesExcept([APP_STOPPED]));

  setEnabledIn(inSelect, allStatesExcept([APP_INITIALIZING, APP_RESTARTING]));
  setEnabledIn(startButton, allStatesExcept([APP_INITIALIZING, APP_RESTARTING]));

  setVisibleIn(startButton, allStatesExcept([APP_TUTORIAL]));

  setVisibleIn(window.tutorial, [APP_TUTORIAL]);

  startButton.textContent = ". . .";
  if (app_state == APP_STOPPED) {
    startButton.textContent = "Start";
  } else if (app_state != APP_INITIALIZING) {
    startButton.textContent = "Disconnect";
  }

  setVisibleIn(window.pleaseBeKind, allStatesExcept(ACTIVE_STATES));
  setVisibleIn(window.inputSelector,
               allStatesExcept(ACTIVE_STATES.concat([APP_TUTORIAL])));
  setVisibleIn(window.nameSelector,
               allStatesExcept(ACTIVE_STATES.concat([APP_TUTORIAL])));
  setEnabledIn(window.songControls, allStatesExcept([APP_RESTARTING]));
  setEnabledIn(window.chatPost, allStatesExcept([APP_RESTARTING]));
  setEnabledIn(audioOffset, allStatesExcept([APP_RESTARTING]));

  setVisibleIn(window.micToggleButton, [APP_RUNNING, APP_RESTARTING], "inline-block");
  setVisibleIn(window.speakerToggleButton, [APP_RUNNING, APP_RESTARTING], "inline-block");

  setVisibleIn(window.latencyCalibrationInstructions, [APP_STOPPED, APP_INITIALIZING, APP_CALIBRATING_LATENCY,
    APP_CALIBRATING_LATENCY_CONTINUE]);

  setVisibleIn(window.calibration, [APP_CALIBRATING_LATENCY,
                                    APP_CALIBRATING_LATENCY_CONTINUE]);
  setVisibleIn(window.latencyCalibrationFailed, [APP_CALIBRATING_LATENCY_CONTINUE]);

  setVisibleIn(window.volumeCalibration, [APP_CALIBRATING_VOLUME]);
  setEnabledIn(window.startVolumeCalibration, [APP_CALIBRATING_VOLUME]);

  setVisibleIn(window.runningInstructions, [APP_RUNNING, APP_RESTARTING]);

  setVisibleIn(window.noAudioInputInstructions, []);

  window.estSamples.innerText = "...";
  window.est25to75.innerText = "...";
  window.estLatency.innerText = "...";

  window.backingTrack.display = "none";

  setMainAppVisibility();
}

function in_select_change() {
  window.localStorage.setItem("inSelect", inSelect.value);
  reset_if_running();
}

var app_state = APP_TUTORIAL;
if (window.disableTutorial.checked) {
   app_state = APP_INITIALIZING;
}

var app_initialized = false;

const ALL_STATES = [
  APP_TUTORIAL, APP_INITIALIZING, APP_STOPPED, APP_STARTING, APP_RUNNING,
  APP_CALIBRATING_LATENCY, APP_CALIBRATING_LATENCY_CONTINUE,
  APP_CALIBRATING_VOLUME, APP_STOPPING, APP_RESTARTING];

const ACTIVE_STATES = [
  APP_RUNNING, APP_CALIBRATING_LATENCY, APP_CALIBRATING_LATENCY_CONTINUE,
  APP_CALIBRATING_VOLUME, APP_RESTARTING
];

function switch_app_state(newstate) {
  console.info("Changing app state from", app_state, "to", newstate, ".");
  app_state = newstate;
  set_controls();
}
set_controls();

var micPaused = false;
function toggle_mic() {
  micPaused = !micPaused;
  window.micToggleImg.alt = micPaused ? "turn mic on" : "turn mic off";
  window.micToggleImg.src =
    "images/mic-" + (micPaused ? "off" : "on") + ".png";
  if (singer_client) {
    singer_client.micMuted = micPaused;
  }
}

var speakerPaused = false;
function toggle_speaker() {
  speakerPaused = !speakerPaused;
  window.speakerToggleImg.alt = speakerPaused ? "turn speaker on" : "turn speaker off";
  window.speakerToggleImg.src =
    "images/speaker-" + (speakerPaused ? "off" : "on") + ".png";
  if (singer_client) {
    singer_client.speakerMuted = speakerPaused;
  }
}

async function reset_if_running() {
  if (app_state == APP_RUNNING) {
    await stop();
    await start();
  }
}

function audio_offset_change() {
  const new_value = parseInt(audioOffset.value);
  // TODO: stop using magic numbers about the buffer size
  if (isNaN(new_value) || new_value < 1 || new_value > 115) {
    audioOffset.value = 115;  // XXX get this dynamically from the server
  }

  console.info("Reloading client connection due to audio offset change");

  if (app_state == APP_RUNNING && singer_client) {
    switch_app_state(APP_RESTARTING);
    window.lostConnectivity.style.display = "block";
    singer_client.change_offset(parseInt(audioOffset.value));  // XXX can this race
    window.lostConnectivity.style.display = "none";
    switch_app_state(APP_RUNNING);
  }
}

async function start_stop() {
  if (app_state == APP_RUNNING) {
    await stop();
  } else if (app_state == APP_STOPPED) {
    await start();
  } else {
    console.warn("Pressed start/stop button while not stopped or running; stopping by default.");
    await stop();
  }
}

let previous_backing_track_str = "";
function update_backing_tracks(tracks) {
  console.info("Updating backing tracks:", tracks);
  if (JSON.stringify(tracks) == previous_backing_track_str) {
    return;
  }
  previous_backing_track_str = JSON.stringify(tracks);

  while (window.backingTrack.firstChild) {
    window.backingTrack.removeChild(window.backingTrack.firstChild);
  }

  const initialOption = document.createElement('option');
  initialOption.textContent = "[optional] backing track";
  window.backingTrack.appendChild(initialOption);

  for (var i = 0; i < tracks.length; i++) {
    const option = document.createElement('option');
    option.textContent = tracks[i];
    window.backingTrack.appendChild(option);
  }
}

window.backingTrack.addEventListener("change", (e) => {
  if (singer_client) {
    singer_client.x_send_metadata("backingTrack", window.backingTrack.value);
  }
});

let previous_user_summary_str = "";
let previous_mic_volume_inputs_str = "";

// userid > consoleChannel div
const consoleChannels = new Map();
window.consoleChannels = consoleChannels;

let monitoredUserId = null;

function mixerMonitorButtonClick(userid) {
  if (singer_client) {
    if (monitoredUserId) {
      consoleChannels.get(monitoredUserId).children[3].classList.remove('activeButton');
    }
    if (monitoredUserId === userid) {
      singer_client.x_send_metadata("monitoredUserId", "end");
      monitoredUserId = null;
      if (micPaused) {
        toggle_mic();
      }
    }
    else {
      singer_client.x_send_metadata("monitoredUserId", userid);
      monitoredUserId = userid;
      consoleChannels.get(userid).children[3].classList.add('activeButton');
      if (!micPaused) {
        toggle_mic();
      }
    }
  }
}

function mixerMuteButtonClick(userid) {

}

function mixerUpdateButtonClick(userid) {
  if (!singer_client) {
    // XXX: UI doesn't reflect that we can't do this when we're not connected, should have that in the UI controls state machine
    return;
  }

  var newvolume = parseFloat(consoleChannels.get(userid).children[2].value);
  if (newvolume >= 0 && newvolume <= 2) {
    singer_client.x_send_metadata(
      "micVolumes",
      [userid, newvolume],
       true);
  }
  else {
    consoleChannels.get(userid).children[2].value = "invalid";
  }
}

function update_active_users(user_summary, server_sample_rate, imLeading) {

  if (imLeading && leadButtonState != "start-singing" &&
      leadButtonState != "stop-singing") {
    window.takeLead.textContent = "Start Singing";
    leadButtonState = "start-singing";
    window.jumpToEnd.disabled = true;
    window.backingTrack.style.display = "block";
    window.backingTrack.selectedIndex = 0;
  } else if (!imLeading && leadButtonState != "leadButtonState") {
    window.takeLead.textContent = "Lead a Song";
    leadButtonState = "take-lead";
    window.jumpToEnd.disabled = false;
    window.backingTrack.style.display = "none";
  }

  if (JSON.stringify(user_summary) == previous_user_summary_str) {
    return;
  }
  previous_user_summary_str = JSON.stringify(user_summary);

  // Delete previous users.
  while (window.activeUsers.firstChild) {
    window.activeUsers.removeChild(window.activeUsers.lastChild);
  }

  const mic_volume_inputs = [];
  const userids = new Set();
  for (var i = 0; i < user_summary.length; i++) {
    const offset_s = user_summary[i][0];
    const name = user_summary[i][1];
    const mic_volume = user_summary[i][2];
    const userid = user_summary[i][3];
    const rms_volume = user_summary[i][6];

    mic_volume_inputs.push([name, userid, mic_volume, rms_volume]);
    userids.add(userid);

    const tr = document.createElement('tr');

    const td1 = document.createElement('td');
    td1.textContent = offset_s;
    tr.appendChild(td1);

    const td2 = document.createElement('td');
    td2.textContent = name;
    tr.appendChild(td2);

    window.activeUsers.appendChild(tr);
  }
  for (const existingUserId of consoleChannels.keys()) {
    if (!userids.has(existingUserId)) {
      window.mixingConsole.removeChild(consoleChannels.get(existingUserId));
      consoleChannels.delete(existingUserId);
    }
  }
  for (const newUserId of userids) {
    if (!consoleChannels.has(newUserId)) {
      const consoleChannel = document.createElement("div");
      consoleChannel.classList.add("consoleChannel");

      const channelName = document.createElement("span");
      channelName.classList.add("channelName");
      // set channelName 

      const channelVolume = document.createElement("span");
      channelVolume.classList.add("channelVolume");

      const channelVolumeIndicator = document.createElement("span");
      channelVolumeIndicator.classList.add("channelVolumeIndicator");
      channelVolume.appendChild(channelVolumeIndicator);

      const channelVolumeInput = document.createElement("input");
      channelVolumeInput.classList.add("channelVolumeInput");
      channelVolumeInput.type = "text";
      
      const monitorButton = document.createElement("button");
      monitorButton.appendChild(document.createTextNode("mon"));
      monitorButton.addEventListener("click", ()=>{mixerMonitorButtonClick(newUserId)});

      const muteButton = document.createElement("button");
      muteButton.appendChild(document.createTextNode("mute"));
      muteButton.addEventListener("click", ()=>{mixerMuteButtonClick(newUserId)});

      const updateButton = document.createElement("button");
      updateButton.appendChild(document.createTextNode("update"));
      updateButton.addEventListener("click", ()=>{mixerUpdateButtonClick(newUserId)});

      consoleChannel.appendChild(channelName);
      consoleChannel.appendChild(channelVolume);
      consoleChannel.appendChild(channelVolumeInput);
      consoleChannel.appendChild(monitorButton);
      consoleChannel.appendChild(muteButton);
      consoleChannel.appendChild(updateButton);
      window.mixingConsole.appendChild(consoleChannel);
      consoleChannels.set(newUserId, consoleChannel);
    }
  }

  mic_volume_inputs.sort();
  if (JSON.stringify(mic_volume_inputs) != previous_mic_volume_inputs_str) {
  
    for (var i = 0; i < mic_volume_inputs.length; i++) {

      const name = mic_volume_inputs[i][0];
      const userid = mic_volume_inputs[i][1];
      const vol = mic_volume_inputs[i][2];
      const rms_volume = mic_volume_inputs[i][3];
      let percentage_volume = (((Math.log(rms_volume*1000))/6.908)+1)*50;
      if (percentage_volume < 0) {
        percentage_volume = 0;
      }
      else if (percentage_volume > 100) {
        percentage_volume = 100;
      }

      consoleChannels.get(userid).children[0].innerText = name;
      consoleChannels.get(userid).children[2].value = vol;
      consoleChannels.get(userid).children[1].children[0].style.width = percentage_volume+'%'
    }
  }
  previous_mic_volume_inputs_str = JSON.stringify(mic_volume_inputs);
}

async function stop() {
  if (app_state != APP_RUNNING &&
      app_state != APP_CALIBRATING_LATENCY &&
      app_state != APP_CALIBRATING_LATENCY_CONTINUE &&
      app_state != APP_CALIBRATING_VOLUME) {
    console.warn("Trying to stop, but current state is not running or calibrating? Stopping anyway.");
  }
  switch_app_state(APP_STOPPING);

  if (micPaused) {
    toggle_mic();
  }

  if (speakerPaused) {
    toggle_speaker();
  }

  console.info("Closing bucket brigade objects...");

  if (singer_client) {
    singer_client.close();
    singer_client = null;
  }

  if (latency_calibrator) {
    latency_calibrator.close();
    latency_calibrator = null;
  }

  if (volume_calibrator) {
    volume_calibrator.close();
    volume_calibrator = null;
  }

  if (bucket_ctx) {
    bucket_ctx.close();
    bucket_ctx = null;
  }
  console.info("...closed.");

  /* XXX
  for (let hook of stop_hooks) {
    hook();
  }
  */

  switch_app_state(APP_STOPPED);
}

function click_volume_change() {
  if (latency_calibrator) {
    latency_calibrator.clickVolume = parseFloat(clickVolumeSlider.value);
  }
}

startButton.addEventListener("click", start_stop);
window.micToggleButton.addEventListener("click", toggle_mic);
window.speakerToggleButton.addEventListener("click", toggle_speaker);
clickVolumeSlider.addEventListener("change", click_volume_change);
audioOffset.addEventListener("change", audio_offset_change);

window.startVolumeCalibration.addEventListener("click", () => {
  window.startVolumeCalibration.disabled = true;
  volume_calibrator = new bb.VolumeCalibrator({
    context: bucket_ctx
  })

  volume_calibrator.addEventListener("volumeChange", (event) => {
    window.reportedVolume.innerText = Math.round(100 * event.detail.volume) / 100 + "dB";
  });
  volume_calibrator.addEventListener("volumeCalibrated", (event) => {
    window.inputGain.value = event.detail.inputGain;
    switch_app_state(APP_RUNNING);
    volume_calibrator = null;
    start_singing();
  });
});

async function start_singing() {
  var final_url = new URL(serverPath.value, document.location).href;

  singer_client = new bb.SingerClient({
    context: bucket_ctx,
    apiUrl: final_url,
    secretId: myUserid, // XXX
    speakerMuted: speakerPaused,
    micMuted: micPaused,
    offset: parseInt(audioOffset.value),
    username: window.userName.value,
  });

  // XXX: these event listeners will keep the object alive, plausibly, which could be bad if we do multiple songs?
  singer_client.addEventListener("diagnosticChange", () => {
    console.info("DIAG:", singer_client.diagnostics);

    window.clientTotalTime.value = singer_client.diagnostics.client_total_time;
    window.clientReadSlippage.value = singer_client.diagnostics.client_read_slippage;
  })

  singer_client.addEventListener("connectivityChange", () => {
    if (singer_client.hasConnectivity) {
      console.info("Connection established!");
      // XXX: should switch_app_state here, it presumably should always be RUNNING at this point right now?
    } else {
      console.warn("Connection lost! Reconnecting...");
    }
    // XXX: Need to put up the "connection lost" message here, if we have one
  });

  // XXX: this is a backchannel hack for bucket brigade to keep working with hacky metadata that is meant to be done in other ways / is not expected to be used by ritual engine.
  // Some of the things here probably do need to be dealt with in some fashion for ritual engine (most notably: song start/stop stuff)
  singer_client.addEventListener("x_metadataReceived", (e) => {
    var {metadata} = e.detail;

    var queue_size = metadata["queue_size"];
    var user_summary = metadata["user_summary"] || [];
    var tracks = metadata["tracks"];
    var chats = metadata["chats"] || [];
    var delay_seconds = metadata["delay_seconds"];
    var server_sample_rate = metadata["server_sample_rate"];
    var song_start_clock = metadata["song_start_clock"];
    var client_read_clock = metadata["client_read_clock"];
    var server_bpm = metadata["bpm"];
    var server_repeats = metadata["repeats"];
    var server_bpr = metadata["bpr"];

    var imLeading = metadata["x_imLeading"];  // Hacky backwards-compat fix

    update_active_users(user_summary, server_sample_rate, imLeading);

    // XXX: needs to be reimplemented in terms of alarms / marks
    if (song_start_clock && song_start_clock > client_read_clock) {
      window.startSingingCountdown.style.display = "block";
      window.countdown.innerText = Math.round(
        (song_start_clock - client_read_clock) / server_sample_rate) + "s";
    } else {
      window.startSingingCountdown.style.display = "none";
    }

    chats.forEach((msg) => receiveChatMessage(msg[0], msg[1]));
    if (tracks) {
      update_backing_tracks(tracks);
    }

    if (server_bpm) {
      window.bpm.value = server_bpm;
    }
    if (server_repeats) {
      window.repeats.value = server_repeats;
    }
    if (server_bpr) {
      window.bpr.value = server_bpr;
    }

    if (delay_seconds) {
      if (delay_seconds > 0) {
        if (singer_client) {
          audioOffset.value = delay_seconds;
          singer_client.change_offset(delay_seconds);
          return;
        }
      }
    }

  });

  // XXX: event system testing
  singer_client.event_hooks.push(testEventReceived);
}

window.globalVolumeControl.addEventListener("change", () => {
  if (singer_client) {
    singer_client.x_send_metadata("globalVolume", window.globalVolumeControl.value);
  }
});

window.backingVolumeControl.addEventListener("change", () => {
  if (singer_client) {
    singer_client.x_send_metadata("backingVolume", window.backingVolumeControl.value);
  }
});

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

async function initialize() {
  enumerate_inputs();

  if (document.location.hostname == "localhost") {
    // Better default for debugging.
    serverPath.value = "http://localhost:8081/"
  }

  app_initialized = true;
  if (app_state != APP_TUTORIAL) {
    switch_app_state(APP_STOPPED);
  }
}

function do_latency_calibration() {
  latency_calibrator = new bb.LatencyCalibrator({
    context: bucket_ctx,
    clickVolume: parseFloat(clickVolumeSlider.value),
  })

  latency_calibrator.addEventListener("micInputChange", () => {
    window.noAudioInputInstructions.style.display = (latency_calibrator.hasMicInput ? "none" : "block")
  });

  latency_calibrator.addEventListener("beep", (e) => {
    var details = e.detail;
    window.estSamples.innerText = details.samples;
    if (details.estLatency) {
      window.estLatency.innerText = Math.round(details.estLatency) + "ms";
      window.est25to75.innerText = Math.round(details.est25to75) + "ms";
      window.msClientLatency.value = Math.round(details.estLatency) + "ms";
      window.msWebAudioJank.value = Math.round(details.jank) + "ms";
      window.msTrueLatency.value = Math.round(details.estLatency - details.jank) + "ms";
    }

    if (details.done) {
      if (details.success) {
        latency_calibrator = null;
        switch_app_state(APP_CALIBRATING_VOLUME);
      } else {
        switch_app_state(APP_CALIBRATING_LATENCY_CONTINUE);
      }
    }
  });
}

async function start(spectatorMode=false) {
  var micStream = await bb.openMic(inSelect.value);

  bucket_ctx = new bb.BucketBrigadeContext({
    micStream,
  });

  await bucket_ctx.start_bucket();

  if (spectatorMode) {
    enableSpectatorMode(); 
  } else if (!disableLatencyMeasurement.checked) {
    do_latency_calibration();
    switch_app_state(APP_CALIBRATING_LATENCY);
  } else {
    switch_app_state(APP_RUNNING);
    window.estLatency.innerText = "150ms";
    bucket_ctx.send_local_latency(150);  // XXX: private
    start_singing();
  }
}

function hide_buttons_and_append_answer(element, answer) {
  for (var i = 0; i < element.children.length; i++) {
    element.children[i].style.display = "none";
  }
  const b = document.createElement('b');
  b.innerText = answer;
  element.appendChild(b);
};

function tutorial_answer(button) {
  const answer = button.innerText;
  const question = button.parentElement.id;
  hide_buttons_and_append_answer(button.parentElement, button.innerText);
  if (question === "q_singing_listening") {
    if (answer == "Singing and Listening") {
      window.q_headphones_present.style.display = 'block';
    } else {
      start(/*spectatorMode=*/true);
    }
  } else if (question === "q_headphones_present") {
    if (answer == "Yes") {
      window.q_headphones_wired.style.display = 'block';
    } else {
      window.q_wired_headphones_available.style.display = 'block';
    }
  } else if (question === "q_wired_headphones_available") {
    if (answer == "Yes") {
      window.final_attach_wired.style.display = 'block';
    } else {
      window.final_no_headphones.style.display = 'block';
    }
  } else if (question === "q_headphones_wired") {
    if (answer == "Yes") {
      window.final_wired_headphones.style.display = 'block';
      document.querySelectorAll(".headphoneAdvice").forEach(
        (element) => element.style.display = 'inline');
    } else {
      window.final_detach_wireless.style.display = 'block';
    }
  }
}

document.querySelectorAll(".dismiss_tutorial").forEach(
  (button) => button.addEventListener("click", () => {
    switch_app_state(app_initialized ? APP_STOPPED : APP_INITIALIZING);
  }));

document.querySelectorAll("#tutorial_questions button").forEach(
  (button) => button.addEventListener("click", () => tutorial_answer(button)));

initialize();
