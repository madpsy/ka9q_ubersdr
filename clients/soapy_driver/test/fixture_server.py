#!/usr/bin/env python3
"""A stand-in receiver that serves one /api/description body.

The driver reads its tuning range over HTTP with libcurl, so the only way to test that
path honestly is to put a real socket in front of it. Usage:

    fixture_server.py <port> <path-to-json-body>

A body of "-" makes every request 404, which is how an older server that does not
publish the endpoint at all behaves.
"""
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    body = b""
    serve = True

    def do_GET(self):
        if not self.serve or self.path != "/api/description":
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1])
    if sys.argv[2] == "-":
        Handler.serve = False
    else:
        with open(sys.argv[2], "rb") as fh:
            Handler.body = fh.read()
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
