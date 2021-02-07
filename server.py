#!/usr/bin/env python3

import os
import pprint

import json
import urllib.parse
import time
import numpy as np  # type:ignore
import random
import math
import os
import logging
import wave
import threading
import datetime
import struct
import subprocess
import copy
import sys
import string

from typing import Any, Dict, List, Tuple, Iterable

sys.path.append(os.path.dirname(__file__)) # for finding our files
import util

logging.basicConfig(filename='server.log',level=logging.DEBUG)

# big-endian
#  8   userid: uint64
# 32   name: 32 bytes of utf8, '\0' padded
#  4   mic_volume: float32,
#  4   rms_volume: float32
#  2   delay: uint16
#  1   muted: uint8
BINARY_USER_CONFIG_FORMAT = struct.Struct(">Q32sffHB")

FRAME_SIZE = 128

N_IMAGINARY_USERS = 0  # for debugging user summary + mixing console performance

SUPPORT_SERVER_CONTROL = False

# The maximum number of users to allow to join.  This is enforced on a
# best-effort basis by the client.  If many people are calibrating at
# the same time this will be exceeded, because we only check before
# calibration.
#
# In stress testing, the server seems to do fine with 61 users, but
# the video call might change that (stress test includes no video).
MAX_USERS = 35 # XXX needs tuning

try:
    # Grab these on startup, when they are very very likely to be the actual
    #   running version.
    SERVER_VERSION = subprocess.check_output(
        ["git", "rev-parse", "--short", "HEAD"]).strip().decode("utf-8")
    SERVER_BRANCH = subprocess.check_output(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"]).strip().decode("utf-8")
except Exception:
    SERVER_VERSION="unknown"
    SERVER_BRANCH="unknown"

SERVER_STARTUP_TIME = int(time.time())

ENABLE_TWILIO = True
SECRETS_FNAME = "secrets.json"

secrets = {}
if os.path.exists(SECRETS_FNAME):
    with open(SECRETS_FNAME) as inf:
        secrets = json.loads(inf.read())
else:
    ENABLE_TWILIO = False

if ENABLE_TWILIO:
    from twilio.jwt.access_token import AccessToken
    from twilio.jwt.access_token.grants import VideoGrant

class State():
    def __init__(self):
        self.reset()

    def reset(self):
        self.server_controlled = False

        self.last_request_clock = None
        self.last_cleared_clock = None
        self.global_volume = 1.2
        self.backing_volume = 1.0
        self.song_end_clock = 0
        self.song_start_clock = 0
        self.requested_track: Any = None

        self.bpm = 0
        self.repeats = 0
        self.bpr = 0
        self.leftover_beat_samples = 0

        self.first_bucket = DELAY_INTERVAL

        self.leader = None

        self.backing_track: Any = np.zeros(0)
        self.backing_track_index = 0
        self.backing_track_type = ""

        self.max_position = DELAY_INTERVAL*LAYERING_DEPTH

        self.disable_auto_gain = False
        self.disable_song_video = False

        self.lyrics = ""
        self.image = None

        if recorder:
            recorder.reset()

def friendly_volume_to_scalar(volume):
    if volume < 0.0000001:
        return 0
    # https://www.dr-lex.be/info-stuff/volumecontrols.html
    return math.exp(6.908 * volume) / 1000

def scalar_to_friendly_volume(scalar):
    if scalar < 0.0001:
        return 0
    return math.log(scalar * 1000)/6.908

LEADER_BOOST = friendly_volume_to_scalar(1.1)

QUEUE_SECONDS = 120

SAMPLE_RATE = 48000

# How often to print status updates. With no requests are coming in no status
# update will be printed.
STATUS_PRINT_INTERVAL_S = 10

# Leave this much space between users. Ideally this would be very
# short, but it needs to be long enough to cover "client total time
# consumed" or else people won't all hear each other.
DELAY_INTERVAL = 3  # 3s; keep in sync with demo.js:DELAY_INTERVAL and
                    # index.html:audioOffset

# How many links to use for the chain of users before starting to double up.
LAYERING_DEPTH = 6  # keep in sync with demo.js:N_BUCKETS and
                    # index.html:audioOffset

# If we have not heard from a user in N seconds, forget all about them.
USER_LIFETIME_SAMPLES = SAMPLE_RATE * 60 * 60  # 1hr

# If we have not heard from a user in N seconds, don't consider them a
# current user.
USER_INACTIVE_SAMPLES = SAMPLE_RATE * 5  # 5s

# Force rounding to multiple of FRAME_SIZE
QUEUE_LENGTH = (QUEUE_SECONDS * SAMPLE_RATE // FRAME_SIZE * FRAME_SIZE)

audio_queue = np.zeros(QUEUE_LENGTH, np.float32)
backing_queue = np.zeros(QUEUE_LENGTH, np.float32)
monitor_queue = np.zeros(QUEUE_LENGTH, np.float32)
n_people_queue = np.zeros(QUEUE_LENGTH, np.int16)

def clear_whole_buffer():
    audio_queue.fill(0)
    backing_queue.fill(0)
    monitor_queue.fill(0)
    n_people_queue.fill(0)

# For volume scaling.
N_PHANTOM_PEOPLE = 2


RECORDINGS_DIRNAME = "recordings"
RECORDINGS_DIR = os.path.join(
    os.path.dirname(__file__), "html", RECORDINGS_DIRNAME)
RECORDING_LISTING_HTML = os.path.join(RECORDINGS_DIR, "index.html")
RECORDING_N_TO_KEEP = 20  # keep most recent only
RECORDING_MAX_S = 60*60 # 1hr
RECORDING_MAX_SAMPLES = RECORDING_MAX_S * SAMPLE_RATE

RECORDING_ENABLED = True

class Recorder:
    def __init__(self):
        self.out = None
        self.written = 0
        self.last_clock = None

    @staticmethod
    def recording_fname():
        return os.path.join(
            RECORDINGS_DIR,
            datetime.datetime.now().strftime('%Y-%m-%d-%H%M%S.wav'))

    @staticmethod
    def read_offset():
        # While we want to read from the specified clock position in
        # the buffer, we don't want to do that until enough time has
        # passed that whoever was going to sing has had a chance to.
        return (state.max_position + DELAY_INTERVAL*2)*SAMPLE_RATE

    def start_(self):
        self.cleanup_()

        self.out = wave.open(self.recording_fname(), mode='wb')
        self.out.setnchannels(1)
        self.out.setsampwidth(2)
        self.out.setframerate(SAMPLE_RATE)

        self.written = 0
        self.last_clock = state.song_start_clock - 1

    def end_(self):
        self.out.close()
        self.out = None

    def write_(self, samples):
        self.out.writeframes((samples * 2**14).astype(np.int16))
        self.written += len(samples)

    def reset(self):
        if self.out:
            self.end_()

    def maybe_write(self, server_clock):
        if self.out:
            pass
        elif (state.song_start_clock and
            (state.song_start_clock + self.read_offset() <
             server_clock <
             state.song_start_clock + self.read_offset() + SAMPLE_RATE*5)):
            self.start_()
        else:
            return

        # Write any samples the desk that are now ready for writing.
        # - The first unwritten sample is last_clock + 1
        # - The last eligible sample is server_clock + read_offset
        #   - Unless song_end_clock comes first
        begin = self.last_clock + 1
        end = server_clock - self.read_offset()
        ready_to_close = False
        if state.song_end_clock and state.song_end_clock < end:
            end = state.song_end_clock
            ready_to_close = True

        n_samples = end - begin
        if n_samples > QUEUE_LENGTH:
            # Something has gone horribly wrong, probably involving
            # losing and regaining connectivity in the middle of a
            # song.  Oh well.
            n_samples = QUEUE_LENGTH

        if n_samples > 0:
            self.write_(fix_volume(
                wrap_get(audio_queue, begin, n_samples),
                wrap_get(backing_queue, begin, n_samples),
                wrap_get(n_people_queue, begin, n_samples)))
            self.last_clock += n_samples

        if ready_to_close or self.written > RECORDING_MAX_SAMPLES:
            self.end_()
            self.update_directory_listing_()

    def update_directory_listing_(self):
        with open(RECORDING_LISTING_HTML, 'w') as outf:
            def w(s):
                outf.write(s)
                outf.write("\n")
            w("All times (and dates!) are in UTC.")
            w("<ul>")
            for fname in reversed(sorted(os.listdir(RECORDINGS_DIR))):
                if not fname.endswith(".wav"):
                    continue
                size = os.path.getsize(os.path.join(RECORDINGS_DIR, fname))
                size_mb = size / 1024 / 1024
                w("<li><a href='%s'>%s</a> (%.2f MB)" % (
                    fname, fname, size_mb))
            w("</ul>")
            w("Because these files are large we only keep the most recent %s" %
              RECORDING_N_TO_KEEP)

    def cleanup_(self):
        recordings = os.listdir(RECORDINGS_DIR)
        if len(recordings) <= RECORDING_N_TO_KEEP:
            return

        for fname in sorted(recordings)[:-RECORDING_N_TO_KEEP]:
            if fname != ".keep":
                os.remove(os.path.join(RECORDINGS_DIR, fname))
        self.update_directory_listing_()

recorder = Recorder() if RECORDING_ENABLED else None

state = State()

events: Dict[str, str] = {}

tracks = []
def populate_tracks() -> None:
    for track in sorted(os.listdir(util.AUDIO_DIR)):
        if track != "README":
            tracks.append(track)

populate_tracks()

def insert_event(evid, clock) -> None:
    events[evid] = clock

def calculate_server_clock():
    # Note: This will eventually create a precision problem for the JS
    #   clients, which are using floats. Specifically, at 44100 Hz, it will
    #   fail on February 17, 5206.
    return int(time.time() * SAMPLE_RATE)

class User:
    def __init__(self, userid, name, last_heard_server_clock, delay_samples) -> None:
        self.list_keys = ["chats"]

        self.userid = userid
        if len(name) > 32:
            name = name[:29] + "..."
        self.name = name
        self.last_heard_server_clock = last_heard_server_clock
        self.delay_samples = delay_samples

        self.mic_volume = 1.0
        self.scaled_mic_volume = 1.0
        self.last_write_clock = None
        self.is_monitored = False
        self.is_monitoring = False
        self.rms_volume = 0

        self.backing_volume = 1.0

        # For debugging purposes only
        self.last_seen_read_clock = None
        self.last_seen_write_clock = None
        self.last_n_samples = None

        self.client_address = None  # Last IP we saw them from
        self.client_telemetry = {}  # unstructured info from client

        self.in_spectator_mode = False;
        self.muted = False;

        self.mark_sent()

        self.send("bpm", state.bpm)
        self.send("repeats", state.repeats)
        self.send("bpr", state.bpr)
        self.send("tracks", tracks)
        self.send("first_bucket", state.first_bucket)
        self.send("globalVolume",
                  scalar_to_friendly_volume(state.global_volume))
        self.send("backingVolume",
                  scalar_to_friendly_volume(state.backing_volume))
        if state.disable_song_video:
            self.send("disableSongVideo", state.disable_song_video)
        if state.lyrics:
            self.send("lyrics", state.lyrics)
        if state.image:
            self.send("image", state.image)

    def allocate_twilio_token(self):
        token = AccessToken(secrets["twilio"]["account_sid"],
                            secrets["twilio"]["api_key"],
                            secrets["twilio"]["api_secret"],
                            identity=self.userid)

        # Create a Video grant and add to token
        video_grant = VideoGrant(room=secrets["twilio"]["room"])
        token.add_grant(video_grant)

        jwt = token.to_jwt()
        if type(jwt) == type(b""):
            jwt = jwt.decode('utf8')
        self.send("twilio_token", jwt)

    # XXX: Are we sure we do not need to clear any of the other state across reconnects???
    def flush(self) -> None:
        """Delete any state that shouldn't be persisted across reconnects"""
        self.last_seen_read_clock = None
        self.last_seen_write_clock = None

    def send(self, key, value):
        if key in self.list_keys:
            self.to_send[key].append(value)
        else:
            self.to_send[key] = value

    def mark_sent(self):
        self.to_send = {}
        for key in self.list_keys:
            self.to_send[key] = []

    def update_client_telemetry(self, nct):
        if not isinstance(nct, dict):
            raise Exception("New client telemetry not a dict:", nct)
        merge_into_dict(self.client_telemetry, nct)

def merge_into_dict(a, b):
    for k in b:
        if k not in a:
            a[k] = b[k]
        elif isinstance(a[k], list) and isinstance(b[k], list):
            a[k] += b[k]
        elif isinstance(a[k], dict) and isinstance(b[k], dict):
            merge_into_dict(a[k], b[k])
        else:
            a[k] = b[k]

users: Dict[str, Any] = {} # userid -> User
imaginary_users = []
def sendall(key, value, exclude=None):
    for user in active_users():
        if not exclude or user.userid not in exclude:
            user.send(key, value)

def wrap_get(queue, start, len_vals) -> Any:
    start_in_queue = start % len(queue)

    if start_in_queue + len_vals <= len(queue):
        return np.copy(queue[start_in_queue:(start_in_queue+len_vals)])
    else:
        second_section_size = (start_in_queue + len_vals) % len(queue)
        first_section_size = len_vals - second_section_size
        assert second_section_size > 0
        assert first_section_size > 0

        return np.concatenate([
            queue[start_in_queue:(start_in_queue+first_section_size)],
            queue[0:second_section_size]
            ])

def wrap_assign(queue, start, vals) -> None:
    assert len(vals) <= len(queue)
    start_in_queue = start % len(queue)

    if start_in_queue + len(vals) <= len(queue):
        queue[start_in_queue:(start_in_queue+len(vals))] = vals
    else:
        second_section_size = (start_in_queue + len(vals) )% len(queue)
        first_section_size = len(vals) - second_section_size
        assert second_section_size > 0
        assert first_section_size > 0

        queue[start_in_queue:(start_in_queue+first_section_size)] = vals[:first_section_size]
        queue[0:second_section_size] = vals[first_section_size:]

def run_backing_track() -> None:
    if state.requested_track in tracks:
        with wave.open(os.path.join(util.AUDIO_DIR, state.requested_track)) as inf:
            if inf.getnchannels() != 1:
                raise Exception(
                    "wrong number of channels on %s" % state.requested_track)
            if inf.getsampwidth() != 2:
                raise Exception(
                    "wrong sample width on %s" % state.requested_track)
            if inf.getframerate() != 48000:
                raise Exception(
                    "wrong sample rate on %s" % state.requested_track)

            state.backing_track = np.frombuffer(
                inf.readframes(-1), np.int16).astype(np.float32) / (2**15)
            state.backing_track *= 0.8 # turn it down a bit
            state.backing_track_index = 0
            state.backing_track_type = "Backing Track"

    # Backing track is used only once.
    state.requested_track = None

def assign_delays(userid_lead) -> None:
    initial_position = 0

    repeat_length_s = None
    if state.bpr and state.bpm and state.repeats:
        beat_length_s = 60 / state.bpm
        repeat_length_s = beat_length_s * state.bpr
        initial_position += int(repeat_length_s*state.repeats)

    if initial_position > 90:
        initial_position = 90

    real_users = [user for user in active_users() if user not in imaginary_users]
    leader = users[userid_lead]
    spectators = [
        user for user in real_users
        if user.in_spectator_mode and user.userid != userid_lead]
    followers = [
        user for user in real_users
        if not user.in_spectator_mode and user.userid != userid_lead]

    # Only the leader goes in bucket #1
    state.first_bucket = initial_position + DELAY_INTERVAL
    leader.send("delay_seconds", state.first_bucket)
    sendall("first_bucket", state.first_bucket)

    max_follow_buckets = LAYERING_DEPTH - 1
    print("max_follow_buckets: %s" % max_follow_buckets)
    if repeat_length_s:
        print("repeat_length_s: %s" % repeat_length_s)
        layers_audible_to_leader = repeat_length_s // DELAY_INTERVAL
        print("layers_audible_to_leader: %s" % layers_audible_to_leader)
        if layers_audible_to_leader < 1:
            layers_audible_to_leader = 1
        max_follow_buckets = min(max_follow_buckets, layers_audible_to_leader)
        print("max_follow_buckets: %s" % max_follow_buckets)

    n_follow_buckets = int(max(min(max_follow_buckets, len(followers)), 1))
    print("n_follow_buckets: %s" % n_follow_buckets)

    follow_positions = [
        initial_position + (x+2)*DELAY_INTERVAL
        for x in range(n_follow_buckets)]
    state.max_position = follow_positions[-1]

    # Spectators all go in the last bucket.
    for spectator in spectators:
        spectator.send("delay_seconds", state.max_position)

    # Distribute followers randomly between the remaining buckets.
    for i, (_, user) in enumerate(sorted(
            [(random.random(), follower)
             for follower in followers])):
        user.send("delay_seconds",
                  follow_positions[(len(follow_positions) - 1 - i) %
                                   len(follow_positions)])

def update_users(userid, username, server_clock, client_read_clock) -> None:
    while len(imaginary_users) < N_IMAGINARY_USERS:
        imaginary_user = User(
            str(random.randint(0,2**32)),
            "imaginary_%s" % (len(imaginary_users)),
            server_clock,
            SAMPLE_RATE * 7)
        imaginary_users.append(imaginary_user)
        users[imaginary_user.userid] = imaginary_user

    for user in imaginary_users:
        user.last_heard_server_clock = server_clock
        user.rms_volume = random.random() / 10
        user.delay_samples = (
            SAMPLE_RATE *
            DELAY_INTERVAL *
            random.randint(1,LAYERING_DEPTH))

    # Delete expired users BEFORE adding us to the list, so that our session
    #   will correctly reset if we are the next customer after we've been gone
    #   for awhile.
    clean_users(server_clock)

    delay_samples = server_clock - client_read_clock
    if userid not in users:
        users[userid] = User(userid, username, server_clock, delay_samples)
        if ENABLE_TWILIO:
            users[userid].allocate_twilio_token()

    users[userid].last_heard_server_clock = server_clock
    users[userid].delay_samples = delay_samples
    users[userid].name = username

def clean_users(server_clock) -> None:
    to_delete = []
    for userid, user in users.items():
        age_samples = server_clock - user.last_heard_server_clock
        if age_samples > USER_LIFETIME_SAMPLES:
            to_delete.append(userid)
    for userid in to_delete:
        del users[userid]

    # If we have ever seen a server-to-server request, we never reset state,
    #   because the Ritual Engine server may need to perform operations when no
    #   users are present.
    if not active_users() and not state.server_controlled:
        state.reset()

def samples_to_position(samples):
    return round(samples / SAMPLE_RATE)

def jump_user_after(user, position):
    target = position + DELAY_INTERVAL
    if target == samples_to_position(user.delay_samples):
        return
    user.send("delay_seconds", target)

def max_monitor_position():
    max_delay_samples = 0
    for user in active_users():
        if user.is_monitored and user.delay_samples > max_delay_samples:
            max_delay_samples = user.delay_samples
    return samples_to_position(max_delay_samples)

def jump_to_latest_monitored_user(user):
    max_pos = max_monitor_position()
    current_pos = samples_to_position(user.delay_samples)
    if max_pos > 0:
        jump_user_after(user, max_pos)

def jump_monitors_to_latest_monitored_user():
    for user in active_users():
        if user.is_monitoring:
            jump_to_latest_monitored_user(user)

def active_users():
    server_clock = calculate_server_clock()
    return [
        user for user in users.values()
        if server_clock - user.last_heard_server_clock < USER_INACTIVE_SAMPLES]

def user_summary(requested_user_summary) -> List[Any]:
    summary = []
    if not requested_user_summary:
        return summary

    for user in active_users():
        summary.append((
            round(user.delay_samples / SAMPLE_RATE),
            user.name,
            user.mic_volume,
            user.userid,
            user.rms_volume,
            user.muted,
            user.is_monitored))
    summary.sort()
    return summary

def summary_length(n_users_in_summary):
    return 2 + BINARY_USER_CONFIG_FORMAT.size*n_users_in_summary

def binary_user_summary(summary):
    """
    Encode the user summary compactly.

    number of users: uint16
    repeat:
       BINARY_USER_CONFIG_FORMAT

    Each user is 60 bytes, so 1000 users is ~50k.  We could be more
    compact by only sending names if they have changed.
    """
    binary_summaries = [struct.pack(">H", len(summary))]
    for delay, name, mic_volume, userid, rms_volume, muted, is_monitored in summary:
        # delay is encoded as a uint16
        if delay < 0:
            delay = 0
        elif delay > 0xffff:
            delay = 0xffff

        bits = 0
        if muted:
            bits += 0b00000001
        if is_monitored:
            bits += 0b00000010

        binary_summaries.append(
            BINARY_USER_CONFIG_FORMAT.pack(
                int(userid),
                name.encode('utf8'),
                mic_volume,
                rms_volume,
                delay,
                bits))
    resp = np.frombuffer(b"".join(binary_summaries), dtype=np.uint8)

    if len(resp) != summary_length(len(summary)):
        raise Exception("Data for %s users encoded to %s bytes, expected %s",
                        len(summary), len(resp), summary_length(len(summary)))

    return resp

def write_metronome(clear_index, clear_samples):
    metronome_samples = np.zeros(clear_samples, np.float32)

    if state.bpm:
        beat_samples = SAMPLE_RATE * 60 // state.bpm

        # We now want to mark a beat at positions matching
        #   leftover_beat_samples + N*beat_samples
        # It is possible that we will write no beats, and instead will
        # just decrease leftover_beat_samples.

        remaining_clear_samples = clear_samples
        while state.leftover_beat_samples < remaining_clear_samples:
            remaining_clear_samples -= state.leftover_beat_samples
            metronome_samples[-remaining_clear_samples] = 1
            state.leftover_beat_samples = beat_samples
        state.leftover_beat_samples -= remaining_clear_samples

    wrap_assign(backing_queue, clear_index, metronome_samples)

def backfill_metronome():
    # fill all time between song_start_clock and last_cleared_clock
    # with the current beat
    write_metronome(state.song_start_clock, state.last_cleared_clock - state.song_start_clock)

def update_audio(pos, n_samples, in_data, is_monitored):
    old_audio = wrap_get(audio_queue, pos, n_samples)
    new_audio = old_audio + in_data
    wrap_assign(audio_queue, pos, new_audio)

    if is_monitored:
        wrap_assign(monitor_queue,
                    pos,
                    wrap_get(monitor_queue, pos, n_samples) + in_data)

    old_n_people = wrap_get(n_people_queue, pos, n_samples)
    new_n_people = old_n_people + np.ones(n_samples, np.int16)
    wrap_assign(n_people_queue, pos, new_n_people)

def repeat_length_samples():
    beat_length_s = 60 / state.bpm
    repeat_length_s = beat_length_s * state.bpr
    return int(repeat_length_s * SAMPLE_RATE)

def fix_volume(data, backing_data, n_people, user_backing_volume=1.0):
    # We could scale volume by having n_people be the number of
    # earlier people and then scale by a simple 1/n_people.  But a
    # curve of (1 + X) / (n_people + X) falls a bit less
    # dramatically and should sound better.
    #
    # Compare:
    #   https://www.wolframalpha.com/input/?i=graph+%281%29+%2F+%28x%29+from+1+to+10
    #   https://www.wolframalpha.com/input/?i=graph+%281%2B3%29+%2F+%28x%2B3%29+from+1+to+10
    if not state.disable_auto_gain:
        data *= ((1 + N_PHANTOM_PEOPLE) / (n_people + N_PHANTOM_PEOPLE)) ** 0.5
    data += (
        backing_data *
        (state.backing_volume * (1 if state.bpm > 0 else 0.2)) *
        user_backing_volume
    )
    data *= state.global_volume
    return data

def get_telemetry():
    clients = {}
    for user in users.values():
        c = {}
        raw = copy.deepcopy(user.__dict__)
        del raw["list_keys"]  # redundant

        try:
            c["client_time_to_next_client_samples"] = raw["last_heard_server_clock"] - raw["last_seen_write_clock"] - raw["client_telemetry"]["audio_offset"] + raw["last_n_samples"]
            c["client_time_to_next_client_seconds"] = c["client_time_to_next_client_samples"] / SAMPLE_RATE
        except:
            pass

        c["raw"] = raw
        clients[user.userid] = c

    now = time.time()
    result = {
        "request_time": now,
        "server": {
            "server_startup_time": SERVER_STARTUP_TIME,
            "server_uptime": int(now) - SERVER_STARTUP_TIME,
            "server_version": SERVER_VERSION,
            "server_branch": SERVER_BRANCH,
            "server_clock": calculate_server_clock(),
            "server_sample_rate": SAMPLE_RATE,
            "n_connected_users": len(active_users()),
            "queue_size": QUEUE_LENGTH / FRAME_SIZE, # in 128-sample frames
            "events": get_events_to_send(),
            "state": copy.deepcopy(state.__dict__),  # XXX: refine this / dedupe
        },
        "clients": clients
        # XXX: missing client IPs, what else
    }
    del result["server"]["state"]["backing_track"]  # XXX: ok but we really shouldn't have copied it in the first place
    return result

def handle_json_post(in_json_raw, in_data):
    in_json = json.loads(in_json_raw)

    if in_json.get("request", None):
        if in_json["request"] == "get_telemetry":
            result = get_telemetry()
            return json.dumps(result), np.zeros(0)
        else:
            return json.dumps({"error": "unknown request " + in_json["request"]}), np.zeros(0)

    out_data, x_audio_metadata = handle_post(in_json, in_data)

    return json.dumps({
        "x-audio-metadata": x_audio_metadata,
    }), out_data

def end_song():
    state.leader = None
    state.backing_track_type = ""
    sendall("backing_track_type", state.backing_track_type)

# Handle special operations that do not require a user (although they may
#   optionally support one), but can be done server-to-server as well.
def handle_special(query_params, server_clock, user=None, client_read_clock=None):
    volume = query_params.get("volume", None)
    if volume:
        state.global_volume = friendly_volume_to_scalar(float(volume))
        sendall("globalVolume", scalar_to_friendly_volume(state.global_volume))

    backing_volume = query_params.get("backing_volume", None)
    if backing_volume:
        state.backing_volume = friendly_volume_to_scalar(float(backing_volume))
        sendall("backingVolume", scalar_to_friendly_volume(state.backing_volume))

    msg_chats = query_params.get("chat", None)
    if msg_chats:
        for msg_chat in json.loads(msg_chats):
            if user is not None:
                sendall("chats", (user.name, msg_chat), exclude=[user.userid])
            else:
                sendall("chats", ("[ANNOUNCEMENT]", msg_chat))

    mic_volume = query_params.get("mic_volume", None)
    if mic_volume:
        for other_userid, new_mic_volume in json.loads(mic_volume):
            if other_userid in users:
                if new_mic_volume > 2:
                    new_mic_volume = 2
                elif new_mic_volume < 0:
                    new_mic_volume = 0

                users[other_userid].mic_volume = new_mic_volume

                # Make 1 be unity
                users[other_userid].scaled_mic_volume = friendly_volume_to_scalar(
                    new_mic_volume * 0.5) / friendly_volume_to_scalar(0.5)

    requested_track = query_params.get("track", None)
    if requested_track:
        state.requested_track = requested_track

    if query_params.get("mark_start_singing", None):
        clear_whole_buffer()
        events.clear()

        # XXX: There is some confusion over exactly where the start marker should go, but it should be a value that we are guaranteed to have, so the song doesn't fail to start. (So not the write clock.)
        if client_read_clock is not None:
            state.song_start_clock = client_read_clock
        else:
            state.song_start_clock = server_clock
        state.song_end_clock = 0

        state.backing_track_type = ""
        if state.bpm > 0:
            backfill_metronome()
            state.backing_track_type = "Metronome"
        elif state.requested_track:
            run_backing_track()
            # These must be separate from song_start/end_clock, because they
            #   are used for video sync and must be EXACTLY at the moment the
            #   backing track starts/ends, not merely close.
            #insert_event("backingTrackStart", server_clock)
            #insert_event("backingTrackEnd", server_clock + len(state.backing_track))
        sendall("backing_track_type", state.backing_track_type)

    if query_params.get("mark_stop_singing", None):
        # stop the backing track from playing, if it's still going
        state.backing_track_index = len(state.backing_track)

        if user is not None:
            if user.userid == state.leader:
                state.song_end_clock = user.last_write_clock
            else:
                 # halt singing, end it immediately
                state.song_end_clock = 1
                state.song_start_clock = 1
        else:
            state.song_end_clock = server_clock

        end_song()

    if query_params.get("clear_events", None):
        events.clear()

    try:
        new_events = json.loads(query_params.get("event_data", ""))
    except (KeyError, json.decoder.JSONDecodeError) as e:
        new_events = []
    if type(new_events) != list:
        new_events = []

    for ev in new_events:
        insert_event(ev["evid"], ev["clock"])

    disableAutoGain = query_params.get("disableAutoGain", None)
    if disableAutoGain:
        state.disable_auto_gain = disableAutoGain == "1"

    disableSongVideo = query_params.get("disableSongVideo", None)
    if disableSongVideo:
        state.disable_song_video = disableSongVideo == "1"
        sendall("disableSongVideo", state.disable_song_video)

    # If we are running under Ritual Engine, disable functionality that is  not
    #   required in that setting, and would be disruptive if triggered by
    #   accident.
    if not state.server_controlled:
        bpm = query_params.get("bpm", None)
        if bpm is not None:
            state.bpm = bpm
            sendall("bpm", state.bpm)

        repeats = query_params.get("repeats", None)
        if repeats is not None:
            state.repeats = repeats
            sendall("repeats", state.repeats)

        bpr = query_params.get("bpr", None)
        if bpr is not None:
            state.bpr = bpr
            sendall("bpr", state.bpr)

# Do some format conversions and strip the unnecessary nesting layer that urllib
#   query parsing applies
INT_PARAMS = ["write_clock", "read_clock", "bpm", "repeats", "bpr"]
def clean_query_params(params):
    clean_params = {}
    for (k, v) in params.items():
        if (not isinstance(v, list)) or (not len(v) == 1):
            raise ValueError("Duplicate query parameters are not allowed.")
        if k in INT_PARAMS:
            clean_params[k] = int(v[0])
        else:
            clean_params[k] = v[0]
    return clean_params

def extract_params(params, keys):
    result = [None] * len(params)
    for k in keys:
        result

def get_events_to_send() -> Any:
    return [{"evid": i[0], "clock": i[1]} for i in events.items()]

def handle_post(in_json, in_data) -> Tuple[Any, str]:
    in_data = in_data.view(dtype=np.float32)

    raw_params = {}
    # For some reason urllib can't handle the query_string being empty
    query_string = in_json["query_string"]
    if query_string:
        raw_params = urllib.parse.parse_qs(query_string, strict_parsing=True)
    query_params = clean_query_params(raw_params)

    action = query_params.get("action", None)
    if action == "status":
        rsp = {
            "n_connected_users": len(active_users()),
            "max_users": MAX_USERS,
        }
        if "instance_name" in secrets:
            rsp["instance_name"] = secrets["instance_name"]
        return np.zeros(0, np.uint8), json.dumps(rsp)

    userid = query_params.get("userid", None)
    if userid is not None:
        if int(userid) < 0 or int(userid) > 0xffff_ffff_ffff_ffff:
            raise ValueError("Userid must be a uint64")

    server_clock = calculate_server_clock()
    requested_user_summary = query_params.get("user_summary", None)

    # Prevent weirdness on the very first request since startup
    if state.last_request_clock is None:
        state.last_request_clock = server_clock

    # Prevent weirdness if it's been a very long time since we heard from
    #   anybody. Never try to clear more than the entire length of the buffer.
    if server_clock - state.last_request_clock > QUEUE_LENGTH:
        state.last_request_clock = server_clock - QUEUE_LENGTH

    # NOTE: If we go a long time without a request, and there is a backing
    #   track running, weird but harmless things will happen. This scenario is
    #   unlikely and probably not worth correcting.

    # Audio from clients is summed, so we need to clear the circular
    #   buffer ahead of them. The range we are clearing was "in the
    #   future" as of the last request, and we never touch the future,
    #   so nothing has touched it yet "this time around".
    clear_samples = min(server_clock - state.last_request_clock, QUEUE_LENGTH)
    clear_index = state.last_request_clock
    wrap_assign(
        n_people_queue, clear_index, np.zeros(clear_samples, np.int16))
    wrap_assign(
        monitor_queue, clear_index, np.zeros(clear_samples, np.float32))
    wrap_assign(
        audio_queue, clear_index, np.zeros(clear_samples, np.float32))
    state.last_cleared_clock = clear_index + clear_samples

    max_backing_track_samples = len(state.backing_track) - state.backing_track_index
    backing_track_samples = min(max_backing_track_samples, clear_samples)
    if backing_track_samples > 0:
        wrap_assign(
            backing_queue, clear_index, state.backing_track[
                state.backing_track_index :
                state.backing_track_index + backing_track_samples])
        state.backing_track_index += backing_track_samples
        clear_samples -= backing_track_samples
        clear_index += backing_track_samples

        if state.backing_track_index == len(state.backing_track):
            # the song has ended, mark it so
            state.song_end_clock = clear_index
            end_song()

    if clear_samples > 0:
        if state.bpm > 0:
            write_metronome(clear_index, clear_samples)
        else:
            wrap_assign(
                backing_queue, clear_index,
                np.zeros(clear_samples, np.float32))

    saved_last_request_clock = state.last_request_clock
    state.last_request_clock = server_clock

    # Handle server-to-server requests:
    if userid is None and SUPPORT_SERVER_CONTROL:
        # If we ever get a server_to_server request, we switch off certain
        #   automatic behavior that's troublesome in the Ritual Engine setting.
        state.server_controlled = True

        # If we start a song triggered from here, mark its start at the current
        #   server clock, since we don't have a user clock to start at. (I'm
        #   not sure this clock is used for anything other than the bucket
        #   brigade app countdown.)
        handle_special(query_params, server_clock)

        # abbreviated non-user metadata
        x_audio_metadata = {
            "server_clock": server_clock,
            "server_sample_rate": SAMPLE_RATE,
            "song_end_clock": state.song_end_clock,
            "song_start_clock": state.song_start_clock,
            "last_request_clock": state.last_request_clock,
            "n_connected_users": len(active_users()),
            "queue_size": QUEUE_LENGTH / FRAME_SIZE, # in 128-sample frames
            "events": get_events_to_send(),
            "leader": state.leader,
        }
        return np.zeros(0, np.uint8), json.dumps(x_audio_metadata)

    # NOTE NOTE NOTE:
    # * All `clock` variables are measured in samples.
    # * All `clock` variables represent the END of an interval, NOT the
    #   beginning. It's arbitrary which one to use, but you have to be
    #   consistent, and trust me that it's slightly nicer this way.

    if recorder:
        recorder.maybe_write(server_clock)

    client_write_clock = query_params.get("write_clock", None)
    client_read_clock = query_params.get("read_clock", None)
    if client_read_clock is None:
        raise ValueError("no client read clock")

    if client_read_clock > server_clock:
        raise ValueError("Attempted to read %s samples into the future" % (
            client_read_clock - server_clock))

    username = query_params.get("username", None)
    if not username:
        username = "<anonymous>"

    # We used to do this by looking for missing client_write_clock, but that may be true on multiple requests, whereas this is only the first one.
    if query_params.get("reset_user_state", None):
        # New session, write some debug info to disk
        logging.debug("*** New client:" + str(query_params) + "\n\n")

        if userid in users:
            # Delete any state that shouldn't be persisted.
            users[userid].flush()

    update_users(userid, username, server_clock, client_read_clock)
    user = users[userid]

    if "client_address" in in_json:
        user.client_address = in_json["client_address"]

    user.in_spectator_mode = query_params.get("spectator", None)
    user.muted = query_params.get("muted", None) == "1"

    client_telemetry = query_params.get("client_telemetry", None)
    if client_telemetry:
        user.update_client_telemetry(json.loads(client_telemetry))

    rms_volume = query_params.get("rms_volume", None)
    if rms_volume:
        user.rms_volume = float(rms_volume)

    user_backing_volume = query_params.get("user_backing_volume", None)
    if user_backing_volume:
        user.backing_volume = friendly_volume_to_scalar(
            float(user_backing_volume))

    if "lyrics" in in_json:
        state.lyrics = in_json["lyrics"]
        sendall("lyrics", state.lyrics)

    if query_params.get("image", None):
        state.image = ''.join(random.choices(string.ascii_uppercase, k=10))
        sendall("image", state.image)

    # If we are running under Ritual Engine, disable functionality that is  not
    #   required in that setting, and would be disruptive if triggered by
    #   accident.
    if query_params.get("request_lead", None) and not state.server_controlled:
        assign_delays(userid)
        state.leader = userid
        state.image = ""
        sendall("image", "")
        state.lyrics = ""
        sendall("lyrics", "")

    # Handle all operations that do not require a userid
    handle_special(query_params, server_clock, user, client_read_clock)

    user.is_monitoring = query_params.get("hear_monitor", False)
    monitor_userid = query_params.get("monitor", None)
    changedMonitoring = False
    if monitor_userid and monitor_userid in users:
        users[monitor_userid].is_monitored = True
        changedMonitoring = True
        user.is_monitoring = True

    unmonitor_userid = query_params.get("unmonitor", None)
    if unmonitor_userid and unmonitor_userid in users:
        users[unmonitor_userid].is_monitored = False
        changedMonitoring = True

    if changedMonitoring:
        jump_monitors_to_latest_monitored_user()
    if query_params.get("begin_monitor", False):
        jump_to_latest_monitored_user(user)

    ### XXX: Debugging note: We used to do clearing of the buffer here, but now
    ###      we do it above, closer to the top of the function.

    n_samples = len(in_data)
    user.last_n_samples = n_samples

    if client_write_clock is None:
        pass
    elif client_write_clock - n_samples < server_clock - QUEUE_LENGTH:
        # Client is too far behind and going to wrap the buffer. :-(
        raise ValueError("Client's write clock is too far in the past")
    else:
        if user.last_seen_write_clock is not None:
            # Since Opus is stateful, we cannot receive or send audio out-of-order; if
            #   a client tries to do that, we force them to reconnect.
            if client_write_clock - n_samples != user.last_seen_write_clock:
                raise ValueError(
                    f'Client write clock desync ('
                    f'{client_write_clock - n_samples} - '
                    f'{user.last_seen_write_clock} = '
                    f'{client_write_clock - n_samples - user.last_seen_write_clock})')

        user.last_seen_write_clock = client_write_clock
        if client_write_clock is not None:
            user.last_write_clock = client_write_clock

        in_data *= user.scaled_mic_volume
        if state.leader == user.userid:
            in_data *= LEADER_BOOST

        # XXX: I'm not sure we consider this desirable for ritual engine?
        # Don't keep any input unless a song is in progress.
        if (state.song_start_clock and client_write_clock > state.song_start_clock and
            (not state.song_end_clock or
             client_write_clock - n_samples < state.song_end_clock)):

            pos = client_write_clock - n_samples
            update_audio(pos, n_samples, in_data, user.is_monitored)

            if state.bpr and state.bpm and state.repeats:
                for i in range(state.repeats):
                    repeat_pos = pos + repeat_length_samples()*(i+1)
                    if repeat_pos + n_samples < server_clock:
                        update_audio(repeat_pos, n_samples, in_data, False)

    # Why subtract n_samples above and below? Because the future is to the
    #   right. So when a client asks for n samples at time t, what they
    #   actually want is "the time interval ending at t", i.e. [t-n, t). Since
    #   the latest possible time they can ask for is "now", this means that
    #   the latest possible time interval they can get is "the recent past"
    #   instead of "the near future".
    # This doesn't matter to the clients if they all always use the same value of
    #   n_samples, but it matters if n_samples changes, and it matters for
    #   the server's zeroing.

    # Since Opus is stateful, we cannot receive or send audio out-of-order; if
    #   a client tries to do that, we force them to reconnect.
    if user.last_seen_read_clock is not None:
        if client_read_clock - n_samples != user.last_seen_read_clock:
            raise ValueError(
                f'Client read clock desync ('
                f'{client_read_clock - n_samples} - '
                f'{user.last_seen_read_clock} = '
                f'{client_read_clock - n_samples - user.last_seen_read_clock})')
    user.last_seen_read_clock = client_read_clock

    n_people = [-1]
    if query_params.get("loopback", None) == "true":
        data = in_data
    elif user.is_monitoring:
        data = wrap_get(monitor_queue, client_read_clock - n_samples, n_samples)
    else:
        # Only play audio during songs.  Mostly this is dealt with by
        # only keeping input when a song is in progress, but the
        # metronome, backing track, and round singing are also forms
        # of input that check doesn't catch.
        if state.song_start_clock and (
                not state.song_end_clock or
                client_read_clock - n_samples < state.song_end_clock):
            data = wrap_get(audio_queue, client_read_clock - n_samples,
                            n_samples)
            backing_data = wrap_get(backing_queue, client_read_clock - n_samples,
                                    n_samples)
        else:
            data = np.zeros(n_samples, np.float32)
            backing_data = np.zeros(n_samples, np.float32)

        n_people = wrap_get(
            n_people_queue, client_read_clock - n_samples, n_samples)

        data = fix_volume(data, backing_data, n_people, user.backing_volume)

    x_audio_metadata = {
        "server_clock": server_clock,
        "server_sample_rate": SAMPLE_RATE,
        "last_request_clock": saved_last_request_clock,
        "client_read_clock": client_read_clock,
        "client_write_clock": client_write_clock,
        "song_end_clock": state.song_end_clock,
        "song_start_clock": state.song_start_clock,
        "n_samples": n_samples,
        "n_connected_users": len(active_users()),
        "queue_size": QUEUE_LENGTH / FRAME_SIZE, # in 128-sample frames
        "events": get_events_to_send(),
        "leader": state.leader,
        "n_people_heard": int(n_people[0]),
    }

    x_audio_metadata.update(user.to_send)
    user.mark_sent()

    bin_summary = binary_user_summary(user_summary(requested_user_summary))
    if len(bin_summary) > 0:
        data = np.append(bin_summary, data.view(dtype=np.uint8))
    return data, json.dumps(x_audio_metadata)

if __name__ == "__main__":
    print("Run server_wrapper.py or shm.py instead")
