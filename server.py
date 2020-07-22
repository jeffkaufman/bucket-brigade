#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import struct
import time

last_request_clock = None
first_client_write_clock = None
first_client_total_samples = None
first_client_value = None

# TODO: Write pointer trails read pointer to offset round-trip latency
queue = [0] * (30 * 44100)

class OurHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        global last_request_clock
        global first_client_write_clock
        global first_client_total_samples
        global first_client_value

        # Note: This will eventually create a precision problem for the JS
        #   clients, which are using floats. Specifically, it will fail on
        #   February 17, 5206.
        server_clock = int(time.time() * 44100)

        content_length = int(self.headers["Content-Length"])
        parsed_url = urllib.parse.urlparse(self.path)
        query_params = {}
        if parsed_url.query:
            query_params = urllib.parse.parse_qs(parsed_url.query, strict_parsing=True)

        in_data_raw = self.rfile.read(content_length)
        n_samples = len(in_data_raw) // 4
        in_data = struct.unpack(str(n_samples) + "f", in_data_raw)

        # Audio from clients is summed, so we need to clear the circular
        #   buffer ahead of them.
        if last_request_clock is not None:
            # XXX: Is adding n_samples here correct or a hack?
            clear_samples = server_clock - last_request_clock + n_samples
            for i in range(server_clock, server_clock + clear_samples):
                queue[i % len(queue)] = 0

        last_request_clock = server_clock

        if query_params.get("write_clock", ["null"])[0] == "null":
            client_write_clock = None
        else:
            client_write_clock = int(query_params["write_clock"][0])

        if query_params.get("read_clock", ["null"])[0] == "null":
            client_read_clock = None
        else:
            client_read_clock = int(query_params["read_clock"][0])

        client_offset = int(parsed_url.path[1:])

        if client_read_clock is None:
            client_read_clock = server_clock - client_offset

        # Note: If we get a write that is "too far" in the past, we need to throw it away.
        if client_write_clock is None:
            # Client warming up
            pass
        elif client_write_clock < server_clock - len(queue):
            # Someone is having a bad day. TODO: Tell them?
            print("Client is way behind?!")
            import code
            code.interact(local=dict(globals(), **locals()))
            pass
        else:
            if first_client_write_clock is None:
                first_client_write_clock = client_write_clock
                first_client_total_samples = 0
                first_client_value = in_data[0]
                print("First client value is:", first_client_value)
            first_client_total_samples += n_samples
            for i in range(n_samples):
                queue[(client_write_clock + i) % len(queue)] += in_data[i]

        data = [0] * n_samples
        for i in range(n_samples):
            data[i] = queue[(client_read_clock + i) % len(queue)]

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

        #if query_params["loopback"][0] == "true":
        #    data = in_data_raw
        #else:
        data = struct.pack(str(n_samples) + "f", *data)

        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "X-Audio-Metadata")
        self.send_header("X-Audio-Metadata", json.dumps({
            "client_read_clock": client_read_clock
        }))
        self.send_header("Content-Length", len(data))
        self.end_headers()

        self.wfile.write(data)

server = http.server.HTTPServer(('', 8081), OurHandler)
server.serve_forever()
