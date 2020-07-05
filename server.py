#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler
import json

N_LAYERS = 5

# TODO: Write pointer trails read pointer to offset round-trip latency
queue = bytearray(10 * 44100)
rdptr = [0] * N_LAYERS
wrptr = [0] * N_LAYERS

class OurHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers["Content-Length"])
        in_data = self.rfile.read(content_length)
        layer = int(self.path[1:])

        for i in range(len(in_data)):
            queue[wrptr[layer]] = in_data[i]
            wrptr[layer] = (wrptr[layer] + 1) % len(queue)

        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

        out_data = bytearray(len(in_data))
        if (layer != 1):
            for i in range(len(in_data)):
                out_data[i] = queue[rdptr[layer]]
                rdptr[layer] = (rdptr[layer] + 1) % len(queue)

        self.wfile.write(out_data)

server = http.server.HTTPServer(('', 8081), OurHandler)
server.serve_forever()
