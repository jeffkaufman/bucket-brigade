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


from typing import Any, Dict, List, Tuple, Iterable

lock = threading.Lock()

logging.basicConfig(filename='server.log',level=logging.DEBUG)

FRAME_SIZE = 128

class State():
    def __init__(self):
        self.reset()

    def reset(self):
        self.last_request_clock = None
        self.last_cleared_clock = None
        self.global_volume = 1.0
        self.backing_volume = 1.0
        self.song_end_clock = 0
        self.song_start_clock = None
        self.requested_track: Any = None

        self.bpm = None
        self.repeats = 0
        self.bpr = None
        self.leftover_beat_samples = 0

        self.leader = None

        self.metronome_on = False
        self.backing_track: Any = np.zeros(0)
        self.backing_track_index = 0

        self.max_position = DELAY_INTERVAL*LAYERING_DEPTH

        self.last_status_ts = 0.0

        if recorder:
            recorder.reset()

QUEUE_SECONDS = 120

SAMPLE_RATE = 48000

# How often to print status updates. With no requests are coming in no status
# update will be printed.
STATUS_PRINT_INTERVAL_S = 10

# Leave this much space between users. Ideally this would be very
# short, but it needs to be long enough to cover "client total time
# consumed" or else people won't all hear each other.
DELAY_INTERVAL = 3  # 3s

# How many links to use for the chain of users before starting to double up.
LAYERING_DEPTH = 5

# If we have not heard from a user in N seconds, assume they are no longer
# active.
USER_LIFETIME_SAMPLES = SAMPLE_RATE * 5

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

AUDIO_DIR = os.path.join(os.path.dirname(__file__), "audio")
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
        return (state.max_position + 2)*SAMPLE_RATE

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
            w("<html>")
            w("<title>Recordings</title>")
            w("<h1>Recordings</h1>")
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
            w("</html>")

    def cleanup_(self):
        recordings = os.listdir(RECORDINGS_DIR)
        if len(recordings) <= RECORDING_N_TO_KEEP:
            return

        for fname in sorted(recordings)[:-RECORDING_N_TO_KEEP]:
            os.remove(os.path.join(RECORDINGS_DIR, fname))
        self.update_directory_listing_()

recorder = Recorder() if RECORDING_ENABLED else None

state = State()

events: Dict[str, str] = {}

def clear_events():
    with lock:
        clear_events_()

def clear_events_():
    events.clear()

METRONOME = "metronome -- set BPM below"

tracks = []
def populate_tracks() -> None:
    for track in sorted(os.listdir(AUDIO_DIR)):
        if track != "README":
            tracks.append(track)
    tracks.append(METRONOME)

populate_tracks()

def calculate_server_clock():
    # Note: This will eventually create a precision problem for the JS
    #   clients, which are using floats. Specifically, at 44100 Hz, it will
    #   fail on February 17, 5206.
    return int(time.time() * SAMPLE_RATE)

class User:
    def __init__(self, userid, name, last_heard_server_clock, delay_samples) -> None:
        self.list_keys = ["chats"]

        self.userid = userid
        self.name = name
        self.last_heard_server_clock = last_heard_server_clock
        self.delay_samples = delay_samples

        self.mic_volume = 1.0
        self.scaled_mic_volume = 1.0
        self.last_write_clock = None
        self.is_monitored = False
        self.is_monitoring = False
        self.rms_volume = 0

        # For debugging purposes only
        self.last_seen_read_clock = None
        self.last_seen_write_clock = None

        self.mark_sent()

        self.send("bpm", state.bpm)
        self.send("repeats", state.repeats)
        self.send("bpr", state.bpr)
        self.send("tracks", tracks)

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

users: Dict[str, Any] = {} # userid -> User
def sendall(key, value, exclude=[]):
    for userid, user in users.items():
        if userid not in exclude:
            user.send(key, value)

def wrap_get(queue, start, len_vals) -> Any:
    start_in_queue = start % len(queue)

    if start_in_queue + len_vals <= len(queue):
        return queue[start_in_queue:(start_in_queue+len_vals)]
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
    if state.requested_track == METRONOME:
        state.metronome_on = True
        backfill_metronome()
    elif state.requested_track in tracks:
        with wave.open(os.path.join(AUDIO_DIR, state.requested_track)) as inf:
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

    # Backing track is used only once.
    state.requested_track = None

def assign_delays(userid_lead) -> None:
    initial_position = 0

    if state.bpr and state.bpm and state.repeats:
        beat_length_s = 60 / state.bpm
        repeat_length_s = beat_length_s * state.bpr
        initial_position += int(repeat_length_s*state.repeats)

    if initial_position > 90:
        initial_position = 90

    users[userid_lead].send("delay_seconds", initial_position + DELAY_INTERVAL)

    positions = [initial_position + x*DELAY_INTERVAL
                 for x in range(2, LAYERING_DEPTH)]

    # Randomly shuffle the remaining users, and assign them to positions. If we
    # have more users then positions, then double up.
    # TODO: perhaps we should prefer to double up from the end?
    state.max_position = initial_position + DELAY_INTERVAL*2
    for i, (_, userid) in enumerate(sorted(
            [(random.random(), userid)
             for userid in users
             if userid != userid_lead])):
        position = positions[i % len(positions)]
        users[userid].send("delay_seconds", position)
        state.max_position = max(position, state.max_position)

def update_users(userid, username, server_clock, client_read_clock) -> None:
    # Delete expired users BEFORE adding us to the list, so that our session
    #   will correctly reset if we are the next customer after we've been gone
    #   for awhile.
    clean_users(server_clock)

    delay_samples = server_clock - client_read_clock
    if userid not in users:
        users[userid] = User(userid, username, server_clock, delay_samples)

    users[userid].last_heard_server_clock = server_clock
    users[userid].delay_samples = delay_samples

def clean_users(server_clock) -> None:
    to_delete = []
    for userid, user in users.items():
        age_samples = server_clock - user.last_heard_server_clock
        if age_samples > USER_LIFETIME_SAMPLES:
            to_delete.append(userid)
    for userid in to_delete:
        del users[userid]

    if not users:
        state.reset()

def setup_monitoring(monitoring_userid, monitored_userid) -> None:
    for user in users.values():
        user.is_monitoring = False
        user.is_monitored = False

    # We turn off monitoring by asking to monitor an invalid user ID.
    if monitored_userid not in users:
        return

    users[monitoring_userid].is_monitoring = True
    users[monitored_userid].is_monitored = True

    users[monitoring_userid].send("delay_seconds", round(
        users[monitored_userid].delay_samples / SAMPLE_RATE) + DELAY_INTERVAL)

def user_summary(requested_mixer) -> List[Any]:
    summary = []
    if len(users)>50 and not requested_mixer:
        return summary
    for userid, user in users.items():
        summary.append((
            round(user.delay_samples / SAMPLE_RATE),
            user.name,
            user.mic_volume,
            userid,
            user.is_monitoring,
            user.is_monitored,
            user.rms_volume))
    summary.sort()
    return summary

def write_metronome(clear_index, clear_samples):
    metronome_samples = np.zeros(clear_samples, np.float32)

    if state.bpm is not None:
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
        wrap_assign(monitor_queue, pos, in_data)

    old_n_people = wrap_get(n_people_queue, pos, n_samples)
    new_n_people = old_n_people + np.ones(n_samples, np.int16)
    wrap_assign(n_people_queue, pos, new_n_people)

def repeat_length_samples():
    beat_length_s = 60 / state.bpm
    repeat_length_s = beat_length_s * state.bpr
    return int(repeat_length_s * SAMPLE_RATE)

def fix_volume(data, backing_data, n_people):
    # We could scale volume by having n_people be the number of
    # earlier people and then scale by a simple 1/n_people.  But a
    # curve of (1 + X) / (n_people + X) falls a bit less
    # dramatically and should sound better.
    #
    # Compare:
    #   https://www.wolframalpha.com/input/?i=graph+%281%29+%2F+%28x%29+from+1+to+10
    #   https://www.wolframalpha.com/input/?i=graph+%281%2B3%29+%2F+%28x%2B3%29+from+1+to+10
    data *= (1 + N_PHANTOM_PEOPLE) / (n_people + N_PHANTOM_PEOPLE)
    data += (backing_data * (state.backing_volume * (1 if state.metronome_on else 0.2)))
    data *= state.global_volume
    return data

def handle_json_post(in_json_raw, in_data):
    in_json = json.loads(in_json_raw)

    if "clear_events" in in_json:
        clear_events_()
        return "", []

    new_events = in_json.get("new_events", [])
    query_string = in_json["query_string"]

    out_data, x_audio_metadata = handle_post_(
        in_data, new_events, query_string, print_status=True)

    return json.dumps({
        "x-audio-metadata": x_audio_metadata,
    }), out_data

def handle_post(in_data, new_events, query_string, print_status) -> Tuple[Any, str]:
    with lock:
        return handle_post_(in_data, new_events, query_string, print_status)

def handle_post_(in_data, new_events, query_string, print_status) -> Tuple[Any, str]:
    query_params = urllib.parse.parse_qs(query_string, strict_parsing=True)

    # NOTE NOTE NOTE:
    # * All `clock` variables are measured in samples.
    # * All `clock` variables represent the END of an interval, NOT the
    #   beginning. It's arbitrary which one to use, but you have to be
    #   consistent, and trust me that it's slightly nicer this way.

    server_clock = calculate_server_clock()
    if recorder:
        recorder.maybe_write(server_clock)

    client_write_clock = query_params.get("write_clock", None)
    if client_write_clock is not None:
        client_write_clock = int(client_write_clock[0])
    client_read_clock = query_params.get("read_clock", None)
    if client_read_clock is not None:
        client_read_clock = int(client_read_clock[0])
    else:
        raise ValueError("no client read clock")

    userid, = query_params.get("userid", [None])
    username, = query_params.get("username", [None])
    if not userid or not username:
        raise ValueError("missing username/id")

    reset_user_state, = query_params.get("reset_user_state", (None,))
    # We used to do this by looking for missing client_write_clock, but that may be true on multiple requests, whereas this is only the first one.
    if reset_user_state:
        # New session, write some debug info to disk
        logging.debug("*** New client:" + str(query_params) + "\n\n")

        if userid in users:
            # Delete any state that shouldn't be persisted.
            users[userid].flush()

    update_users(userid, username, server_clock, client_read_clock)
    user = users[userid]

    volume, = query_params.get("volume", [None])
    if volume:
        state.global_volume = math.exp(6.908 * float(volume)) / 1000

    backing_volume, = query_params.get("backing_volume", [None])
    if backing_volume:
        state.backing_volume = math.exp(6.908 * float(backing_volume)) / 1000

    msg_chats, = query_params.get("chat", [None])
    if msg_chats:
        for msg_chat in json.loads(msg_chats):
            sendall("chats", (username, msg_chat), exclude=[userid])

    bpm, = query_params.get("bpm", [None])
    if bpm:
        state.bpm = int(bpm)
        sendall("bpm", state.bpm)

    repeats, = query_params.get("repeats", [None])
    if repeats:
        state.repeats = int(repeats)
        sendall("repeats", state.repeats)

    bpr, = query_params.get("bpr", [None])
    if bpr:
        state.bpr = int(bpr)
        sendall("bpr", state.bpr)

    rms_volume, = query_params.get("rms_volume", [None])
    if rms_volume:
        user.rms_volume = float(rms_volume)

    requested_mixer, = query_params.get("mixer", [None])


    mic_volume, = query_params.get("mic_volume", [None])
    if mic_volume:
        for other_userid, new_mic_volume in json.loads(mic_volume):
            if other_userid in users:
                if new_mic_volume > 2:
                    new_mic_volume = 2
                elif new_mic_volume < 0:
                    new_mic_volume = 0

                users[other_userid].mic_volume = new_mic_volume

                # https://www.dr-lex.be/info-stuff/volumecontrols.html
                # Make 1 be unity
                users[other_userid].scaled_mic_volume = math.exp(
                    6.908 * new_mic_volume * .5) / math.exp(6.908 * 0.5)

    requested_track, = query_params.get("track", [None])
    if requested_track and not state.song_start_clock:
        state.requested_track = requested_track

    if query_params.get("request_lead", None):
        assign_delays(userid)
        state.song_start_clock = None
        state.song_end_clock = 0
        state.metronome_on = False
        state.leader = userid
        clear_whole_buffer()

    if query_params.get("mark_start_singing", None):
        # XXX: There is some confusion over exactly where the start marker should go, but it should be a value that we are guaranteed to have, so the song doesn't fail to start. (So not the write clock.)
        state.song_start_clock = client_read_clock
        state.song_end_clock = 0
        state.metronome_on = False
        if state.bpm and state.bpr and state.repeats:
            state.requested_track = METRONOME
        if state.requested_track:
            run_backing_track()
            # These must be separate from song_start/end_clock, because they
            #   are used for video sync and must be EXACTLY at the moment the
            #   backing track starts/ends, not merely close.
            # We use "last_request_clock" because that's the moment the track
            #   actually starts due to the way our clearing algorithm currently
            #   works. (... I think.)
            sendall("backing_track_start_clock", state.last_request_clock)
            sendall("backing_track_end_clock", state.last_request_clock + len(state.backing_track))


    if query_params.get("mark_stop_singing", None):
        # stop the backing track from playing, if it's still going
        state.backing_track_index = len(state.backing_track)
        state.metronome_on = False
        state.leader = None
        state.song_end_clock = user.last_write_clock

        # They're done singing, send them to the end.
        user.send("delay_seconds", state.max_position)

    monitor_userid, = query_params.get("monitor", [None])
    if monitor_userid:
        setup_monitoring(userid, monitor_userid)

    # Audio from clients is summed, so we need to clear the circular
    #   buffer ahead of them. The range we are clearing was "in the
    #   future" as of the last request, and we never touch the future,
    #   so nothing has touched it yet "this time around".
    if state.last_request_clock is not None:
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

        if clear_samples > 0:
            if state.metronome_on:
                write_metronome(clear_index, clear_samples)
            else:
                wrap_assign(
                    backing_queue, clear_index,
                    np.zeros(clear_samples, np.float32))

    saved_last_request_clock = state.last_request_clock
    state.last_request_clock = server_clock

    n_samples = len(in_data)

    if client_write_clock is None:
        pass
    elif client_write_clock - n_samples < server_clock - QUEUE_LENGTH:
        # Client is too far behind and going to wrap the buffer. :-(
        raise ValueError("Client's write clock is too far in the past")
    else:
        if user.last_seen_write_clock is not None:
            # For debugging purposes only
            if client_write_clock - n_samples != user.last_seen_write_clock:
                raise ValueError(
                    f'Client write clock desync ('
                    f'{client_write_clock - n_samples} - '
                    f'{user.last_seen_write_clock} = '
                    f'{client_write_clock - n_samples - user.last_seen_write_clock})')
            if user.last_write_clock <= state.song_end_clock <= client_write_clock:
                # XXX: I'm not sure we still consider this desirable?
                user.send("delay_seconds", state.max_position)

        user.last_seen_write_clock = client_write_clock
        if client_write_clock is not None:
            user.last_write_clock = client_write_clock

        for ev in new_events:
            events[ev["evid"]] = ev["clock"]

        in_data *= user.scaled_mic_volume

        # XXX: I'm not sure we consider this desirable for ritual engine?
        # Don't keep any input unless a song is in progress.
        if (state.song_start_clock and client_write_clock > state.song_start_clock and
            (not state.song_end_clock or
             client_write_clock - n_samples < state.song_end_clock)):

            pos = client_write_clock - n_samples
            update_audio(pos, n_samples, in_data, user.is_monitored)

            if state.bpr and state.bpm and state.repeats:
                for i in range(state.repeats):
                    repeat_pos = pos + repeat_length_samples()*i
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

    # For debugging purposes only
    if user.last_seen_read_clock is not None:
        if client_read_clock - n_samples != user.last_seen_read_clock:
            raise ValueError(
                f'Client read clock desync ('
                f'{client_read_clock - n_samples} - '
                f'{user.last_seen_read_clock} = '
                f'{client_read_clock - n_samples - user.last_seen_read_clock})')
    user.last_seen_read_clock = client_read_clock

    n_people = [-1]
    if query_params.get("loopback", [None])[0] == "true":
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

        data = fix_volume(data, backing_data, n_people)

    events_to_send_list = list(events.items())
    events_to_send = [ {"evid":i[0], "clock":i[1]} for i in events_to_send_list ]
    #print(events_to_send)
    # TODO: chop events that are too old to be relevant?

    x_audio_metadata = {
        "server_clock": server_clock,
        "server_sample_rate": SAMPLE_RATE,
        "last_request_clock": saved_last_request_clock,
        "client_read_clock": client_read_clock,
        "client_write_clock": client_write_clock,
        "n_samples": n_samples,
        "user_summary": user_summary(requested_mixer),
        "queue_size": QUEUE_LENGTH / FRAME_SIZE, # in 128-sample frames
        "events": events_to_send,
        "leader": state.leader,
        "n_people": int(n_people[0]),
    }


    if state.song_start_clock:
        x_audio_metadata["song_start_clock"] = state.song_start_clock

    x_audio_metadata.update(user.to_send)
    user.mark_sent()

    if print_status:
        maybe_print_status()

    return data, json.dumps(x_audio_metadata)

def maybe_print_status() -> None:
    now = time.time()
    if now - state.last_status_ts < STATUS_PRINT_INTERVAL_S:
        return

    print("-"*70)

    for delay, name, mic_volume, userid, is_monitored, \
        is_monitoring, rms_volume in user_summary(requested_mixer=True):
        print ("%s %s vol=%.2f %s %s rms=%.5f" % (
            str(delay).rjust(3),
            name.rjust(30),
            mic_volume,
            "m" if is_monitored else " ",
            "M" if is_monitoring else " ",
            rms_volume))

    state.last_status_ts = now

if __name__ == "__main__":
    print("Run server_wrapper.py or shm.py instead")
