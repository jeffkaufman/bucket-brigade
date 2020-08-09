#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import struct
import numpy as np
import time
import cProfile

FRAME_SIZE = 128
PROFILE = cProfile.Profile()

last_request_clock = None

# hardcode float32
client_encoding = "f"
client_sample_size = 4
client_type = np.float32

QUEUE_SECONDS = 120
SAMPLE_RATE = 11025
# Force rounding to multiple of FRAME_SIZE
queue = np.zeros(QUEUE_SECONDS * SAMPLE_RATE // FRAME_SIZE * FRAME_SIZE, client_type)

def queue_summary():
    result = []
    """
    zero = True
    for i in range(len(queue)//FRAME_SIZE):
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
    """
    return result

def slice_wrap(a, off, length):
    off %= len(a)

    if length > len(a):
        raise Exception("slice past end of array")

    if off + length <= len(a):
        return (a[off:off+length], np.zeros(0))
    else:
        return (a[off:], a[:off+length - len(a)])

def clear_array(a, start, length):
    view = slice_wrap(a, start, length)
    view[0][:] = 0
    view[1][:] = 0

def copy_in(dest, dstart, src):
    view = slice_wrap(dest, dstart, len(src))
    view[0][:] = src[:len(view[0])]
    view[1][:] = src[len(view[0]):]

def copy_out(dest, sstart, src):
    view = slice_wrap(src, sstart, len(dest))
    dest[:len(view[0])] = view[0]
    dest[len(view[0]):] = view[1]

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

    #def do_POST(self):
    #    PROFILE.runcall(self.do_real_POST)

    def do_POST(self):
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
        #   clients, which are using floats. Specifically, it will fail on
        #   February 17, 5206.
        server_clock = int(time.time() * SAMPLE_RATE)

        content_length = int(self.headers["Content-Length"])
        parsed_url = urllib.parse.urlparse(self.path)
        query_params = {}
        if parsed_url.query:
            query_params = urllib.parse.parse_qs(parsed_url.query, strict_parsing=True)

        client_write_clock = query_params.get("write_clock", None)
        if client_write_clock is not None:
            client_write_clock = int(client_write_clock[0])
        client_read_clock = query_params.get("read_clock", None)
        if client_read_clock is not None:
            client_read_clock = int(client_read_clock[0])
        else:
            self.send_response(500)
            self.end_headers()
            return

        in_data_raw = self.rfile.read(content_length)
        in_data = np.frombuffer(in_data_raw, dtype=client_type)
        n_samples = len(in_data_raw) // client_sample_size

        # Audio from clients is summed, so we need to clear the circular
        #   buffer ahead of them. The range we are clearing was "in the
        #   future" as of the last request, and we never touch the future,
        #   so nothing has touched it yet "this time around".
        if last_request_clock is not None:
            clear_array(queue, start=server_clock, length=last_request_clock-server_clock)

        saved_last_request_clock = last_request_clock
        last_request_clock = server_clock

        kill_client = False
        if client_write_clock is None:
            pass
        elif client_write_clock - n_samples < server_clock - len(queue):
            # Client is too far behind and going to wrap the buffer. :-(
            kill_client = True
        else:
            writepos = client_write_clock - n_samples
            copy_in(dest=queue, dstart=writepos, src=in_data)

        # Why subtract n_samples above and below? Because the future is to the
        #   right. So when a client asks for n samples at time t, what they
        #   actually want is "the time interval ending at t", i.e. [t-n, t). Since
        #   the latest possible time they can ask for is "now", this means that
        #   the latest possible time interval they can get is "the recent past"
        #   instead of "the near future".
        # This doesn't matter to the clients if they all use the same value of
        #   n_samples, but it matters if n_samples changes, and it matters for
        #   the server's zeroing.

        if query_params.get("loopback", [None])[0] == "true":
            out_data = in_data_raw
        else:
            out_data = np.zeros(n_samples, client_type)
            readpos = client_read_clock - n_samples
            copy_out(dest=out_data, sstart=readpos, src=queue)
            out_data = out_data.tobytes()

        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "X-Audio-Metadata")
        self.send_header("X-Audio-Metadata", json.dumps({
            "server_clock": server_clock,
            "last_request_clock": saved_last_request_clock,
            "client_read_clock": client_read_clock,
            "client_write_clock": client_write_clock,
            # Both of the following use units of 128-sample frames
            "queue_summary": queue_summary(),
            "queue_size": len(queue) / FRAME_SIZE,
            "kill_client": kill_client,
        }))
        self.send_header("Content-Length", len(out_data))
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()

        self.wfile.write(out_data)

server = http.server.HTTPServer(('', 8081), OurHandler)

try:
    PROFILE.runcall(server.serve_forever)
except:
    print("shutting down...")
    server.shutdown()
    print("...done.")
    PROFILE.print_stats(sort='cumtime')
