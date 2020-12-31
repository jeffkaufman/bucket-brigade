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

const N_BUCKETS = 7; // Keep in sync with server.py:LAYERING_DEPTH
const DELAY_INTERVAL = 3; // keep in sync with server.py:DELAY_INTERVAL


// Typical numbers, but better to measure.
const UNMEASURED_CLIENT_LATENCY = navigator.userAgent.match(/Firefox/) ? 67 : 125;


// Making these globals makes it easier to interrogate them in the Dev Tools console for debugging purposes.
window.bucket_ctx = null;
window.latency_calibrator = null;
window.volume_calibrator = null;
window.singer_client = null;

addEventListener('error', (event) => {
  event.preventDefault();
  console.warn("TOP LEVEL ERROR HANDLER FIRED:", event);
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

// Must fit in a uint64.
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

function joinBucket(i) {
  return () => {
    window.buckets.children[i].children[1].disabled = true;
    audioOffset.value = first_bucket_s + DELAY_INTERVAL * i;
    audio_offset_change();
  }
}

const bucket_user_div = {};  // userid -> bucket user div
const user_bucket_index = {};  // userid -> bucket index
const bucket_divs = [];  // bucket index -> bucket div

for (var i = 0; i < N_BUCKETS; i++) {
  var bucket = document.createElement("div");
  bucket.classList.add("bucket");

  var bucketName = document.createElement("h4");
  bucketName.appendChild(document.createTextNode(i+1))
  bucket.appendChild(bucketName);

  var joinButton = document.createElement("button");
  joinButton.appendChild(document.createTextNode("join"));
  joinButton.addEventListener("click", joinBucket(i));
  joinButton.disabled = true;
  bucket.appendChild(joinButton);

  var bucketUsers = document.createElement("div");
  bucketUsers.classList.add("bucketUsers");
  bucket_divs.push(bucketUsers);
  bucket.appendChild(bucketUsers);

  window.buckets.appendChild(bucket);
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

window.bpm.addEventListener("change", () => {
  const newBpm = parseInt(window.bpm.value);
  if (isNaN(newBpm) || newBpm < 0 || newBpm > 500) {
    window.bpm.value = last_server_bpm;
  }
});

window.repeats.addEventListener("change", () => {
  const newRepeats = parseInt(window.repeats.value);
  if (isNaN(newRepeats) || newRepeats < 0 || newRepeats > 20) {
    window.repeats.value = last_server_repeats;
  }
});

window.bpr.addEventListener("change", () => {
  const newBpr = parseInt(window.bpr.value);
  if (isNaN(newBpr) || newBpr < 0 || newBpr > 500) {
    window.bpr.value = last_server_bpr;
  }
});

window.roundsButtonsUpdate.addEventListener("click", () => {
  if (singer_client) {
    singer_client.x_send_metadata("bpm", window.bpm.value);
    singer_client.x_send_metadata("repeats", window.repeats.value);
    singer_client.x_send_metadata("bpr", window.bpr.value);
  }
});

window.latencyCalibrationRetry.addEventListener("click", () => {
  do_latency_calibration();
  switch_app_state(APP_CALIBRATING_LATENCY);
});

let in_spectator_mode = false;
function enableSpectatorMode() {
  // This forcibly mutes us, ignoring the mute button.
  // This is ONLY safe to do at the VERY beginning of things, before we send
  //   any real audio anywhere.
  bucket_ctx.send_ignore_input(true);  // XXX: private
  window.takeLead.disabled = true;
  in_spectator_mode = true;
  window.spectatorMode.style.display = "block";

  // Make something up.
  window.estLatency.innerText = UNMEASURED_CLIENT_LATENCY + "ms";
  bucket_ctx.send_local_latency(UNMEASURED_CLIENT_LATENCY);  // XXX: private

  // No reason to continue with volume calibration, go right to running.
  switch_app_state(APP_RUNNING);
  start_singing();
};

window.latencyCalibrationGiveUp.addEventListener("click", enableSpectatorMode);

window.sortConsole.addEventListener("click", ()=> {
  const allChannels = [];
  for (const userid of consoleChannels.keys()) {
    allChannels.push(consoleChannels.get(userid));
    window.mixingConsole.removeChild(consoleChannels.get(userid));
  }
  allChannels.sort((a, b)=> {
    // put one first if either:
    // * it is more than 1.5s earlier
    // * or it is louder
    const delta_s = a.offset_s - b.offset_s;
    if (Math.abs(delta_s) > 1.5) {
      return delta_s;
    } else {
      return (b.post_volume || 0) - (a.post_volume || 0);
    }
  });
  allChannels.forEach((channel)=> {
    window.mixingConsole.appendChild(channel);
  });
});

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

//don't persist "disable auto gain" because it's an experimental feature

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
  setEnabledIn(loopbackMode, [APP_STOPPED])
  setEnabledIn(clickBPM, allStatesExcept([APP_STOPPED]));

  setEnabledIn(inSelect, allStatesExcept([APP_INITIALIZING, APP_RESTARTING]));
  setEnabledIn(startButton, allStatesExcept([APP_INITIALIZING, APP_RESTARTING]));

  setVisibleIn(startButton, allStatesExcept([APP_TUTORIAL]));

  setVisibleIn(window.tutorial, [APP_TUTORIAL]);

  startButton.textContent = ". . .";
  if (app_state == APP_STOPPED) {
    startButton.textContent = "Start";
    startButton.style.display = 'block';
  } else if (app_state != APP_INITIALIZING) {
    startButton.style.display = 'none';
  }

  setVisibleIn(window.inputSelector,
               allStatesExcept(ACTIVE_STATES.concat([APP_TUTORIAL])));
  setVisibleIn(window.nameSelector,
               allStatesExcept(ACTIVE_STATES.concat([APP_TUTORIAL])));
  setEnabledIn(window.songControls, allStatesExcept([APP_RESTARTING]));
  setEnabledIn(window.chatPost, allStatesExcept([APP_RESTARTING]));
  setEnabledIn(audioOffset, allStatesExcept([APP_RESTARTING]));

  setEnabledIn(window.micToggleButton, [APP_RUNNING, APP_RESTARTING]);
  setEnabledIn(window.speakerToggleButton, [APP_RUNNING, APP_RESTARTING]);
  setEnabledIn(window.videoToggleButton, [APP_RUNNING, APP_RESTARTING]);

  if (visitedRecently) {
    setVisibleIn(window.rememberedCalibrationInstructions, [
      APP_STOPPED, APP_INITIALIZING]);
  } else {
    setVisibleIn(window.latencyCalibrationInstructions, [
      APP_STOPPED, APP_INITIALIZING, APP_CALIBRATING_LATENCY,
      APP_CALIBRATING_LATENCY_CONTINUE]);
  }

  setVisibleIn(window.calibration, [APP_CALIBRATING_LATENCY,
                                    APP_CALIBRATING_LATENCY_CONTINUE]);
  setVisibleIn(window.latencyCalibrationFailed, [APP_CALIBRATING_LATENCY_CONTINUE]);

  setVisibleIn(window.volumeCalibration, [APP_CALIBRATING_VOLUME]);
  setEnabledIn(window.startVolumeCalibration, [APP_CALIBRATING_VOLUME]);

  setEnabledIn(window.audioOffset, [APP_RUNNING]);
  setEnabledIn(window.backingVolumeSlider, [APP_RUNNING]);

  setVisibleIn(window.mainInterface, [APP_RUNNING, APP_RESTARTING]);

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

const visitedRecently = (
  Date.now() -
    parseInt(window.sessionStorage.getItem("calibrationTs"))) / 1000 / 60 < 30;

var app_state = APP_TUTORIAL;
if (window.disableTutorial.checked || visitedRecently) {
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

let in_lagmute_mode = false;
function dismissLagmute() {
  in_lagmute_mode = false;
  window.lagmute.style.display = "none";
  window.takeLead.disabled = false;
  singer_client.micMuted = micPaused;
}

function enterLagmute() {
  in_lagmute_mode = true;
  window.lagmute.style.display = "block";
  window.takeLead.disabled = true;
  singer_client.micMuted = micPaused;
}

window.unlagmute.addEventListener("click", dismissLagmute);

var micPaused = false;
function toggle_mic() {
  if (singer_client) {
    micPaused = !micPaused;
    window.micToggleButton.innerText = micPaused ? "unmute mic" : "mute mic";
    updateTwilioMute();
    updateBucketBrigadeMute();
  }
}

function updateBucketBrigadeMute() {
  if (!in_spectator_mode && !in_lagmute_mode) {
    window.takeLead.disabled = micPaused;
    singer_client.micMuted = micPaused;
  }
}

function updateTwilioMute() {
  if (twilio_room) {
    twilio_room.localParticipant.audioTracks.forEach(publication => {
      if (micPaused || in_beforesong || in_song || in_aftersong) {
        publication.track.disable();
      } else {
        publication.track.enable();
      }
    });
  }
}

var speakerPaused = false;
function toggle_speaker() {
  if (singer_client) {
    speakerPaused = !speakerPaused;
    window.speakerToggleButton.innerText =
      speakerPaused ? "unmute speaker" : "mute speaker";
    singer_client.speakerMuted = speakerPaused;
  }
}

var videoPaused = false;
function toggle_video() {
  if (twilio_room) {
    videoPaused = !videoPaused;
    window.videoToggleButton.innerText =
      videoPaused ? "enable video" : "disable video";

    if (videoPaused) {
      twilio_room.localParticipant.videoTracks.forEach(publication => {
        publication.track.stop();
        publication.unpublish();
      });
      if (myVideoDiv) {
        document.getElementById('remote-media-div').removeChild(myVideoDiv);
        myVideoDiv = null;
      }
    } else {
      Twilio.Video.createLocalVideoTrack({width: 160}).then(localVideoTrack => {
        twilio_room.localParticipant.publishTrack(localVideoTrack);
        myVideoDiv = localVideoTrack.attach();
        document.getElementById('remote-media-div').insertAdjacentElement(
          'afterbegin', myVideoDiv);
        myVideoDiv.style.transform = 'scale(-1, 1)';
      }).then(publication => {
        console.log('Successfully unmuted your video:', publication);
      });
    }
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

window.backingVolumeSlider.addEventListener("change", () => {
  const userBackingVolume = parseInt(backingVolumeSlider.value);
  if (isNaN(userBackingVolume) ||
      userBackingVolume < 0 ||
      userBackingVolume > 200) {
    throw new Error(
        "backing volume should not be able to go out of range, but we got " +
        userBackingVolume);
  }
  if (singer_client) {
    singer_client.send_user_backing_volume(userBackingVolume / 100);
  }
});

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

// userid > consoleChannel div
const consoleChannels = new Map();
window.consoleChannels = consoleChannels;

let monitoredUserId = null;

function mixerMonitorButtonClick(userid) {
  if (singer_client) {
    if (monitoredUserId) {
      consoleChannels.get(monitoredUserId).children[5].classList.remove('activeButton');
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
      consoleChannels.get(userid).children[5].classList.add('activeButton');
      if (!micPaused) {
        toggle_mic();
      }
    }
  }
}

function mixerVolumeChange(userid) {
  if (!singer_client) {
    // XXX: UI doesn't reflect that we can't do this when we're not connected, should have that in the UI controls state machine
    return;
  }

  var newvolume = parseFloat(consoleChannels.get(userid).children[3].value);
  if (newvolume >= 0 && newvolume <= 2) {
    singer_client.x_send_metadata(
      "micVolumes",
      [userid, newvolume],
       true);
  }
  else {
    consoleChannels.get(userid).children[3].value = "invalid";
  }
}

function scalar_volume_to_percentage(rms_volume) {
  let percentage_volume = (((Math.log(rms_volume*1000))/6.908)+1)*50;
  if (percentage_volume < 0 || isNaN(percentage_volume)) {
    percentage_volume = 0;
  }
  else if (percentage_volume > 100) {
    percentage_volume = 100;
  }
  return percentage_volume;
}

let first_bucket_s = DELAY_INTERVAL;
let twilio_token = null;

function estimateBucket(offset_s, clamp=true) {
  let est_bucket = Math.round((offset_s - first_bucket_s) / DELAY_INTERVAL);
  if (!clamp) {
    return est_bucket;
  }

  if (est_bucket >= N_BUCKETS) {
    est_bucket = N_BUCKETS - 1;
  } else if (est_bucket < 0) {
    est_bucket = 0; // this can happen if someone seeks to before bucket #1
  }
  return est_bucket;
}

function update_active_users(
  user_summary, server_sample_rate, leaderId, n_users) {
  const hasLeader = !!leaderId;
  const imLeading = hasLeader && myUserid == leaderId;

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

  window.total_users_connected.innerText = n_users;

  const mic_volume_inputs = [];
  const userids = new Set();

  function removeFromBucket(userid) {
    bucket_divs[user_bucket_index[userid]].removeChild(
      bucket_user_div[userid]);
    delete user_bucket_index[userid];
    delete bucket_user_div[userid];
  }

  const bucketedUserids = new Set();
  for (var i = 0; i < user_summary.length; i++) {
    const offset_s = user_summary[i][0];
    const name = user_summary[i][1];
    const mic_volume = user_summary[i][2];
    const userid = user_summary[i][3];
    const rms_volume = user_summary[i][4];

    let est_bucket = estimateBucket(offset_s);

    if (userid == myUserid) {
      for (var j = 0 ; j < N_BUCKETS; j++) {
        window.buckets.children[j].children[1].disabled =
          (!in_song && !hasLeader) || est_bucket === j;
      }
    }


    mic_volume_inputs.push([name, userid, mic_volume, rms_volume, offset_s]);
    userids.add(userid);

    // Only bucket the first 40 users, for performance.
    // Don't update user buckets when we are not looking at that screen.
    if (i < 40 && window.middle.style.display != "none") {
      bucketedUserids.add(userid);

      if (user_bucket_index[userid] != est_bucket) {
        if (bucket_user_div[userid]) {
          removeFromBucket(userid);
        }

        user_bucket_index[userid] = est_bucket;
        const bucket_div = document.createElement("div");
        bucket_div.classList.add("bucketUser");
        bucket_div.appendChild(document.createTextNode(name));
        bucket_divs[est_bucket].appendChild(bucket_div);
        bucket_user_div[userid] = bucket_div;
      }
    }
  }

  for (const userid in user_bucket_index) {
    if (!bucketedUserids.has(userid)) {
      removeFromBucket(userid);
    }
  }

  // Don't update the mixing console and we are not looking at that screen.
  if (window.debugSettings.style.display == "none") {
    return;
  }
  if (mic_volume_inputs.length == 0) {
    return;   // Restarting
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

      const channelOffset = document.createElement("span");
      channelOffset.classList.add("channelOffset");

      const channelVolume = document.createElement("span");
      channelVolume.classList.add("mixerVolume");

      const channelVolumeIndicator = document.createElement("span");
      channelVolumeIndicator.classList.add("mixerVolumeIndicator");
      channelVolume.appendChild(channelVolumeIndicator);

      const channelVolumeInput = document.createElement("input");
      channelVolumeInput.classList.add("channelVolumeInput");
      channelVolumeInput.type = "text";

      const channelPostVolume = document.createElement("span");
      channelPostVolume.classList.add("mixerVolume");

      const channelPostVolumeIndicator = document.createElement("span");
      channelPostVolumeIndicator.classList.add("mixerVolumeIndicator");
      channelPostVolume.appendChild(channelPostVolumeIndicator);

      channelVolumeInput.addEventListener("change", ()=>{mixerVolumeChange(newUserId)});
      channelVolumeInput.addEventListener("focus", ()=>{
        channelVolumeInput.classList.add("editing");
      });
      channelVolumeInput.addEventListener("focusout", ()=>{
        channelVolumeInput.classList.remove("editing");
        channelVolumeInput.classList.add("edited");
      });

      const monitorButton = document.createElement("button");
      monitorButton.appendChild(document.createTextNode("mon"));
      monitorButton.addEventListener("click", ()=>{mixerMonitorButtonClick(newUserId)});

      consoleChannel.appendChild(channelName);
      consoleChannel.appendChild(channelOffset);
      consoleChannel.appendChild(channelVolume);
      consoleChannel.appendChild(channelVolumeInput);
      consoleChannel.appendChild(channelPostVolume);
      consoleChannel.appendChild(monitorButton);
      window.mixingConsole.appendChild(consoleChannel);
      consoleChannels.set(newUserId, consoleChannel);
    }
  }

  for (var i = 0; i < mic_volume_inputs.length; i++) {

    const name = mic_volume_inputs[i][0];
    const userid = mic_volume_inputs[i][1];
    const vol = mic_volume_inputs[i][2];
    const rms_volume = mic_volume_inputs[i][3];
    const offset_s = mic_volume_inputs[i][4];

    const channel = consoleChannels.get(userid);
    const post_volume = vol < 0.0000001?
      0:
      rms_volume * Math.exp(6.908 * vol) / 1000;
    channel.rms_volume = rms_volume;
    channel.post_volume = post_volume;
    channel.offset_s = offset_s;

    channel.children[0].innerText = name;
    channel.children[1].innerText = offset_s;
    channel.children[2].children[0].style.width =
      scalar_volume_to_percentage(rms_volume)+'%';
    const channelVolumeInput = channel.children[3];
    channel.children[4].children[0].style.width =
      scalar_volume_to_percentage(post_volume)+'%';
    if (channelVolumeInput.classList.contains("editing")) {
      // don't update user volume because they are editing
    }
    else if (channelVolumeInput.classList.contains("edited")) {
      if (Math.abs(channelVolumeInput.value - vol) < 0.001) {
        channelVolumeInput.classList.remove("edited");
      }
    }
    else {
      channelVolumeInput.value = vol;
    }


  }
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

function disable_auto_gain_change() {
  if (singer_client) {
    singer_client.x_send_metadata("disableAutoGain", window.disableAutoGain.checked? 1: 0);
  }
}

startButton.addEventListener("click", start_stop);
window.micToggleButton.addEventListener("click", toggle_mic);
window.speakerToggleButton.addEventListener("click", toggle_speaker);
window.videoToggleButton.addEventListener("click", toggle_video);
clickVolumeSlider.addEventListener("change", click_volume_change);
audioOffset.addEventListener("change", audio_offset_change);
window.disableAutoGain.addEventListener("change", disable_auto_gain_change);
window.recalibrate.addEventListener("click", () => {
  window.sessionStorage.clear();
  window.location.reload();
});

window.startVolumeCalibration.addEventListener("click", () => {
  window.startVolumeCalibration.disabled = true;
  volume_calibrator = new bb.VolumeCalibrator({
    context: bucket_ctx
  })

  volume_calibrator.addEventListener("volumeChange", (event) => {
    window.reportedVolume.innerText = Math.round(100 * event.detail.volume) / 100;
  });
  volume_calibrator.addEventListener("volumeCalibrated", (event) => {
    window.inputGain.value = event.detail.inputGain;
    window.sessionStorage.setItem("clientVolume", event.detail.inputGain);
    window.sessionStorage.setItem("calibrationTs", Date.now());

    switch_app_state(APP_RUNNING);
    volume_calibrator = null;
    start_singing();
  });
});

var last_server_bpm = 0;
var last_server_bpr = 0;
var last_server_repeats = 0;

var song_start_clock = 0;
var song_end_clock = 0;

let in_beforesong = false;  // Have other people started singing?
let in_song = false;  // Is our current position in a song?
let in_aftersong = false;  // Are other people still singing?

let twilio_room = null;

const activeTrackDivs = {};
let myVideoDiv = null;
function connect_twilio() {
  Twilio.Video.createLocalTracks({
    audio: true,
    video: {width: 160}
  }).then(tracks => {
    for (const track of tracks) {
      if (track.kind === "video") {
        myVideoDiv = track.attach();
        document.getElementById('remote-media-div').appendChild(myVideoDiv);
        myVideoDiv.style.transform = 'scale(-1, 1)';
        break;
      }
    }

    Twilio.Video.connect(twilio_token, {
      tracks,
      name: 'BucketBrigade'
    }).then(room => {

      console.log(`Successfully joined a Room: ${room}`);
      twilio_room = room;
      window.videoToggleButton.innerText =
        videoPaused ? "enable video" : "disable video";

      function addTrack(track) {
        console.log("adding track", track);
        if (track.name in activeTrackDivs) {
          console.log("skipping already present track", track);
          return;
        }
        const trackDiv = track.attach();
        activeTrackDivs[track.name] = trackDiv;
        document.getElementById('remote-media-div').appendChild(trackDiv);
      }

      function removeTrack(track) {
        console.log("removing track", track);
        const trackDiv = activeTrackDivs[track.name];
        if (trackDiv) {
          delete activeTrackDivs[track.name];
          document.getElementById('remote-media-div').removeChild(trackDiv);
        }
      }

      function addPublicationOrTrack(publicationOrTrack) {
        console.log("addPublicationOrTrack", publicationOrTrack);

        if (publicationOrTrack.mediaStreamTrack) {
          addTrack(publicationOrTrack);
        } else {
          const publication = publicationOrTrack;
          if (publication.isSubscribed) {
            addTrack(publication.track);
          }
          publication.on('subscribed', addTrack);
          publication.on('unsubscribed', removeTrack);
        }
      }

      function removePublicationOrTrack(publicationOrTrack) {
        if (publicationOrTrack.mediaStreamTrack) {
          removeTrack(publicationOrTrack);
        }
      }

      function addParticipant(participant) {
        participant.tracks.forEach(addPublicationOrTrack);
        participant.on('trackSubscribed', addPublicationOrTrack);
        participant.on('trackUnsubscribed', removePublicationOrTrack);
      }

      function removeParticipant(participant) {
        console.log("removeParticipant", participant);
        participant.tracks.forEach(removeTrack);
      }

      room.on('participantConnected', addParticipant);
      room.on('participantDisconnected', removeParticipant);
      room.participants.forEach(addParticipant);
    }, error => {
      console.error(`Unable to connect to Room: ${error.message}`);
    });
  });
}

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
    console.debug("DIAG:", singer_client.diagnostics);

    window.clientTotalTime.value = singer_client.diagnostics.client_total_time;
    window.clientReadSlippage.value = singer_client.diagnostics.client_read_slippage;
    window.clientTimeToNextClient.value = singer_client.diagnostics.client_time_to_next_client;

    // XXX: this doesn't belong in diagnosticChange, this should be more official elsewhere
    // XXX: also 0.1 is very arbitrary (100ms before we will cause problems for the next person)
    if (singer_client.diagnostics.client_time_to_next_client >
        DELAY_INTERVAL - 0.1) {
      // We have fallen too far behind, we have various options here but we're just going to mute
      //   ourselves for the moment.
      if (!micPaused && !in_spectator_mode) {
        enterLagmute();
      }
    }
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
    var user_summary = metadata["user_summary"];
    var tracks = metadata["tracks"];
    var chats = metadata["chats"] || [];
    var delay_seconds = metadata["delay_seconds"];
    var server_sample_rate = metadata["server_sample_rate"];
    if (metadata["song_start_clock"] != null) {
      song_start_clock = metadata["song_start_clock"];
    }
    if (metadata["song_end_clock"] != null) {
      song_end_clock = metadata["song_end_clock"];
    }
    var client_read_clock = metadata["client_read_clock"];
    var server_bpm = metadata["bpm"];
    var server_repeats = metadata["repeats"];
    var server_bpr = metadata["bpr"];
    var n_connected_users = metadata["n_connected_users"] || 0;

    first_bucket_s = metadata["first_bucket"] || first_bucket_s;

    if (metadata["twilio_token"]) {
      twilio_token = metadata["twilio_token"];
      connect_twilio();
    }

    in_song = song_start_clock && song_start_clock <= client_read_clock &&
      (!song_end_clock || song_end_clock > client_read_clock);

    let leaderName = "";
    for (var i = 0; i < user_summary.length; i++) {
      if (user_summary[i][3] == metadata.leader) {
        leaderName = user_summary[i][1];
      }
    }

    if (leaderName) {
      window.chooseLeaderInstructions.style.display = "none";
      window.activeLeader.style.display = "block";
      window.leaderName.innerText = leaderName;
    } else {
      window.chooseLeaderInstructions.style.display = "block";
      window.activeLeader.style.display = "none";
    }

    update_active_users(user_summary, server_sample_rate, metadata.leader, n_connected_users);

    // XXX: needs to be reimplemented in terms of alarms / marks
    if (song_start_clock && song_start_clock > client_read_clock) {
      window.startSingingCountdown.style.display = "block";
      in_beforesong = true;
      window.startCountdown.innerText = Math.round(
        (song_start_clock - client_read_clock) / server_sample_rate) + "s";
    } else {
      window.startSingingCountdown.style.display = "none";
      in_beforesong = false;

      if (song_end_clock && song_end_clock < client_read_clock) {
        // Figure out the clock that corresponds to the highest active
        // bucket, but don't count users who have manually seat to a
        // position past the last bucket.
        let highest_bucket = 0;
        let my_bucket = 0;
        for (var i = 0; i < user_summary.length; i++) {
          let est_bucket = estimateBucket(user_summary[i][0], /*clamp=*/ false);
          if (est_bucket > highest_bucket && est_bucket < N_BUCKETS) {
            highest_bucket = est_bucket;
          }
          if (user_summary[i][3] == myUserid) {
            my_bucket = est_bucket;
          }
        }

        const effective_end_clock = song_end_clock + (
          (highest_bucket - my_bucket) * DELAY_INTERVAL * server_sample_rate);
        if (effective_end_clock > client_read_clock) {
          in_aftersong = true;
          window.stopSingingCountdown.style.display = "block";
          window.stopCountdown.innerText = Math.round(
            (effective_end_clock - client_read_clock) / server_sample_rate) + "s";
        } else {
          window.stopSingingCountdown.style.display = "none";
          in_aftersong = false;
        }
      } else {
        window.stopSingingCountdown.style.display = "none";
        in_aftersong = false;
      }
    }

    // Either in_song and in_aftersong could have changed above, so
    // check whether we need to mute/unmute Twilio.
    updateTwilioMute();

    chats.forEach((msg) => receiveChatMessage(msg[0], msg[1]));
    if (tracks) {
      update_backing_tracks(tracks);
    }

    if (server_bpm != null) {
      window.bpm.value = server_bpm;
      last_server_bpm = server_bpm;
    }
    if (server_repeats != null) {
      window.repeats.value = server_repeats;
      last_server_repeats = server_repeats;
    }
    if (server_bpr != null) {
      window.bpr.value = server_bpr;
      last_server_bpr = server_bpr;
    }
    singer_client.x_send_metadata("user_summary", 1);

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
        window.sessionStorage.setItem("clientLatency", details.estLatency);
        window.sessionStorage.setItem("calibrationTs", Date.now());
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
  } else if (visitedRecently) {
    switch_app_state(APP_RUNNING);
    window.inputGain.value = parseFloat(window.sessionStorage.getItem("clientVolume"));
    const clientLatency = parseInt(window.sessionStorage.getItem("clientLatency"));
    window.estLatency.innerText = clientLatency + "ms";
    bucket_ctx.send_local_latency(clientLatency);  // XXX: private
    start_singing();
  } else if (!disableLatencyMeasurement.checked) {
    do_latency_calibration();
    switch_app_state(APP_CALIBRATING_LATENCY);
  } else {
    switch_app_state(APP_RUNNING);
    window.estLatency.innerText = UNMEASURED_CLIENT_LATENCY + "ms";
    bucket_ctx.send_local_latency(UNMEASURED_CLIENT_LATENCY);  // XXX: private
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
      if (!window.userName.value) {
        window.userName.value = "listener";
      }
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
