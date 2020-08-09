#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import time
import numpy as np
import struct

FRAME_SIZE = 128

last_request_clock = None
first_client_write_clock = None
first_client_total_samples = None
first_client_value = None

QUEUE_SECONDS = 120
SAMPLE_RATE = 11025


def clamp(n, min_n, max_n):
    return max(min(max_n, n), min_n)

SAMPLE_PARAMS = {
    "f": {
        "size": 4,
        "decode": lambda x: x,
        "encode": lambda x: x,
    },
    "b": {
        "size": 1,
        "decode": lambda x: x / 127.0,
        "encode": lambda x: int(clamp(x, -1.0, 1.0) * 127),
    }
}

# Force rounding to multiple of FRAME_SIZE
mode = 0
if mode > 0:
    queue = np.zeros((QUEUE_SECONDS * SAMPLE_RATE // FRAME_SIZE * FRAME_SIZE),
                     np.int16)
else:
    queue = [0] * (QUEUE_SECONDS * SAMPLE_RATE // FRAME_SIZE * FRAME_SIZE)

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


def queue_summary():
    result = []
    zero = True
    for i in range(len(queue)//FRAME_SIZE):
        # not technically correct but close enough for debugging
        # numpy computation doesn't short circuit so is faster than loop in
        # worst case but often slower

        if mode > 0:
            all_zero = np.sum(queue[(FRAME_SIZE*i):(FRAME_SIZE*(i+1))]) == 0
        else:
            all_zero = True
            for j in range(FRAME_SIZE):
                if queue[FRAME_SIZE*i + j] != 0:
                    all_zero = False
                    break
            
        if zero and (not all_zero):
            zero = False
            result.append(i)
        elif (not zero) and all_zero:
            zero = True
            result.append(i)
    return result

def handle_post(in_data_raw, query_params):
    global last_request_clock
    global first_client_write_clock
    global first_client_total_samples
    global first_client_value

    client_sample_size = SAMPLE_PARAMS['b']["size"]
    client_decoder = SAMPLE_PARAMS['b']["decode"]
    client_encoder = SAMPLE_PARAMS['b']["encode"]
    
    # NOTE NOTE NOTE:
    # * All `clock` variables are measured in samples.
    # * All `clock` variables represent the END of an interval, NOT the
    #   beginning. It's arbitrary which one to use, but you have to be
    #   consistent, and trust me that it's slightly nicer this way.

    # Note: This will eventually create a precision problem for the JS
    #   clients, which are using floats. Specifically, it will fail on
    #   February 17, 5206.
    server_clock = int(time.time() * SAMPLE_RATE)

    client_write_clock = query_params.get("write_clock", None)
    if client_write_clock is not None:
        client_write_clock = int(client_write_clock[0])
    client_read_clock = query_params.get("read_clock", None)
    if client_read_clock is not None:
        client_read_clock = int(client_read_clock[0])
    else:
        raise ValueError("no client read clock")

    if mode > 0:
        in_data = np.frombuffer(in_data_raw, dtype=np.int8)
    else:
        n_samples = len(in_data_raw) // client_sample_size
        in_data = struct.unpack(str(n_samples) + 'b', in_data_raw)

    # Audio from clients is summed, so we need to clear the circular
    #   buffer ahead of them. The range we are clearing was "in the
    #   future" as of the last request, and we never touch the future,
    #   so nothing has touched it yet "this time around".
    if last_request_clock is not None:
        if mode > 0:
            zeros = np.zeros(server_clock - last_request_clock, np.int16)
            wrap_assign(last_request_clock, zeros)
        else:
            for i in range(last_request_clock, server_clock):
                queue[i % len(queue)] = 0

    saved_last_request_clock = last_request_clock
    last_request_clock = server_clock

    kill_client = False
    # Note: If we get a write that is "too far" in the past, we need to throw it away.
    if client_write_clock is None:
        pass
    elif client_write_clock - len(in_data) < server_clock - len(queue):
        # Client is too far behind and going to wrap the buffer. :-(
        kill_client = True
    else:
        # XXX: debugging hackery
        #if first_client_write_clock is None:
        #    first_client_write_clock = client_write_clock
        #    first_client_total_samples = 0
        #    first_client_value = in_data[0]
        #    print("First client value is:", first_client_value)
        #first_client_total_samples += len(in_data)
        if mode > 0:
            wrap_assign(client_write_clock,
                        wrap_get(client_write_clock, len(in_data)) +
                        np.array(in_data, dtype=np.int16))
        else:
            for i in range(n_samples):
                queue[(client_write_clock - n_samples + i) %
                      len(queue)] += client_decoder(in_data[i])

    # Why subtract len(in_data) above and below? Because the future is to the
    #   right. So when a client asks for n samples at time t, what they
    #   actually want is "the time interval ending at t", i.e. [t-n, t). Since
    #   the latest possible time they can ask for is "now", this means that
    #   the latest possible time interval they can get is "the recent past"
    #   instead of "the near future".
    # This doesn't matter to the clients if they all use the same value of
    #   len(in_data), but it matters if len(in_data) changes, and it matters for
    #   the server's zeroing.

    if mode > 0:
        data = wrap_get(client_read_clock, len(in_data))
        data = np.minimum(data, 127)
        data = np.maximum(data, -128)
        data = np.array(data, dtype=np.int8)
        data = data.tobytes()
    else:
        data = [0] * n_samples
        for i in range(n_samples):
            data[i] = client_encoder(queue[(client_read_clock - n_samples + i)
                                           % len(queue)])
        data = struct.pack(str(n_samples) + 'b', *data)
        
    x_audio_metadata = json.dumps({
        "server_clock": server_clock,
        "last_request_clock": saved_last_request_clock,
        "client_read_clock": client_read_clock,
        "client_write_clock": client_write_clock,
        # Both of the following use units of 128-sample frames
        "queue_summary": None, #queue_summary(),
        "queue_size": len(queue) / FRAME_SIZE,
        "kill_client": kill_client,
    })

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
