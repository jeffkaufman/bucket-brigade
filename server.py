#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import struct
import time

FRAME_SIZE = 128

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

last_request_clock = None
first_client_write_clock = None
first_client_total_samples = None
first_client_value = None

QUEUE_SECONDS = 120
SAMPLE_RATE = 11025
# Force rounding to multiple of FRAME_SIZE
queue = [0] * (QUEUE_SECONDS * SAMPLE_RATE // FRAME_SIZE * FRAME_SIZE)

def queue_summary():
    result = []
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
    return result

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
        client_encoding = query_params.get("encoding", ["f"])[0]
        client_sample_size = SAMPLE_PARAMS[client_encoding]["size"]
        client_decoder = SAMPLE_PARAMS[client_encoding]["decode"]
        client_encoder = SAMPLE_PARAMS[client_encoding]["encode"]

        in_data_raw = self.rfile.read(content_length)
        n_samples = len(in_data_raw) // client_sample_size
        in_data = struct.unpack(str(n_samples) + client_encoding, in_data_raw)

        # Audio from clients is summed, so we need to clear the circular
        #   buffer ahead of them. The range we are clearing was "in the
        #   future" as of the last request, and we never touch the future,
        #   so nothing has touched it yet "this time around".
        if last_request_clock is not None:
            for i in range(last_request_clock, server_clock):
                queue[i % len(queue)] = 0

        saved_last_request_clock = last_request_clock
        last_request_clock = server_clock

        kill_client = False
        # Note: If we get a write that is "too far" in the past, we need to throw it away.
        if client_write_clock is None:
            pass
        elif client_write_clock - n_samples < server_clock - len(queue):
            # Client is too far behind and going to wrap the buffer. :-(
            kill_client = True
        else:
            # XXX: debugging hackery
            #if first_client_write_clock is None:
            #    first_client_write_clock = client_write_clock
            #    first_client_total_samples = 0
            #    first_client_value = in_data[0]
            #    print("First client value is:", first_client_value)
            #first_client_total_samples += n_samples
            for i in range(n_samples):
                queue[(client_write_clock - n_samples + i) % len(queue)] += client_decoder(in_data[i])

        # Why subtract n_samples above and below? Because the future is to the
        #   right. So when a client asks for n samples at time t, what they
        #   actually want is "the time interval ending at t", i.e. [t-n, t). Since
        #   the latest possible time they can ask for is "now", this means that
        #   the latest possible time interval they can get is "the recent past"
        #   instead of "the near future".
        # This doesn't matter to the clients if they all use the same value of
        #   n_samples, but it matters if n_samples changes, and it matters for
        #   the server's zeroing.

        data = [0] * n_samples
        for i in range(n_samples):
            data[i] = client_encoder(queue[(client_read_clock - n_samples + i) % len(queue)])

        # Validate the first queue worth of writes from the first client
        """
        if first_client_total_samples is not None and first_client_total_samples <= len(queue):
            validation_offset = first_client_write_clock
            for i in range(len(queue)):
                if queue[(validation_offset + i) % len(queue)] not in (0, first_client_value + i):
                    print("Validation failed?!")
                    import code
                    code.interact(local=dict(globals(), **locals()))
        """

        if query_params.get("loopback", [None])[0] == "true":
            data = in_data_raw
        else:
            data = struct.pack(str(n_samples) + client_encoding, *data)

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
        self.send_header("Content-Length", len(data))
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()

        self.wfile.write(data)

server = http.server.HTTPServer(('', 8081), OurHandler)
server.serve_forever()
