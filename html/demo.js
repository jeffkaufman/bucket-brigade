//import {browserLooksCompatible, MicEnumerator, openMic, BucketBrigadeContext, LatencyCalibrator, VolumeCalibrator, SingerClient, MonitorClient, AudioMark} from './app.js'

import * as bb from './app.js';

const APP_TUTORIAL = "tutorial";
const APP_ROOM_FULL = "roomfull";
const APP_CHOOSE_CAMERA = "choose_camera";
const APP_INITIALIZING = "initializing";
const APP_STOPPED = "stopped";
const APP_STARTING = "starting";
const APP_RUNNING = "running";
const APP_CALIBRATING_LATENCY = "calibrating_latency";
const APP_CALIBRATING_LATENCY_CONTINUE = "calibrating_latency_continue";
const APP_CALIBRATING_VOLUME = "calibrating_volume";
const APP_STOPPING = "stopping";
const APP_RESTARTING = "restarting";

const N_BUCKETS = 6; // Keep in sync with server.py:LAYERING_DEPTH
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
    window.buckets.children[i+1].children[0].children[1].disabled = true;
    audioOffset.value = first_bucket_s + DELAY_INTERVAL * i;
    audio_offset_change();
  }
}

function server_api_path() {
  return new URL(apiPath.value, document.location).href;
}

function server_upload_path() {
  return new URL(uploadPath.value, document.location).href;
}

function updateCurrentUsersText(n) {
  let roomText = "The room is currently empty.";
  if (n) {
    if (n == 1) {
      roomText = "There is currently 1 person in the room.";
    } else {
      roomText = "There are currently " + n + " people in the room.";
    }
  }
  window.currentUsers.innerText = roomText;
}

function updateCurrentUsers() {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', server_api_path() + "?action=status", true);
  xhr.onreadystatechange = function () {
    if (this.readyState === XMLHttpRequest.DONE && this.status === 200) {
      const x_audio_metadata = JSON.parse(this.response);

      if (x_audio_metadata.n_connected_users >= x_audio_metadata.max_users) {
        switch_app_state(APP_ROOM_FULL);
      }

      updateCurrentUsersText(x_audio_metadata.n_connected_users);
      if (x_audio_metadata.n_connected_users > 5 && micState == "on") {
        micState = "onForMusic";
      }

      if (x_audio_metadata.instance_name) {
        window.instanceName.innerText = x_audio_metadata.instance_name;
      }
    }
  };
  xhr.send();
}
updateCurrentUsers();

const user_bucket_index = {};  // userid -> bucket index (-1 means unbucketed)
const bucket_divs = [];  // bucket index -> bucket div

let expectedPasswordHash = null;

for (var i = 0; i < N_BUCKETS; i++) {
  var bucket = document.createElement("div");
  bucket.classList.add("bucket");

  var bucketTitle = document.createElement("div");
  bucketTitle.classList.add("bucketTitle");

  var bucketName = document.createElement("span");
  bucketName.classList.add("bucketName");
  bucketName.appendChild(document.createTextNode(i+1))
  bucketTitle.appendChild(bucketName);

  var joinButton = document.createElement("button");
  joinButton.appendChild(document.createTextNode("join"));
  joinButton.addEventListener("click", joinBucket(i));
  joinButton.disabled = true;
  bucketTitle.appendChild(joinButton);

  bucket.appendChild(bucketTitle);

  var bucketUsers = document.createElement("div");
  bucketUsers.classList.add("bucketUsers");
  bucket_divs.push(bucketUsers);
  bucket.appendChild(bucketUsers);

  window.buckets.appendChild(bucket);
}

let cachedCalendarEvents = [];
let lastCalendarUpdate = null;
async function fetch_calendar_if_needed() {
  if (lastCalendarUpdate && Date.now() - lastCalendarUpdate < 10*60*1000) {
    return;
  }
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/gsc268k1lu78lbvfbhphdr0cs4@group.calendar.google.com/events?key=AIzaSyCDAG5mJmnmi9EaR5SujP70x8kLKOau4Is');
  const data = await response.json();

  if (!data.items) {
    // TODO: Save the error code?
    console.warn("No data from Google Calendar");
    cachedCalendarEvents = [];
    return;
  }

  cachedCalendarEvents = data.items.filter(
      item => item.status === "confirmed").map(item => {
    return {
      start: Date.parse(item.start.dateTime),
      end: Date.parse(item.end.dateTime),
      organizer: item.organizer.displayName || item.organizer.email,
      summary: item.summary,
      description: item.description,
    };
  });
  lastCalendarUpdate = Date.now();
}

async function update_calendar() {
  await fetch_calendar_if_needed();

  if (!lastCalendarUpdate) {
    window.currentEvent.innerText = "(Unable to communicate with Google Calendar.)";
    return;
  }

  let currentEvent = null;
  let upcomingEvent = null;
  const now = Date.now();

  cachedCalendarEvents.forEach(item => {
    // If an event is currently happening we want to check whether
    // that's what people are here for. Similarly, if an event is
    // going to be starting soon we should give people a heads up.

    const msUntilStart = item.start - now;
    const msUntilEnd = item.end- now;

    if (msUntilStart <= 5*60*1000 /* 5min before event */
        && msUntilEnd > 0) {
      currentEvent = {
        summary: item.summary,
        remainingMs: msUntilEnd,
        organizer: item.organizer,
        description: item.description,
      };
    } else if (msUntilStart > 0) {
      if (!upcomingEvent || upcomingEvent.futureMs > msUntilStart) {
        upcomingEvent = {
          summary: item.summary,
          futureMs: msUntilStart,
          organizer: item.organizer,
        }
      }
    }

    expectedPasswordHash = null;
    if (currentEvent) {
      window.currentEvent.innerText =
        "Current Event: " + currentEvent.summary + ".";
      window.eventWelcome.innerText =
        "Right now " + currentEvent.organizer + " is running \"" +
        currentEvent.summary + "\".  If you were invited to attend, great! " +
        "Otherwise, please come back later.";

      if (currentEvent.description) {
        const passwordHashMatch =
              currentEvent.description.match(/pw:([0-9a-f]{64})/);
        if (passwordHashMatch) {
          expectedPasswordHash = passwordHashMatch[1];
        }
      }
    } else if (upcomingEvent) {
      window.currentEvent.innerText = "Next Event: \"" + upcomingEvent.summary +
        "\" in " + prettyTime(upcomingEvent.futureMs) + ".";
      if (upcomingEvent.futureMs < 60*60*1000) {
        window.eventWelcome.innerText =
          "There are no events right now, but in " +
          prettyTime(upcomingEvent.futureMs) + " " +
          upcomingEvent.organizer + " is running \"" +
          upcomingEvent.summary + "\".";
      }
    } else {
      window.currentEvent.innerText = "No Events Scheduled.";
    }
  });
}
update_calendar();
// Update the display once a minute, refetching as needed.
window.setInterval(update_calendar, 60000);

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
  msg.appendChild(name_element);

  for (const message_component of (": " + message).replace(
      /(https:[/][/][^ ]*)/g, "\0$1\0").split("\0")) {
    let msg_body_element = null;
    if (message_component.startsWith("https://")) {
      msg_body_element = document.createElement("a");
      msg_body_element.href = message_component;
      msg_body_element.target = "_blank";
    } else {
      msg_body_element = document.createElement("span");
    }
    msg_body_element.innerText = message_component;
    msg.appendChild(msg_body_element);
  }

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
    window.backingTrackUploader.style.display = "none";
    window.backingTrackUploadOk.style.display = "none";
    window.backingTrackUploadError.style.display = "none";
  } else if (leadButtonState == "start-singing") {
    window.takeLead.textContent = "Stop Singing";
    singer_client.x_send_metadata("markStartSinging", true);
    leadButtonState = "stop-singing";
    window.backingTrack.style.display = "none";
    window.provideLyrics.style.display = "none";
    window.uploadImage.style.display = "none";
    window.imageUploader.style.display = "none";
    window.imageUploadOk.style.display = "none";
    window.imageUploadError.style.display = "none";
    window.uploadBackingTrack.style.display = "none";
    window.backingTrackUploader.style.display = "none";
    window.backingTrackUploadOk.style.display = "none";
    window.backingTrackUploadError.style.display = "none";
  } else if (leadButtonState == "stop-singing") {
    singer_client.x_send_metadata("markStopSinging", true);
    window.takeLead.textContent = "Lead a Song";
    leadButtonState = "take-lead";
  } else {
    throw new Error("unknown state " + leadButtonState);
  }
}

window.takeLead.addEventListener("click", takeLeadClick);

window.uploadBackingTrack.addEventListener("click", () => {
  window.backingTrackUploader.style.display = "inline-block";
  window.uploadBackingTrack.style.display = "none";
  window.backingTrack.style.display = "none";
  window.backingTrackUploadOk.style.display = "none";
  window.backingTrackUploadError.style.display = "none";
});

window.backingTrackUploader.addEventListener("change", () => {
  if (!window.backingTrackUploader.files.length) {
    return;
  }

  if (!window.backingTrackUploader.value.endsWith(".mp3")) {
    window.backingTrackUploadError.innerText = "Only mp3 files are supported.";
    window.backingTrackUploadError.style.display = "inline-block";
    return;
  }

  window.uploadSpinner.style.display = "flex";
  const reader = new FileReader();
  reader.onload = () => {
    if (reader.result.byteLength > 16*1000*1000) {
      window.backingTrackUploadError.innerText = "Only files under 16MB are supported.";
      window.backingTrackUploadError.style.display = "inline-block";
      window.uploadSpinner.style.display = "none";
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', server_upload_path() + "?type=backingTrack", true);
    xhr.onreadystatechange = function () {
      if (this.readyState === XMLHttpRequest.DONE) {
        window.uploadSpinner.style.display = "none";
        window.uploadBackingTrack.style.display = "inline-block";
        window.backingTrackUploader.style.display = "none";
        window.backingTrackUploader.value = null;
        if (this.status === 200) {
          window.backingTrackUploadOk.style.display = "inline-block";
          singer_client.x_send_metadata("backingTrack", "User Upload");
        } else {
          window.backingTrackUploadError.style.display = "inline-block";
          window.backingTrackUploadError.innerText = "Server rejected track.";
        }
      }
    };
    xhr.send(reader.result);
  };
  reader.readAsArrayBuffer(window.backingTrackUploader.files[0]);
});

window.uploadImage.addEventListener("click", () => {
  window.imageUploader.style.display = "inline-block";
  window.uploadImage.style.display = "none";
  window.imageUploadOk.style.display = "none";
  window.imageUploadError.style.display = "none";
});

window.imageUploader.addEventListener("change", () => {
  if (!window.imageUploader.files.length) {
    return;
  }

  window.uploadSpinner.style.display = "flex";
  const reader = new FileReader();
  reader.onload = () => {
    if (reader.result.byteLength > 16*1000*1000) {
      window.imageUploadError.innerText = "Only files under 16MB are supported.";
      window.imageUploadError.style.display = "inline-block";
      window.uploadSpinner.style.display = "none";
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', server_upload_path() + "?type=image", true);
    xhr.onreadystatechange = function () {
      if (this.readyState === XMLHttpRequest.DONE) {
        window.uploadSpinner.style.display = "none";
        window.uploadImage.style.display = "inline-block";
        window.imageUploader.style.display = "none";
        window.imageUploader.value = null;
        if (this.status === 200) {
          window.imageUploadOk.style.display = "inline-block";
          singer_client.x_send_metadata("image", "upload");
        } else {
          window.imageUploadError.style.display = "inline-block";
          window.imageUploadError.innerText = "Server rejected image.";
        }
      }
    };
    xhr.send(reader.result);
  };
  reader.readAsArrayBuffer(window.imageUploader.files[0]);
});

window.provideLyrics.addEventListener("click", () => {
  window.lyricsEntry.style.display = "block";
});

window.lyricsEntryCancel.addEventListener("click", () => {
  window.lyricsEntry.style.display = "none";
  window.lyricsTooLong.style.display = "none";
});

window.lyricsEntryOk.addEventListener("click", () => {
  if (window.lyricsEntryBox.value.length > 8500) {
    window.lyricsTooLong.style.display = "block";
  } else {
    window.lyricsEntry.style.display = "none";
    window.lyricsTooLong.style.display = "none";
    singer_client.send_kv("lyrics", window.lyricsEntryBox.value);
  }
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
    advancedSettingsUpdated();
  }
});

window.latencyCalibrationRetry.addEventListener("click", () => {
  do_latency_calibration();
});

function advancedSettingsUpdated() {
  const metronomeIsOn = (window.bpm.value != 0);
  const roundsAreOn = (window.bpr.value != 0 && window.repeats.value != 0);

  window.advancedSettingsOn.style.display = metronomeIsOn ? "block" : "none";

  window.roundsOn.style.display = roundsAreOn ? "inline-block" : "none";

  window.metronomeValue.innerText = window.bpm.value;
  window.repeatsValue.innerText = window.repeats.value;
  window.bprValue.innerText = window.bpr.value;
}

let in_spectator_mode = false;
let disable_leading = false;
function enableSpectatorMode() {
  // This forcibly mutes us, ignoring the mute button.
  // This is ONLY safe to do at the VERY beginning of things, before we send
  //   any real audio anywhere.
  bucket_ctx.send_ignore_input(true);  // XXX: private
  disable_leading = true;
  in_spectator_mode = true;
  window.spectatorMode.style.display = "block";

  // Make something up.
  window.estLatency.innerText = UNMEASURED_CLIENT_LATENCY + "ms";
  bucket_ctx.send_local_latency(UNMEASURED_CLIENT_LATENCY);  // XXX: private

  // No reason to continue with volume calibration, go right to camera.
  connect_camera();
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
persist_checkbox("presentationMode");
// Don't persist "disable auto gain" because it's an experimental feature

// Persisting select boxes is harder, so we do it manually for inSelect.
inSelect.addEventListener("change", in_select_change);

let inputs_enumerated = false;
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

  if (inSelect.options.length) {
    inputs_enumerated = true;
  } else {
    window.noInputsAvailable.style.display = "block";
  }
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

  setVisibleIn(startButton, allStatesExcept([APP_TUTORIAL, APP_CHOOSE_CAMERA]));

  setVisibleIn(window.roomfull, [APP_ROOM_FULL]);

  setVisibleIn(window.tutorial, [APP_TUTORIAL]);
  setVisibleIn(window.chooseCamera, [APP_CHOOSE_CAMERA]);

  startButton.textContent = ". . .";
  if (app_state == APP_STOPPED) {
    startButton.textContent = "Start";
    startButton.style.display = 'block';
  } else if (app_state != APP_INITIALIZING) {
    startButton.style.display = 'none';
  }

  window.middle.style.overflowY = app_state == APP_RUNNING ? "hidden" : "scroll";

  setVisibleIn(window.advancedSettingsTab, [APP_RUNNING], 'inline-block');
  setVisibleIn(window.debugTab, [APP_RUNNING], 'inline-block');

  setVisibleIn(window.mainApp, allStatesExcept([APP_RUNNING]));
  setVisibleIn(window.topbar, allStatesExcept([APP_RUNNING]));
  setVisibleIn(window.tabbarLogo, [APP_RUNNING]);

  setVisibleIn(window.inputSelector,
               allStatesExcept(ACTIVE_STATES.concat(
                 [APP_TUTORIAL, APP_CHOOSE_CAMERA])));
  setEnabledIn(window.chatPost, allStatesExcept([APP_RESTARTING]));
  setEnabledIn(audioOffset, allStatesExcept([APP_RESTARTING]));

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

  setVisibleIn(window.mainInterface, [APP_RUNNING, APP_RESTARTING], "grid");

  setVisibleIn(window.noAudioInputInstructions, []);

  window.estSamples.innerText = "...";
  window.est25to75.innerText = "...";
  window.estLatency.innerText = "...";

  window.backingTrack.display = "none";
  window.provideLyrics.style.display = "none";
  window.uploadImage.style.display = "none";
  window.imageUploader.style.display = "none";
  window.imageUploadOk.style.display = "none";
  window.imageUploadError.style.display = "none";
  window.uploadBackingTrack.style.display = "none";
  window.backingTrackUploader.style.display = "none";
  window.backingTrackUploadOk.style.display = "none";
  window.backingTrackUploadError.style.display = "none";

  window.buckets.classList.toggle(
    "fullscreen", window.presentationMode.checked);

  updateButtonMutes();
}

window.presentationMode.addEventListener("change", () => {
  window.buckets.classList.toggle(
    "fullscreen", window.presentationMode.checked);
});

window.leavePresentationMode.addEventListener("click", () => {
  window.presentationMode.checked = false;
  window.buckets.classList.remove("fullscreen");
});

function in_select_change() {
  window.localStorage.setItem("inSelect", inSelect.value);
  reset_if_running();
}

const visitedRecently = (
  Date.now() -
    parseInt(window.sessionStorage.getItem("calibrationTs"))) / 1000 / 60 < 30;

var app_state = APP_TUTORIAL;
if (window.disableTutorial.checked || visitedRecently) {
  app_state = APP_CHOOSE_CAMERA;
  enumerate_inputs();
}

var app_initialized = false;

const ALL_STATES = [
  APP_TUTORIAL, APP_CHOOSE_CAMERA, APP_INITIALIZING, APP_STOPPED, APP_STARTING, APP_RUNNING,
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

// If the user has started interacting, and then has not interacted
// for 15 minutes, refresh the page. This keeps users from staying
// connected when they don't mean to, and keeps us from running up a
// large Twilio bill.
const INACTIVITY_TIMEOUT_S = 60*15;
const INACTIVITY_GRACE_S = 60*1;
let last_active_ts = Date.now();
let showingTimeoutSoon = false;
function resetInactivityTimer() {
  last_active_ts = Date.now();
  if (showingTimeoutSoon) {
    window.timeoutImminent.style.display = "none";
    showingTimeoutSoon = false;
  }
}
setInterval(() => {
  if (app_state != APP_TUTORIAL && app_state != APP_CHOOSE_CAMERA &&
      app_state != APP_ROOM_FULL) {
    // App is at least partially running.
    const inactive_time_s = (Date.now() - last_active_ts) / 1000;
    if (inactive_time_s > INACTIVITY_TIMEOUT_S) {
      window.location.reload();
    } else if (inactive_time_s > INACTIVITY_TIMEOUT_S - INACTIVITY_GRACE_S) {
      window.timeoutImminent.style.display = "block";
      showingTimeoutSoon = true;
    }
  }
}, 30000 /* 30s */);

window.addEventListener('scroll', resetInactivityTimer, true);
document.addEventListener("touchmove", resetInactivityTimer);
document.addEventListener("mousemove", resetInactivityTimer);
document.addEventListener("mousedown", resetInactivityTimer);
document.addEventListener("keydown", resetInactivityTimer);
document.addEventListener("keypress", resetInactivityTimer);

async function saltAndHash(message) {
  // Example code from https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
  const msgUint8 = new TextEncoder().encode("bucket_brigade_" + message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

window.reservePassword.addEventListener('input', () => {
  saltAndHash(window.reservePassword.value).then((hashHex) => {
    window.reservePasswordInstructions.style.display = "inline-block";
    window.reserveEncodedPassword.innerText = 'pw:' + hashHex;
  });
});

let in_lagmute_mode = false;
function dismissLagmute() {
  in_lagmute_mode = false;
  window.lagmute.style.display = "none";
  disable_leading = false;
  singer_client.micMuted = micState == "off";
}

function enterLagmute() {
  in_lagmute_mode = true;
  window.lagmute.style.display = "block";
  disable_leading = true;
  singer_client.micMuted = micState == "off";
}

window.unlagmute.addEventListener("click", dismissLagmute);

var micState = "on";
function mic_on() {
  if (singer_client) {
    micState = "on";
    upateMutes();
  }
}
function mic_off() {
  if (singer_client) {
    micState = "off";
    upateMutes();
  }
}
function mic_on_for_music() {
  if (singer_client) {
    micState = "onForMusic";
    upateMutes();
  }
}

let pushToTalkEngaged = false;
window.addEventListener("keydown", (e) => {
  if (e.key === " " && e.path && e.path[0] == document.body &&
      micState == "onForMusic") {
    pushToTalkEngaged = true;
    mic_on();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === " " && pushToTalkEngaged) {
    pushToTalkEngaged = false;
    if (micState == "on") {
      mic_on_for_music();
    }
  }
});

function upateMutes() {
  updateButtonMutes();
  updateTwilioMute();
  updateBucketBrigadeMute();
}

function updateButtonMutes() {
  const running = app_state == APP_RUNNING;
  micOnButton.disabled = !running || micState == "on";
  micOnForMusicButton.disabled = !running || micState == "onForMusic";
  micOffButton.disabled = !running || micState == "off";
}

function updateBucketBrigadeMute() {
  if (!in_spectator_mode && !in_lagmute_mode) {
    disable_leading = micState == "off";
    singer_client.micMuted = micState == "off";
  }
}

function updateTwilioMute() {
  if (twilio_room) {
    twilio_room.localParticipant.audioTracks.forEach(publication => {
      if (micState != "on" || song_active()) {
        publication.track.disable();
      } else {
        publication.track.enable();
      }
    });
  }
  update_video();
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

var disableSongVideo = false;
var videoPaused = false;
var videoOn = false;

function disable_video() {
  if (!videoOn) return;
  videoOn = false;

  twilio_room.localParticipant.videoTracks.forEach(publication => {
    publication.track.stop();
    publication.unpublish();
  });
  if (myVideoDiv) {
    try {
      participantDivs[myUserid].removeChild(myVideoDiv);
    } catch {}
    myVideoDiv = null;
  }
}

async function enable_video() {
  if (videoOn || video_forced_off) return;
  videoOn = true;

  const localVideoTrack = await Twilio.Video.createLocalVideoTrack({
    deviceId: {exact: camera_devices[chosen_camera_index].deviceId},
    width: 160
  });
  twilio_room.localParticipant.publishTrack(localVideoTrack);
  myVideoDiv = localVideoTrack.attach();
  myVideoDiv.style.transform = 'scale(-1, 1)';
  ensureParticipantDiv(myUserid);
  removeMockVideo(participantDivs[myUserid]);
  participantDivs[myUserid].appendChild(myVideoDiv);
}

function update_video() {
  if (twilio_room) {
    if (videoPaused || (disableSongVideo && song_active())) {
      disable_video();
    } else {
      enable_video();
    }
  }
}

function toggle_video() {
  if (twilio_room) {
    videoPaused = !videoPaused;
    window.videoToggleButton.innerText =
      videoPaused ? "enable video" : "disable video";
    update_video();
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

let nMonitoredUsers = 0;
let iterationsWithNoMonitoredUsers = 0;
function mixerMonitorButtonClick(userid) {
  if (singer_client) {
    const monitorButton = consoleChannels.get(userid).children[5];
    monitorButton.classList.add('edited');

    if (monitorButton.classList.contains('activeButton')) {
      singer_client.x_send_metadata("unmonitor", userid);
      nMonitoredUsers--;
    } else {
      window.hearMonitor.checked = true;
      window.hearMonitorDiv.style.display = "block";
      singer_client.x_send_metadata("monitor", userid);
      nMonitoredUsers++;
      iterationsWithNoMonitoredUsers = 0;
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
  user_summary, server_sample_rate, showBuckets, hasLeader, imLeading, n_users) {

  window.takeLead.disabled = disable_leading;
  if (imLeading && leadButtonState != "start-singing" &&
      leadButtonState != "stop-singing") {
    window.takeLead.textContent = "Start Singing";
    leadButtonState = "start-singing";
    //window.backingTrack.style.display = "inline-block";
    window.backingTrack.selectedIndex = 0;
    window.provideLyrics.style.display = "inline-block";
    window.uploadImage.style.display = "inline-block";
    window.uploadBackingTrack.style.display = "inline-block";
  } else if (!imLeading) {
    window.backingTrack.style.display = "none";
    window.provideLyrics.style.display = "none";
    window.uploadImage.style.display = "none";
    window.uploadBackingTrack.style.display = "none";
    if (hasLeader && song_active()) {
      window.takeLead.textContent = "Halt Song";
      leadButtonState = "stop-singing"
      window.takeLead.disabled = false;
    } else {
      window.takeLead.textContent = hasLeader ? "Seize Lead" : "Lead a Song";
      leadButtonState = "take-lead";
    }
  }

  updateCurrentUsersText(n_users);

  const mic_volume_inputs = [];
  const userids = new Set();

  for (var i = 0; i < user_summary.length; i++) {
    const offset_s = user_summary[i][0];
    const name = user_summary[i][1];
    const mic_volume = user_summary[i][2];
    const userid = user_summary[i][3];
    const rms_volume = user_summary[i][4];
    const muted = user_summary[i][5];
    const is_monitored = user_summary[i][6];

    let est_bucket = estimateBucket(offset_s);
    if (window.presentationMode.checked) {
      est_bucket = 0;
    }
    if (!showBuckets) {
      est_bucket = -1;
    }

    if (userid == myUserid) {
      for (var j = 0 ; j < N_BUCKETS; j++) {
        window.buckets.children[j+1].children[0].children[1].disabled =
          (j == 0 && !backingTrackOn && !imLeading) || est_bucket === j;
      }
    }

    mic_volume_inputs.push([name, userid, mic_volume, rms_volume, offset_s, is_monitored]);
    userids.add(userid);

    // Don't update user buckets when we are not looking at that screen.
    if (window.middle.style.display != "none") {
      if (user_bucket_index[userid] != est_bucket) {
        ensureParticipantDiv(userid);
        if (user_bucket_index[userid] == -1) {
          window.unbucketedUsers.removeChild(
            participantDivs[userid]);
        } else if (user_bucket_index[userid] != null) {
          bucket_divs[user_bucket_index[userid]].removeChild(
            participantDivs[userid]);
        }
        user_bucket_index[userid] = est_bucket;
        if (est_bucket == -1) {
          window.unbucketedUsers.appendChild(participantDivs[userid]);
        } else {
          bucket_divs[est_bucket].appendChild(participantDivs[userid]);
        }
      }

      const participantDiv = participantDivs[userid];
      const displayName = userid == myUserid ? (name + " (me)") : name;
      if (participantDiv) {
        if (muted) {
          participantDiv.classList.add("muted");
        } else {
          participantDiv.classList.remove("muted");
        }
      }

      if (participantDiv && participantDiv.name != displayName) {
        // First child is always participantInfo.
        participantDiv.children[0].innerText = displayName;
        participantDiv.name = displayName;
      }
    }

    for (const userid in participantDivs) {
      participantDivs[userid].style.display =
        userids.has(userid) ? "inline-block" : "none";
      if (!userids.has(userid) && user_bucket_index[userid] != -1) {
        if (user_bucket_index[userid] != null) {
          bucket_divs[user_bucket_index[userid]].removeChild(
            participantDivs[userid]);
        }
        window.unbucketedUsers.appendChild(
          participantDivs[userid]);
        user_bucket_index[userid] = -1;
      }
    }
  }

  // Don't update the mixing console and we are not looking at that screen.
  if (window.advancedSettings.style.display == "none") {
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
      monitorButton.appendChild(document.createTextNode("solo"));
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

  nMonitoredUsers = 0;
  for (var i = 0; i < mic_volume_inputs.length; i++) {

    const name = mic_volume_inputs[i][0];
    const userid = mic_volume_inputs[i][1];
    const vol = mic_volume_inputs[i][2];
    const rms_volume = mic_volume_inputs[i][3];
    const offset_s = mic_volume_inputs[i][4];
    const is_monitored = mic_volume_inputs[i][5];

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
    const monitorButton = channel.children[5];
    monitorButton.classList.remove("edited");
    monitorButton.classList.toggle("activeButton", is_monitored);
    if (is_monitored) {
      nMonitoredUsers++;
    }
  }
  if (nMonitoredUsers > 0) {
    iterationsWithNoMonitoredUsers = 0;
  } else {
    iterationsWithNoMonitoredUsers++;
  }
  const definitelyNotMonitoring = iterationsWithNoMonitoredUsers > 3;
  window.hearMonitorDiv.style.display = definitelyNotMonitoring ? "none" : "block";
  if (definitelyNotMonitoring) {
    window.hearMonitor.checked = false;
  }
}

window.hearMonitor.addEventListener("change", () => {
  if (window.hearMonitor.checked) {
    singer_client.x_send_metadata("begin_monitor", 1);
  }
});

async function stop() {
  if (app_state != APP_RUNNING &&
      app_state != APP_CALIBRATING_LATENCY &&
      app_state != APP_CALIBRATING_LATENCY_CONTINUE &&
      app_state != APP_CALIBRATING_VOLUME) {
    console.warn("Trying to stop, but current state is not running or calibrating? Stopping anyway.");
  }
  switch_app_state(APP_STOPPING);

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

function disable_song_video_change() {
  if (singer_client) {
    singer_client.x_send_metadata("disableSongVideo", window.disableSongVideo.checked? 1: 0);
  }
}

startButton.addEventListener("click", start_stop);
window.micOnButton.addEventListener("click", mic_on);
window.micOnForMusicButton.addEventListener("click", mic_on_for_music);
window.micOffButton.addEventListener("click", mic_off);
window.speakerToggleButton.addEventListener("click", toggle_speaker);
window.videoToggleButton.addEventListener("click", toggle_video);
clickVolumeSlider.addEventListener("change", click_volume_change);
audioOffset.addEventListener("change", audio_offset_change);
window.disableAutoGain.addEventListener("change", disable_auto_gain_change);
window.disableSongVideo.addEventListener("change", disable_song_video_change);
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

    volume_calibrator = null;
    connect_camera();
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

function song_active() {
  return in_beforesong || in_song || in_aftersong;
}

let twilio_room = null;

const activeTrackDivs = {};  // name -> track div
const participantDivs = {};  // identity -> tracks for participant
let myVideoDiv = null;

let twilio_tracks = null;
let camera_devices = null;
let chosen_camera_index = 0;

let mockVideos = false;
function ensureParticipantDiv(userid) {
  let div = participantDivs[userid];
  if (!div) {
    div = document.createElement("div");
    div.classList.add("participant");
    participantDivs[userid] = div;

    const info = document.createElement("div");
    info.classList.add("participantInfo");
    div.appendChild(info);

    if (mockVideos) {
      const mockVideo =  document.createElement("img");
      mockVideo.src = "https://www.jefftk.com/bucket-brigade-logo.png";
      div.appendChild(mockVideo);
    }
  }
}

function removeMockVideo(participantDiv) {
  if (!participantDiv) {
    return;
  }
  const imgs = participantDiv.getElementsByTagName("img");
  for (let i = 0 ; i < imgs.length; i++) {
    participantDiv.removeChild(imgs[i]);
  }
}


async function connect_camera() {
  switch_app_state(APP_CHOOSE_CAMERA);
  window.nextCamera.disabled = true;
  window.chosenCamera.disabled = true;
  window.noCamera.disabled = true;

  camera_devices = await navigator.mediaDevices.enumerateDevices();
  camera_devices = camera_devices.filter((device) => device.kind == 'videoinput');

  if (!camera_devices.length) {
    window.noCameraFound.style.display = "block";
    window.cameraPreview.style.display = "none";
    window.nextCamera.style.display = "none";
    window.chosenCamera.style.display = "none";
    return;
  }

  const saved_camera_id = localStorage.getItem("camera_device_id");
  for (var i = 0; i < camera_devices.length; i++) {
    if (camera_devices[i].deviceId === saved_camera_id) {
      chosen_camera_index = i;
    }
  }

  update_preview_camera();
}

async function update_preview_camera() {
  const video_options = {width: 160};

  let have_permission = !!camera_devices[chosen_camera_index].deviceId;
  if (have_permission) {
    video_options.deviceId = {exact: camera_devices[chosen_camera_index].deviceId};
  }

  twilio_tracks = await Twilio.Video.createLocalTracks({
    audio: {deviceId: { exact: inSelect.value }},
    video: video_options
  }).catch((e) => {});

  if (!twilio_tracks) {
    // Probably they don't have a camera.  Try again without video.
    twilio_tracks = await Twilio.Video.createLocalTracks({
      audio: {deviceId: { exact: inSelect.value }}
    });
    window.cameraPreview.style.display = "none";
  }

  // If we enabled this earlier, it would be possible for fast
  // clicking users to continue before we have had a chance to remove
  // the camera
  window.noCamera.disabled = false;

  if (!have_permission) {
    camera_devices = await navigator.mediaDevices.enumerateDevices();
    camera_devices = camera_devices.filter(
      (device) => device.kind == 'videoinput' && device.deviceId);
  }

  for (const track of twilio_tracks) {
    if (track.kind === "video") {
      myVideoDiv = track.attach();
      while (window.cameraPreview.children.length) {
        window.cameraPreview.removeChild(window.cameraPreview.children[0]);
      }
      window.cameraPreview.appendChild(myVideoDiv);
      myVideoDiv.style.transform = 'scale(-1, 1)';
      window.nextCamera.disabled = false;
      window.chosenCamera.disabled = false;
      break;
    }
  }
}

function showMuteNotification() {
  window.muteNotification.style.display = "block";
  window.setTimeout(() => {
    window.muteNotification.style.display = "none";
  }, 30*1000);
}

window.hideMuteNotification.addEventListener("click", () => {
  window.muteNotification.style.display = "none";
});

let video_forced_off = false;
async function selected_camera(useCamera) {
  // We don't want them clicking any buttons while we wait for Twilio to start.
  window.chooseCamera.style.display = "none";

  while (window.cameraPreview.children.length) {
    window.cameraPreview.removeChild(window.cameraPreview.children[0]);
  }

  if (useCamera) {
    localStorage.setItem("camera_device_id",
                         camera_devices[chosen_camera_index].deviceId);
    ensureParticipantDiv(myUserid);
    removeMockVideo(participantDivs[myUserid]);
    participantDivs[myUserid].appendChild(myVideoDiv);
    user_bucket_index[myUserid] = 0;
    bucket_divs[0].appendChild(participantDivs[myUserid]);
    videoOn = true;
  } else {
    video_forced_off = true;
    videoToggleButton.style.display = "none";
    myVideoDiv = null;
    for (const track of twilio_tracks) {
      track.stop();
    }
    twilio_tracks = await Twilio.Video.createLocalTracks({
      audio: true,
      video: false
    });
  }

  switch_app_state(APP_RUNNING);
  if (micState == "onForMusic") {
    showMuteNotification();
  }
  start_singing();
}

window.nextCamera.addEventListener("click", () => {
  chosen_camera_index++;
  if (chosen_camera_index >= camera_devices.length) {
    chosen_camera_index = 0;
  }
  update_preview_camera();
});

let highlightedParticipantIdentity = null;
function highlightParticipantDiv(identity) {
  if (identity === highlightedParticipantIdentity) {
    return;
  }
  Object.keys(participantDivs).forEach(participantIdentity => {
    const participantDiv = participantDivs[participantIdentity];
    if (identity == participantIdentity) {
      participantDiv.classList.add("dominant-speaker");
    } else {
      participantDiv.classList.remove("dominant-speaker");
    }
  });
  highlightedParticipantIdentity = identity;
}

function connect_twilio() {
  Twilio.Video.connect(twilio_token, {
    tracks: twilio_tracks,
    name: 'BucketBrigade',
    dominantSpeaker: true,
  }).then(room => {
    console.log(`Successfully joined a Room: ${room}`);
    twilio_room = room;
    window.videoToggleButton.innerText =
      videoPaused ? "enable video" : "disable video";

    function addTrack(identity) {
      return (track) => {
        console.log("adding track", track);
        if (track.name in activeTrackDivs) {
          console.log("skipping already present track", track);
          return;
        }
        const trackDiv = track.attach();
        activeTrackDivs[track.name] = trackDiv;
        participantDivs[identity].appendChild(trackDiv);
      };
    }

    function removeTrack(identity) {
      return (track) => {
        console.log("removing track", track);
        const trackDiv = activeTrackDivs[track.name];
        if (trackDiv) {
          delete activeTrackDivs[track.name];
          try {
            participantDivs[identity].removeChild(trackDiv);
          } catch {}
        }
      };
    }

    function addPublicationOrTrack(identity) {
      return (publicationOrTrack) => {
        if (publicationOrTrack.mediaStreamTrack) {
          addTrack(identity)(publicationOrTrack);
        } else {
          const publication = publicationOrTrack;
          if (publication.isSubscribed) {
            addTrack(identity)(publication.track);
          }
          publication.on('subscribed', addTrack(identity));
          publication.on('unsubscribed', removeTrack(identity));
        }
      };
    }

    function removePublicationOrTrack(identity) {
      return (publicationOrTrack) => {
        if (publicationOrTrack.mediaStreamTrack) {
          removeTrack(identity)(publicationOrTrack);
        }
      };
    }

    function addParticipant(participant) {
      console.log("addParticipant", participant);
      if (singer_client && !song_active()) {
        singer_client.play_chime();
      }

      ensureParticipantDiv(participant.identity);
      removeMockVideo(participantDivs[myUserid]);

      participant.tracks.forEach(
        addPublicationOrTrack(participant.identity));
      participant.on('trackSubscribed',
                     addPublicationOrTrack(participant.identity));
      participant.on('trackUnsubscribed',
                     removePublicationOrTrack(participant.identity));
    }

    function removeParticipant(participant) {
      console.log("removeParticipant", participant);
      participant.tracks.forEach(removeTrack(participant.identity));

      const div = participantDivs[participant.identity];
      if (div) {
        if (user_bucket_index[participant.identity] == -1) {
          window.unbucketedUsers.removeChild(div);
        } else if (user_bucket_index[participant.identity] != null) {
          bucket_divs[user_bucket_index[participant.identity]].removeChild(div);
        }
        delete participantDivs[participant.identity];
      }
    }

    room.on('dominantSpeakerChanged', participant => {
      if (participant) {
        highlightParticipantDiv(participant.identity);
      }
    });

    room.on('participantConnected', addParticipant);
    room.on('participantDisconnected', removeParticipant);
    room.participants.forEach(addParticipant);
  }, error => {
    console.error(`Unable to connect to Room: ${error.message}`);
  });
}

let backingTrackOn = false;
async function start_singing() {
  var final_url = server_api_path();

  singer_client = new bb.SingerClient({
    context: bucket_ctx,
    apiUrl: final_url,
    secretId: myUserid, // XXX
    speakerMuted: speakerPaused,
    micMuted: micState == "off",
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
      if (micState != "off" && !in_spectator_mode) {
        enterLagmute();
      }
    }
  });

  singer_client.addEventListener("underflow", () => {
    updateHealthLog(/*isUnderflow=*/true);
  });

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
    song_start_clock = metadata["song_start_clock"];
    song_end_clock = metadata["song_end_clock"];
    var client_read_clock = metadata["client_read_clock"];
    var server_bpm = metadata["bpm"];
    var server_repeats = metadata["repeats"];
    var server_bpr = metadata["bpr"];
    var n_connected_users = metadata["n_connected_users"] || 0;
    if (metadata["disableSongVideo"] != null) {
      disableSongVideo = metadata["disableSongVideo"];
      update_video();
    }
    if (metadata["globalVolume"] != null) {
      window.globalVolumeControl.value = metadata["globalVolume"];
    }
    if (metadata["backingVolume"] != null) {
      window.backingVolumeControl.value = metadata["backingVolume"];
    }
    if (metadata["backing_track_type"] != null) {
      const backingTrackType = metadata["backing_track_type"];
      backingTrackOn = !!backingTrackType;
      window.backingSliderDiv.style.display =
        backingTrackOn ? "block" : "none";
      window.backingTrackTypeName.innerText = backingTrackType;
    }

    first_bucket_s = metadata["first_bucket"] || first_bucket_s;

    if (metadata["twilio_token"]) {
      twilio_token = metadata["twilio_token"];
      connect_twilio();
    }

    if (metadata["lyrics"]) {
      window.lyricsDisplay.value = metadata["lyrics"];
      window.lyricsDisplay.style.display = "block";
      window.imageDisplay.style.display = "none";
    }

    if (metadata["image"]) {
      window.imageDisplayImg.src = "user-upload-image?" + metadata["image"];
      window.imageDisplay.style.display = "block";
      window.lyricsDisplay.style.display = "none";
    }

    let startSingingCountdown = null;
    let stopSingingCountdown = null;

    updateHealthLog(/*isUnderflow=*/false);

    if (user_summary.length) {
      in_song = song_start_clock && song_start_clock <= client_read_clock &&
        (!song_end_clock || song_end_clock > client_read_clock);

      let leaderName = "";
      for (var i = 0; i < user_summary.length; i++) {
        if (user_summary[i][3] == metadata.leader) {
          leaderName = user_summary[i][1];
        }
      }

      const hasLeader = !!leaderName;
      const imLeading = metadata.leader == myUserid

      // XXX: needs to be reimplemented in terms of alarms / marks
      if (song_start_clock && song_start_clock > client_read_clock) {
        in_beforesong = true;
        startSingingCountdown = Math.round(
          (song_start_clock - client_read_clock) / server_sample_rate);
      } else {
        in_beforesong = false;

        if (song_end_clock && song_end_clock < client_read_clock) {
          // Figure out the clock that corresponds to the highest active
          // bucket, but don't count users who have manually seeked to a
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
            stopSingingCountdown = Math.round(
              (effective_end_clock - client_read_clock) / server_sample_rate);
          } else {
             in_aftersong = false;
          }
        } else {
           in_aftersong = false;
        }
      }

      // Either in_song and in_aftersong could have changed above, so
      // check whether we need to mute/unmute Twilio.
      updateTwilioMute();

      if (song_active()) {
        highlightParticipantDiv(null);
      }

      if (stopSingingCountdown != null) {
        window.runningStatus.innerText =
          "Waiting for later buckets to finish: " + stopSingingCountdown + "s.";
      } else if (startSingingCountdown != null) {
        window.runningStatus.innerText =
          "Waiting for the song to reach this bucket: " +
          startSingingCountdown + "s.";
      } else if (imLeading) {
        if (in_song) {
          window.runningStatus.innerText = "Press 'stop singing' when done.";
        } else {
          window.runningStatus.innerText =
            "Press 'start singing' when ready to begin.";
        }
      } else if (hasLeader) {
        if (in_song) {
          window.runningStatus.innerText = leaderName + " has started.";
        } else {
          window.runningStatus.innerText = leaderName + " is preparing to start.";
        }
      } else if (song_active()) {
        window.runningStatus.innerText =
          "The song has ended for some buckets, but not your bucket yet.";
      } else {
        window.runningStatus.innerText =
          "Talk to each other and figure out who's going to lead the next song.";
      }

      const showBuckets = hasLeader || song_active();
      window.buckets.style.display = showBuckets ? (
        window.presentationMode.checked ? "block" : "flex") : "none";
      window.unbucketedUsers.style.display = showBuckets ? "none" : "block";

      if (!showBuckets) {
        window.lyricsDisplay.style.display = "none";
        window.imageDisplay.style.display = "none";
      }

      const showBucketingGuide = hasLeader && !song_active();
      window.bucketingGuide.style.display =
        showBucketingGuide ? "block" : "none";

      update_active_users(user_summary, server_sample_rate, showBuckets,
                          hasLeader, imLeading, n_connected_users);
    }

    chats.forEach((msg) => receiveChatMessage(msg[0], msg[1]));
    if (tracks) {
      update_backing_tracks(tracks);
    }

    if (server_bpm != null) {
      window.bpm.value = server_bpm;
      last_server_bpm = server_bpm;
      advancedSettingsUpdated();
    }
    if (server_repeats != null) {
      window.repeats.value = server_repeats;
      last_server_repeats = server_repeats;
      advancedSettingsUpdated();
    }
    if (server_bpr != null) {
      window.bpr.value = server_bpr;
      last_server_bpr = server_bpr;
      advancedSettingsUpdated();
    }
    if (micState == "off" || (micState == "onForMusic" && !song_active())) {
      singer_client.x_send_metadata("muted", 1);
    }
    singer_client.x_send_metadata("user_summary", 1);
    if (in_spectator_mode || window.presentationMode.checked ||
        micState == "off") {
      singer_client.x_send_metadata("spectator", 1);
    }
    if (window.hearMonitor.checked) {
      singer_client.x_send_metadata("hear_monitor", 1);
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
  if (document.location.hostname == "localhost") {
    // Better defaults for debugging.
    window.apiPath.value = "http://localhost:8081/"
    window.uploadPath.value = "http://localhost:8082/"
  }

  app_initialized = true;
  if (app_state != APP_TUTORIAL) {
    switch_app_state(APP_STOPPED);
  }
}

function do_latency_calibration() {
  var this_calibration_running = true;
  switch_app_state(APP_CALIBRATING_LATENCY);
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
      var this_calibration_running = false;
    }
  });

  // If we've been running for 20 seconds, and still haven't figured
  // it out, give up.
  setTimeout(() => {
    if (this_calibration_running && latency_calibrator) {
      this_calibration_running = false;
      latency_calibrator.close();
      switch_app_state(APP_CALIBRATING_LATENCY_CONTINUE);
    }
  }, 20*1000);
}

// XXX this is way too complicated for the algorithm I ended up
// implementing.  Instead we should just track how long ago the most
// recent underflow was.
const healthHistory = [];
const HEALTH_HISTORY_LENGTHS = [
  2,
  4,
  8,
  16,
  32,
  64,
];
HEALTH_HISTORY_LENGTHS.forEach((len) => {
  const buf = [];
  for (let i = 0; i < len; i++) {
    buf.push(0);
  }
  healthHistory.push(buf);
});

const HEALTH_COLORS = [
  "rgb(128, 0, 0)",     // bad now
  "rgb(128, 64, 0)",    // bad within 2s
  "rgb(128, 85, 0)",    // bad within 4s
  "rgb(128, 106, 0)",   // bad within 8s
  "rgb(128, 128, 0)",   // bad within 16s
  "rgb(106, 128, 0)",   // bad within 32s
  "rgb(85, 128, 0)",    // bad within 64s
  "rgb(42, 128, 0)",    // full healthy
];

function updateHealthLog(isUnderflow) {
  let health = -1;
  for (let i = 0 ; i < healthHistory.length; i++) {
    healthHistory[i].shift();
    healthHistory[i].push(isUnderflow ? 1 : 0);

    const isHealthy = (healthHistory[i].reduce((a, b) => a + b, 0) == 0);
    const healthElement = document.getElementById("health" + (i+1));
    healthElement.classList.toggle("healthy", isHealthy);
  }
}

async function start(spectatorMode=false) {
  var micStream = await bb.openMic(inSelect.value);
  try {
    console.log("Reported input latency (s):",
                micStream.getTracks()[0].getSettings().latency);
  } catch {}

  bucket_ctx = new bb.BucketBrigadeContext({
    micStream,
  });

  await bucket_ctx.start_bucket();

  if (spectatorMode) {
    enableSpectatorMode();
  } else if (visitedRecently) {
    connect_camera();
    window.inputGain.value = parseFloat(window.sessionStorage.getItem("clientVolume"));
    const clientLatency = parseInt(window.sessionStorage.getItem("clientLatency"));
    window.estLatency.innerText = clientLatency + "ms";
    bucket_ctx.send_local_latency(clientLatency);  // XXX: private
  } else if (!disableLatencyMeasurement.checked) {
    do_latency_calibration();
  } else {
    connect_camera();
    window.estLatency.innerText = UNMEASURED_CLIENT_LATENCY + "ms";
    bucket_ctx.send_local_latency(UNMEASURED_CLIENT_LATENCY);  // XXX: private
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

async function tutorial_answer(button) {
  enumerate_inputs();

  const answer = button.innerText;
  const question = button.parentElement.id;

  if (question === "q_name") {
    if (!window.userName.value) {
      window.needName.style.display = "block";
      return;
    } else {
      hide_buttons_and_append_answer(button.parentElement, window.userName.value);
    }
  } else if (question === "q_password") {
    // This is not intended to keep out a serious attacker. We would
    // have to handle passwords on the server for that.
    const providedPasswordHash = await saltAndHash(window.enteredPassword.value);
    if (providedPasswordHash != expectedPasswordHash) {
      window.wrongPassword.style.display = "block";
      return;
    } else {
      hide_buttons_and_append_answer(
        button.parentElement,
        Array.from(window.enteredPassword.value).map(() => "*").join(""));
    }
  } else {
    hide_buttons_and_append_answer(button.parentElement, button.innerText);
  }

  if (question === "q_name") {
    if (expectedPasswordHash) {
      window.q_password.style.display = 'block';
    } else {
      window.q_singing_listening.style.display = 'block';
    }
  } else if (question === "q_password") {
    window.q_singing_listening.style.display = 'block';
  } else if (question === "q_singing_listening") {
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

window.chosenCamera.addEventListener("click", () => {
  selected_camera(true);
});

window.noCamera.addEventListener("click", () => {
  selected_camera(false);
});

window.changeNameButton.addEventListener("click", () => {
  window.userName.value = window.changeName.value;
  localStorage.setItem("userName", window.userName.value);
  if (singer_client) {
    singer_client.updateUserName(window.userName.value);
  }
});
window.userName.addEventListener("change", () => {
  window.changeName.value = window.userName.value;
});
window.changeName.value = window.userName.value;

document.querySelectorAll("#tutorial_questions button").forEach(
  (button) => button.addEventListener("click", () => tutorial_answer(button)));

initialize();
