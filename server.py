#!/usr/bin/env python3

import http.server
from http.server import BaseHTTPRequestHandler

class OurHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers["Content-Length"])
        data = self.rfile.read(content_length)
        print(data)
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

server = http.server.HTTPServer(('', 8081), OurHandler)
server.serve_forever()
