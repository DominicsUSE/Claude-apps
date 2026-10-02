#!/usr/bin/env python3
"""Serve Build Atlas locally and connect its "Ask AI" tab to your nanobot.

    python3 serve.py                 # map on http://127.0.0.1:8000
    python3 serve.py --port 8080 --nanobot http://127.0.0.1:8900 --key "$NANOBOT_API_KEY"

Every 10 minutes it also fetches property and economy headlines (Google News RSS) and
serves them at /news.json; the page uses them to nudge country scores.

The page talks to /nanobot/... on this same server, which forwards to nanobot's
OpenAI-compatible API (start it with `nanobot serve`). nanobot's API sends no CORS
headers, so the browser cannot call it directly; going through this server avoids that.
Only the health check and chat completions are forwarded. Standard library only.
"""
import argparse
import datetime
import email.utils
import html
import http.server
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- news: headlines about property, economies and seizures, refreshed every 10 minutes ----
NEWS_EVERY_S = 10 * 60
NEWS_QUERIES = [
    "real estate market", "housing market", "property prices", "property investment",
    "construction boom", "foreign buyers property", "expropriation OR nationalization OR seize property",
    "sanctions economy", "economic growth GDP", "currency crisis inflation",
]
NEWS = {"fetched": None, "items": []}


def parse_rss(xml):
    items = []
    for block in re.findall(r"<item>(.*?)</item>", xml, re.S):
        def get(tag):
            m = re.search(r"<%s[^>]*>(.*?)</%s>" % (tag, tag), block, re.S)
            if not m:
                return ""
            return html.unescape(re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", m.group(1), flags=re.S)).strip()
        source, title = get("source"), get("title")
        if source and title.endswith(" - " + source):
            title = title[: -(len(source) + 3)]
        try:
            published = email.utils.parsedate_to_datetime(get("pubDate")).isoformat()
        except (TypeError, ValueError):
            published = datetime.datetime.now(datetime.timezone.utc).isoformat()
        items.append({"title": title, "link": get("link"), "source": source, "published": published})
    return items


def refresh_news():
    global NEWS
    seen, items, failures = set(), [], 0
    for q in NEWS_QUERIES:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": q + " when:2d", "hl": "en-US", "gl": "US", "ceid": "US:en"})
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "BuildAtlas/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                for it in parse_rss(r.read().decode("utf-8", "replace")):
                    key = it["title"].lower()
                    if it["title"] and key not in seen:
                        seen.add(key)
                        items.append(it)
        except (urllib.error.URLError, OSError, ValueError):
            failures += 1
    if items:
        NEWS = {"fetched": datetime.datetime.now(datetime.timezone.utc).isoformat(), "items": items[:600]}
    elif failures:
        NEWS = dict(NEWS, error="offline")  # keep the last headlines we had


def news_loop():
    while True:
        refresh_news()
        time.sleep(NEWS_EVERY_S)


ALLOWED = {("GET", "/nanobot/health"), ("POST", "/nanobot/v1/chat/completions")}


def make_handler(nanobot, key):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=HERE, **kw)

        def do_GET(self):
            if self.path.split("?")[0] == "/news.json":
                body = json.dumps(NEWS).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return None
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
    ap.add_argument("--no-news", action="store_true", help="do not fetch news headlines every 10 minutes")
    a = ap.parse_args()
    if not a.no_news:
        threading.Thread(target=news_loop, daemon=True).start()
    srv = http.server.ThreadingHTTPServer((a.host, a.port), make_handler(a.nanobot.rstrip("/"), a.key))
    print(f"Build Atlas: http://{a.host}:{a.port}  (Ask AI -> nanobot at {a.nanobot})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
