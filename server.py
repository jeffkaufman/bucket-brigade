#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import time
import numpy as np
import random
import opuslib

FRAME_SIZE = 128

last_request_clock = None
first_client_write_clock = None
first_client_total_samples = None
first_client_value = None

QUEUE_SECONDS = 120

SAMPLE_RATE = 48000
CHANNELS = 1
OPUS_FRAME_MS = 60
OPUS_FRAME_SAMPLES = SAMPLE_RATE // 1000 * OPUS_FRAME_MS
OPUS_BYTES_PER_SAMPLE = 2  # uint16
OPUS_FRAME_BYTES = OPUS_FRAME_SAMPLES * CHANNELS * OPUS_BYTES_PER_SAMPLE

# Leave this much space between users. Ideally this would be very
# short, but it needs to be long enough to cover "client total time
# consumed" or else people won't all hear each other.
DELAY_INTERVAL = SAMPLE_RATE * 2  # 2s

# If we have not heard from a user in N seconds, assume they are no longer
# active.
USER_LIFETIME_SAMPLES = SAMPLE_RATE * 5

# Force rounding to multiple of FRAME_SIZE
queue = np.zeros((QUEUE_SECONDS * SAMPLE_RATE // FRAME_SIZE * FRAME_SIZE),
                 np.int16)

class User:
    def __init__(self, userid, name, last_heard_server_clock, delay_samples):
        self.userid = userid
        self.name = name
        self.last_heard_server_clock = last_heard_server_clock
        self.delay_samples = delay_samples
        self.chats_to_send = []
        self.delay_to_send = None
        self.opus_state = None

users = {} # userid -> User

def wrap_get(start, len_vals):
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

def wrap_assign(start, vals):
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

def assign_delays(userid_lead):
    users[userid_lead].delay_to_send = DELAY_INTERVAL

    positions = [x*DELAY_INTERVAL
                 for x in range(2, 15)]

    # Randomly shuffle the remaining users, and assign them to positions. If we
    # have more users then positions, then double up.
    # TODO: perhaps we should prefer to double up from the end?
    for i, (_, userid) in enumerate(sorted(
            [(random.random(), userid)
             for userid in users
             if userid != userid_lead])):
        users[userid].delay_to_send = positions[i % len(positions)]

def update_users(userid, username, server_clock, client_read_clock):
    delay_samples = server_clock - client_read_clock
    if userid not in users:
        users[userid] = User(userid, username, server_clock, delay_samples)
    users[userid].last_heard_server_clock = server_clock
    users[userid].delay_samples = delay_samples

    clean_users(server_clock)

def clean_users(server_clock):
    to_delete = []
    for userid, user in users.items():
        age_samples = server_clock - user.last_heard_server_clock
        if age_samples > USER_LIFETIME_SAMPLES:
            to_delete.append(userid)
    for userid in to_delete:
        del users[userid]

def user_summary():
    summary = []
    for user in users.values():
        summary.append((user.delay_samples, user.name))
    summary.sort()
    return summary

def pack_multi(packets):
    encoded_length = 1
    for p in packets:
        encoded_length += 2 + len(p)
    outdata = np.zeros(encoded_length, np.uint8)
    outdata[0] = len(packets)
    idx = 1
    for p in packets:
        if p.dtype != np.uint8:
            raise Exception("pack_multi only accepts uint8")
        outdata[idx] = len(p) >> 8
        outdata[idx + 1] = len(p) % 256
        idx += 2
        outdata[idx:idx+len(p)] = p
        idx += len(p)
    return outdata

def unpack_multi(data):
    if data.dtype != np.uint8:
        raise Exception("unpack_multi only accepts uint8")
    packet_count = data[0]
    data_idx = 1
    result = []
    for i in range(packet_count):
        length = (data[data_idx] << 8) + data[data_idx + 1]
        data_idx += 2
        packet = data[data_idx:data_idx+length]
        data_idx += length
        result.append(packet)
    return result

def handle_post(in_data_raw, query_params):
    global last_request_clock
    global first_client_write_clock
    global first_client_total_samples
    global first_client_value

    # NOTE NOTE NOTE:
    # * All `clock` variables are measured in samples.
    # * All `clock` variables represent the END of an interval, NOT the
    #   beginning. It's arbitrary which one to use, but you have to be
    #   consistent, and trust me that it's slightly nicer this way.

    # Note: This will eventually create a precision problem for the JS
    #   clients, which are using floats. Specifically, at 44100 Hz, it will
    #   fail on February 17, 5206.
    server_clock = int(time.time() * SAMPLE_RATE)

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

    update_users(userid, username, server_clock, client_read_clock)
    user = users[userid]

    msg_chats = query_params.get("chat", None)
    if msg_chats:
        msg_chats, = msg_chats
        msg_chats = json.loads(msg_chats)
        for other_userid, other_user in users.items():
            if other_userid != userid:
                for msg_chat in msg_chats:
                    other_user.chats_to_send.append((username, msg_chat))

    if query_params.get("request_lead", None):
        assign_delays(userid)

    in_data = np.frombuffer(in_data_raw, dtype=np.uint8)

    # Audio from clients is summed, so we need to clear the circular
    #   buffer ahead of them. The range we are clearing was "in the
    #   future" as of the last request, and we never touch the future,
    #   so nothing has touched it yet "this time around".
    if last_request_clock is not None:
        n_zeros = min(server_clock - last_request_clock, len(queue))
        zeros = np.zeros(n_zeros, np.int16)
        wrap_assign(last_request_clock, zeros)

    saved_last_request_clock = last_request_clock
    last_request_clock = server_clock

    if not user.opus_state:
        # initialize
        pass

    dec = opuslib.Decoder(SAMPLE_RATE, CHANNELS)
    packets = unpack_multi(in_data)
    decoded = []
    for p in packets:
        d = dec.decode(p.tobytes(), OPUS_FRAME_SAMPLES, decode_fec=False)
        decoded.append(np.frombuffer(d, np.int16))
    # decoded_len = sum([len(x) for x in decoded])
    # in_data = np.array([decoded_len], np.int16)
    in_data = np.concatenate(decoded)
    """
    idx = 0
    for d in decoded:
        in_data[idx:idx+len(d)] = d[:]
        idx += len(d)
    """

    kill_client = False
    # Note: If we get a write that is "too far" in the past, we need to throw it away.
    if client_write_clock is None:
        pass
    elif client_write_clock - len(in_data) < server_clock - len(queue):
        # Client is too far behind and going to wrap the buffer. :-(
        kill_client = True
    else:
        wrap_assign(client_write_clock,
                    wrap_get(client_write_clock, len(in_data)) +
                    in_data)

    # Why subtract len(in_data) above and below? Because the future is to the
    #   right. So when a client asks for n samples at time t, what they
    #   actually want is "the time interval ending at t", i.e. [t-n, t). Since
    #   the latest possible time they can ask for is "now", this means that
    #   the latest possible time interval they can get is "the recent past"
    #   instead of "the near future".
    # This doesn't matter to the clients if they all use the same value of
    #   len(in_data), but it matters if len(in_data) changes, and it matters for
    #   the server's zeroing.

    if query_params.get("loopback", [None])[0] == "true":
        data = in_data
    else:
        data = wrap_get(client_read_clock, len(in_data))

    enc = opuslib.Encoder(SAMPLE_RATE, CHANNELS, opuslib.APPLICATION_AUDIO)
    packets = data.reshape([-1, OPUS_FRAME_SAMPLES])
    encoded = []
    for p in packets:
        e = np.frombuffer(enc.encode(p.tobytes(), OPUS_FRAME_SAMPLES), np.uint8)
        encoded.append(e)
    data = pack_multi(encoded).tobytes()

    x_audio_metadata = json.dumps({
        "server_clock": server_clock,
        "last_request_clock": saved_last_request_clock,
        "client_read_clock": client_read_clock,
        "client_write_clock": client_write_clock,
        "user_summary": user_summary(),
        "chats": user.chats_to_send,
        "delay_samples": user.delay_to_send,
        # Both the following uses units of 128-sample frames
        "queue_size": len(queue) / FRAME_SIZE,
        "kill_client": kill_client,
    })

    user.chats_to_send.clear()
    user.delay_to_send = None

    return data, x_audio_metadata

class OurHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        server_clock = int(time.time() * SAMPLE_RATE)
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "X-Audio-Metadata")
        self.send_header("X-Audio-Metadata", json.dumps({
            "server_clock": server_clock
        }))
        self.send_header("Content-Length", 0)
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers["Content-Length"])
        in_data_raw = self.rfile.read(content_length)

        parsed_url = urllib.parse.urlparse(self.path)
        query_params = {}
        if parsed_url.query:
            query_params = urllib.parse.parse_qs(parsed_url.query, strict_parsing=True)

        try:
            data, x_audio_metadata = handle_post(in_data_raw, query_params)
        except ValueError as e:
            self.send_response(500)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "X-Audio-Metadata")
        self.send_header("X-Audio-Metadata", x_audio_metadata)
        self.send_header("Content-Length", len(data))
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        self.wfile.write(data)

if __name__ == "__main__":
    server = http.server.HTTPServer(('', 8081), OurHandler)
    server.serve_forever()
