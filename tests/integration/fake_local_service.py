#!/usr/bin/env python3
"""A stand-in `local` engine service, for Witchgrid integration tests.

Plays the part of a Python-venv service such as Riko's voice server: it
binds the port the agent hands it in env PORT and answers
  GET /health → 200 {"status":"ok"}
  GET /env    → what the agent actually gave it (cwd, PORT, DEVICE,
                CUDA_VISIBLE_DEVICES, argv, pid/pgid, and whether a
                canary var from the agent's own env leaked through)
so the harness can check the spawn contract from the outside.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ["PORT"])


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = {"status": "ok"}
        elif self.path == "/env":
            body = {
                "cwd": os.getcwd(),
                "PORT": os.environ.get("PORT"),
                "DEVICE": os.environ.get("DEVICE"),
                "CUDA_VISIBLE_DEVICES": os.environ.get("CUDA_VISIBLE_DEVICES"),
                "canary_leaked": "WG_INTEGRATION_CANARY" in os.environ,
                "argv": sys.argv,
                "pid": os.getpid(),
                "pgid": os.getpgid(0),
            }
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
