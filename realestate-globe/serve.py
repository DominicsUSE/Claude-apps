#!/usr/bin/env python3
"""Serve Build Atlas locally and connect its "Ask AI" tab to your nanobot.

    python3 serve.py                 # map on http://127.0.0.1:8000
    python3 serve.py --port 8080 --nanobot http://127.0.0.1:8900 --key "$NANOBOT_API_KEY"

The page talks to /nanobot/... on this same server, which forwards to nanobot's
OpenAI-compatible API (start it with `nanobot serve`). nanobot's API sends no CORS
headers, so the browser cannot call it directly; going through this server avoids that.
Only the health check and chat completions are forwarded. Standard library only.
"""
import argparse
import http.server
import os
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ALLOWED = {("GET", "/nanobot/health"), ("POST", "/nanobot/v1/chat/completions")}


def make_handler(nanobot, key):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=HERE, **kw)

        def do_GET(self):
            if self.path.startswith("/nanobot/"):
                return self.forward("GET")
            if self.path in ("/", ""):
                self.path = "/index.html"
            return super().do_GET()

        def do_POST(self):
            return self.forward("POST")

        def forward(self, method):
            path = self.path.split("?")[0]
            if (method, path) not in ALLOWED:
                return self.send_error(404)
            body = None
            if method == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                if length > 2_000_000:
                    return self.send_error(413)
                body = self.rfile.read(length)
            req = urllib.request.Request(nanobot + path[len("/nanobot"):], data=body, method=method)
            req.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
            if key:
                req.add_header("Authorization", "Bearer " + key)
            try:
                with urllib.request.urlopen(req, timeout=300) as up:
                    self.send_response(up.status)
                    ctype = up.headers.get("Content-Type", "application/json")
                    self.send_header("Content-Type", ctype)
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    # pass streamed (SSE) replies through as they arrive
                    while True:
                        chunk = up.read1(4096) if hasattr(up, "read1") else up.read(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except urllib.error.HTTPError as e:
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(e.read())
            except (urllib.error.URLError, OSError):
                self.send_error(502, "nanobot is not reachable at " + nanobot)

        def log_message(self, fmt, *args):
            if self.path.startswith("/nanobot/v1"):
                super().log_message(fmt, *args)

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--nanobot", default=os.environ.get("NANOBOT_URL", "http://127.0.0.1:8900"))
    ap.add_argument("--key", default=os.environ.get("NANOBOT_API_KEY", ""), help="nanobot api.apiKey, if you set one")
    a = ap.parse_args()
    srv = http.server.ThreadingHTTPServer((a.host, a.port), make_handler(a.nanobot.rstrip("/"), a.key))
    print(f"Build Atlas: http://{a.host}:{a.port}  (Ask AI -> nanobot at {a.nanobot})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
