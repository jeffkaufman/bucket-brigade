#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler
import json
import urllib.parse

global_clock = 0

# TODO: Write pointer trails read pointer to offset round-trip latency
queue = [0] * (10 * 44100)

class OurHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        global global_clock
        content_length = int(self.headers["Content-Length"])
        parsed_url = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_url.query, strict_parsing=True)

        if query_params["write_clock"][0] == "null":
            client_write_clock = None
        else:
            client_write_clock = int(query_params["write_clock"][0])

        if query_params["read_clock"][0] == "null":
            client_read_clock = None
        else:
            client_read_clock = int(query_params["read_clock"][0])

        in_data = json.loads(self.rfile.read(content_length))

        client_offset = int(parsed_url.path[1:])
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

        data = [0] * len(in_data)
        if not is_primary:
            for i in range(len(in_data)):
                data[i] = queue[(client_read_clock + i) % len(queue)]

        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "X-Audio-Metadata")
        self.send_header("X-Audio-Metadata", json.dumps({
            client_read_clock: client_read_clock
        })
        body_data = json.dumps(data).encode("UTF-8")
        self.send_header("Content-Length", len(body_data))
        self.end_headers()

        self.wfile.write(body_data)

server = http.server.HTTPServer(('', 8081), OurHandler)
server.serve_forever()
