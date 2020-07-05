#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler
import json
from collections import deque

global_clock = 0

# TODO: Write pointer trails read pointer to offset round-trip latency
queue = [0] * (10 * 44100)

class OurHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        global global_clock
        content_length = int(self.headers["Content-Length"])
        in_data, client_write_clock, client_read_clock = json.loads(self.rfile.read(content_length))

        client_offset = int(self.path[1:])
        is_primary = client_offset == 0

        if client_read_clock is None and not is_primary:
            client_read_clock = global_clock - client_offset

        if is_primary:
            for i in range(len(in_data)):
                queue[global_clock % len(queue)] = in_data[i]
                global_clock += 1
        else:
            # Note: If we get a write that is "too far" in the past, we need to throw it away.
            if client_write_clock is None:
                # Client warming up
                pass
            elif client_write_clock < global_clock - len(queue):
                # Someone is having a bad day. TODO: Tell them?
                pass
            else:
                for i in range(len(in_data)):
                    queue[(client_write_clock + i) % len(queue)] += in_data[i]

        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")

        data = [0] * len(in_data)
        if not is_primary:
            for i in range(len(in_data)):
                data[i] = queue[(client_read_clock + i) % len(queue)]

        body_data = json.dumps([data, client_read_clock]).encode("UTF-8")
        self.send_header("Content-Length", len(body_data))
        self.end_headers()

        self.wfile.write(body_data)

server = http.server.HTTPServer(('', 8081), OurHandler)
server.serve_forever()
