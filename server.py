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

import cProfile
import pstats
import io

from typing import Any, Dict, List, Tuple, Iterable

logging.basicConfig(filename='server.log',level=logging.DEBUG)
pr = cProfile.Profile()
# enable for just a moment so the profile object isn't empty
pr.enable()
pr.disable()

FRAME_SIZE = 128

last_request_clock = None
first_client_write_clock = None
first_client_total_samples = None
first_client_value = None
global_volume = 1.0
backing_volume = 1.0
song_end_clock = 0
song_start_clock = None
requested_track: Any = None

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
LAYERING_DEPTH = 8

# If we have not heard from a user in N seconds, assume they are no longer
# active.
USER_LIFETIME_SAMPLES = SAMPLE_RATE * 5

# Force rounding to multiple of FRAME_SIZE
QUEUE_LENGTH = (QUEUE_SECONDS * SAMPLE_RATE // FRAME_SIZE * FRAME_SIZE)

audio_queue = np.zeros(QUEUE_LENGTH, np.float32)
monitor_queue = np.zeros(QUEUE_LENGTH, np.float32)
n_people_queue = np.zeros(QUEUE_LENGTH, np.int16)

max_position = DELAY_INTERVAL*LAYERING_DEPTH

# For volume scaling.
N_PHANTOM_PEOPLE = 2

AUDIO_DIR = os.path.join(os.path.dirname(__file__), "audio")

events: Dict[str, str] = {}

tracks = []
def populate_tracks() -> None:
    for track in sorted(os.listdir(AUDIO_DIR)):
        if track != "README":
            tracks.append(track)

populate_tracks()

def calculate_server_clock():
    # Note: This will eventually create a precision problem for the JS
    #   clients, which are using floats. Specifically, at 44100 Hz, it will
    #   fail on February 17, 5206.
    return int(time.time() * SAMPLE_RATE)

class User:
    def __init__(self, userid, name, last_heard_server_clock, delay_samples) -> None:
        self.userid = userid
        self.name = name
        self.last_heard_server_clock = last_heard_server_clock
        self.delay_samples = delay_samples
        self.chats_to_send: List[Any] = []
        self.delay_to_send = None
        self.opus_state = None
        self.mic_volume = 1.0
        self.scaled_mic_volume = 1.0
        self.last_write_clock = None
        self.is_monitored = False
        self.is_monitoring = False
        # For debugging purposes only
        self.last_seen_read_clock = None
        self.last_seen_write_clock = None

    def flush(self) -> None:
        """Delete any state that shouldn't be persisted across reconnects"""
        self.opus_state = None
        self.last_seen_read_clock = None
        self.last_seen_write_clock = None

users: Dict[str, Any] = {} # userid -> User

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

backing_track: Any = np.zeros(0)
backing_track_index = 0
def run_backing_track() -> None:
    global backing_track
    global backing_track_index
    global requested_track

    backing_track_index = 0

    if requested_track in tracks:
        with wave.open(os.path.join(AUDIO_DIR, requested_track)) as inf:
            if inf.getnchannels() != 1:
                raise Exception(
                    "wrong number of channels on %s" % requested_track)
            if inf.getsampwidth() != 2:
                raise Exception(
                    "wrong sample width on %s" % requested_track)
            if inf.getframerate() != 48000:
                raise Exception(
                    "wrong sample rate on %s" % requested_track)

            backing_track = np.frombuffer(
                inf.readframes(-1), np.int16).astype(np.float32) / (2**15)
            backing_track *= 0.8 # turn it down a bit

    # Backing track is used only once.
    requested_track = None

def assign_delays(userid_lead) -> None:
    global max_position

    users[userid_lead].delay_to_send = DELAY_INTERVAL

    positions = [x*DELAY_INTERVAL
                 for x in range(2, LAYERING_DEPTH)]

    # Randomly shuffle the remaining users, and assign them to positions. If we
    # have more users then positions, then double up.
    # TODO: perhaps we should prefer to double up from the end?
    max_position = DELAY_INTERVAL*2
    for i, (_, userid) in enumerate(sorted(
            [(random.random(), userid)
             for userid in users
             if userid != userid_lead])):
        position = positions[i % len(positions)]
        users[userid].delay_to_send = position
        max_position = max(position, max_position)

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

def setup_monitoring(monitoring_userid, monitored_userid) -> None:
    for user in users.values():
        user.is_monitoring = False
        user.is_monitored = False

    # We turn off monitoring by asking to monitor an invalid user ID.
    if monitored_userid not in users:
        return

    users[monitoring_userid].is_monitoring = True
    users[monitored_userid].is_monitored = True

    users[monitoring_userid].delay_to_send = round(
        users[monitored_userid].delay_samples / SAMPLE_RATE) + DELAY_INTERVAL

def user_summary() -> List[Any]:
    summary = []
    for userid, user in users.items():
        summary.append((
            round(user.delay_samples / SAMPLE_RATE),
            user.name,
            user.mic_volume,
            userid,
            user.is_monitoring,
            user.is_monitored))
    summary.sort()
    return summary

def handle_post(in_data, new_events, query_string, print_status) -> Tuple[Any, str]:
    global last_request_clock
    global first_client_write_clock
    global first_client_total_samples
    global first_client_value
    global global_volume
    global backing_volume
    global song_end_clock
    global song_start_clock
    global requested_track
    global backing_track_index

    query_params = urllib.parse.parse_qs(query_string, strict_parsing=True)

    # NOTE NOTE NOTE:
    # * All `clock` variables are measured in samples.
    # * All `clock` variables represent the END of an interval, NOT the
    #   beginning. It's arbitrary which one to use, but you have to be
    #   consistent, and trust me that it's slightly nicer this way.

    server_clock = calculate_server_clock()

    client_write_clock = query_params.get("write_clock", None)
    if client_write_clock is not None:
        client_write_clock = int(client_write_clock[0])
    client_read_clock = query_params.get("read_clock", None)
    if client_read_clock is not None:
        client_read_clock = int(client_read_clock[0])
    else:
        raise ValueError("no client read clock")

    userid = None
    userids = query_params.get("userid", None)

    username = None
    usernames = query_params.get("username", None)
    if not userids or not usernames:
        raise ValueError("missing username/id")

    userid, = userids
    username, = usernames
    if not userid or not username:
        raise ValueError("missing username/id")

    if client_write_clock is None:
        # New session, write some debug info to disk
        logging.debug("*** New client:" + str(query_params) + "\n\n")

        if userid in users:
            # Delete any state that shouldn't be persisted.
            users[userid].flush()

    update_users(userid, username, server_clock, client_read_clock)
    user = users[userid]

    volumes = query_params.get("volume", None)
    if volumes:
        volume, = volumes
        global_volume = math.exp(6.908 * float(volume)) / 1000

    backing_volumes = query_params.get("backing_volume", None)
    if backing_volumes:
        backing_volume, = backing_volumes
        backing_volume = math.exp(6.908 * float(backing_volume)) / 1000

    msg_chats = query_params.get("chat", None)
    if msg_chats:
        msg_chats, = msg_chats
        msg_chats = json.loads(msg_chats)
        for other_userid, other_user in users.items():
            if other_userid != userid:
                for msg_chat in msg_chats:
                    other_user.chats_to_send.append((username, msg_chat))

    mic_volumes = query_params.get("mic_volume", None)
    if mic_volumes:
        mic_volume, = mic_volumes
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

    requested_tracks = query_params.get("track", None)
    if requested_tracks and not song_start_clock:
        requested_track, = requested_tracks

    if query_params.get("request_lead", None):
        assign_delays(userid)
        song_start_clock = None
        song_end_clock = 0

    if query_params.get("mark_start_singing", None):
        song_start_clock = user.last_write_clock
        song_end_clock = 0
        if requested_track:
            run_backing_track()

    if query_params.get("mark_stop_singing", None):
        # stop the backing track from playing, if it's still going
        backing_track_index = len(backing_track)

        song_end_clock = user.last_write_clock

        # They're done singing, send them to the end.
        user.delay_to_send = max_position

    monitor_userids = query_params.get("monitor", None)
    if monitor_userids:
        monitor_userid, = monitor_userids
        if monitor_userid:
            setup_monitoring(userid, monitor_userid)

    # Audio from clients is summed, so we need to clear the circular
    #   buffer ahead of them. The range we are clearing was "in the
    #   future" as of the last request, and we never touch the future,
    #   so nothing has touched it yet "this time around".
    if last_request_clock is not None:
        clear_samples = min(server_clock - last_request_clock, QUEUE_LENGTH)
        clear_index = last_request_clock
        wrap_assign(
            n_people_queue, clear_index, np.zeros(clear_samples, np.int16))
        wrap_assign(
            monitor_queue, clear_index, np.zeros(clear_samples, np.float32))

        max_backing_track_samples = len(backing_track) - backing_track_index
        backing_track_samples = min(max_backing_track_samples, clear_samples)
        if backing_track_samples > 0:
            wrap_assign(
                audio_queue, clear_index, backing_track[
                    backing_track_index :
                    backing_track_index + backing_track_samples]
                * backing_volume)
            backing_track_index += backing_track_samples
            clear_samples -= backing_track_samples
            clear_index += backing_track_samples

            if backing_track_index == len(backing_track):
                # the song has ended, mark it so
                song_end_clock = clear_index

        if clear_samples > 0:
            wrap_assign(
                audio_queue, clear_index, np.zeros(clear_samples, np.float32))

    saved_last_request_clock = last_request_clock
    last_request_clock = server_clock

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
            if user.last_write_clock <= song_end_clock <= client_write_clock:
                user.delay_to_send = max_position

        user.last_seen_write_clock = client_write_clock
        if client_write_clock is not None:
            user.last_write_clock = client_write_clock

        for ev in new_events:
            events[ev["evid"]] = ev["clock"]

        in_data *= user.scaled_mic_volume

        # Don't keep any input unless a song is in progress.
        if (song_start_clock and client_write_clock > song_start_clock and
            (not song_end_clock or
             client_write_clock - n_samples < song_end_clock)):
            old_audio = wrap_get(
                audio_queue, client_write_clock - n_samples, n_samples)
            new_audio = old_audio + in_data
            wrap_assign(
                audio_queue, client_write_clock - n_samples, new_audio)

            if user.is_monitored:
                wrap_assign(
                    monitor_queue, client_write_clock - n_samples, in_data)

            old_n_people = wrap_get(
                n_people_queue, client_write_clock - n_samples, n_samples)
            new_n_people = old_n_people + np.ones(n_samples, np.int16)
            wrap_assign(
                n_people_queue, client_write_clock - n_samples, new_n_people)

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

    if query_params.get("loopback", [None])[0] == "true":
        data = in_data
    elif user.is_monitoring:
        data = wrap_get(monitor_queue, client_read_clock - n_samples, n_samples)
    else:
        data = wrap_get(audio_queue, client_read_clock - n_samples, n_samples)
        n_people = wrap_get(
            n_people_queue, client_read_clock - n_samples, n_samples)

        # We could scale volume by having n_people be the number of
        # earlier people and then scale by a simple 1/n_people.  But a
        # curve of (1 + X) / (n_people + X) falls a bit less
        # dramatically and should sound better.
        #
        # Compare:
        #   https://www.wolframalpha.com/input/?i=graph+%281%29+%2F+%28x%29+from+1+to+10
        #   https://www.wolframalpha.com/input/?i=graph+%281%2B3%29+%2F+%28x%2B3%29+from+1+to+10
        data = data * (1 + N_PHANTOM_PEOPLE) / (n_people + N_PHANTOM_PEOPLE)

        data *= global_volume

    events_to_send_list = list(events.items())
    events_to_send = [ {"evid":i[0], "clock":i[1]} for i in events_to_send_list ]
    #print(events_to_send)
    # TODO: chop events that are too old to be relevant?

    # TODO: We could skip some of these keys when the values are null.
    x_audio_metadata = json.dumps({
        "server_clock": server_clock,
        "server_sample_rate": SAMPLE_RATE,
        "last_request_clock": saved_last_request_clock,
        "client_read_clock": client_read_clock,
        "client_write_clock": client_write_clock,
        "user_summary": user_summary(),
        "chats": user.chats_to_send,
        "delay_seconds": user.delay_to_send,
        "song_start_clock": song_start_clock,
        # It's kind of wasteful to send this on every response, but
        # it's not very many bytes, and let's just move on.
        "tracks": tracks,
        # The following uses units of 128-sample frames
        "queue_size": QUEUE_LENGTH / FRAME_SIZE,
        "events": events_to_send,
    })

    user.chats_to_send.clear()
    user.delay_to_send = None

    if print_status:
        maybe_print_status()
    
    return data, x_audio_metadata

last_status_ts = 0.0
def maybe_print_status() -> None:
    global last_status_ts
    now = time.time()
    if now - last_status_ts < STATUS_PRINT_INTERVAL_S:
        return

    print("-"*70)

    for delay, name, mic_volume, userid, is_monitored, \
        is_monitoring in user_summary():
        print ("%s %s vol=%.2f %s %s" % (
            str(delay).rjust(3),
            name.rjust(30),
            mic_volume,
            "m" if is_monitored else " ",
            "M" if is_monitoring else " "))

    last_status_ts = now

if __name__ == "__main__":
    print("Run server_wrapper.py instead")
