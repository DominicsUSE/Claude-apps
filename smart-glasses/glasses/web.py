"""Phone/laptop dashboard: live processed video, HUD preview, sensor data and a
command box. Standard library only (no Flask) to save RAM on the Pi.

Anyone on the network could otherwise watch your camera, so every request
needs the access token printed at startup.
"""

from __future__ import annotations

import io
import json
import logging
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from glasses import MODES
from glasses.hub import Hub

log = logging.getLogger(__name__)

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Glasses</title>
<style>
:root{color-scheme:dark;--bg:#0b0f14;--panel:#121922;--fg:#d8e1ea;--dim:#7d8b99;--acc:#38d0ff;--warn:#ff5050}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}
main{max-width:1100px;margin:auto;padding:12px 16px;display:grid;gap:12px;grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
@media(max-width:760px){main{grid-template-columns:1fr}}
section{background:var(--panel);border-radius:8px;padding:10px}h1{font-size:15px;margin:0 0 8px;color:var(--acc)}
img{width:100%;display:block;border-radius:4px;background:#000}#hud{image-rendering:pixelated;max-width:384px}
button{background:#1d2836;color:var(--fg);border:1px solid #2c3b4d;border-radius:6px;padding:6px 10px;margin:2px;cursor:pointer}
button.on{border-color:var(--acc);color:var(--acc)}input{width:100%;padding:8px;border-radius:6px;border:1px solid #2c3b4d;background:#0e141b;color:var(--fg)}
summary{cursor:pointer;color:var(--acc);font-weight:600;margin:8px 0}pre{white-space:pre-wrap;margin:0;font:12px ui-monospace,monospace;color:var(--dim)}.alert{color:var(--warn);font-weight:600}
</style></head><body><main>
<section><h1>View</h1><img id="view" src="stream.mjpg?t=TOKEN" alt="processed camera view">
<div id="modes"></div><button data-t="zoom in">Zoom +</button><button data-t="zoom out">Zoom -</button>
<button data-t="reset zoom">Zoom 1x</button><button data-t="describe">Describe</button><button data-t="snapshot">Photo</button></section>
<section><h1>HUD</h1><img id="hud" src="hud.png?t=TOKEN" alt="HUD preview">
<p id="alerts" class="alert"></p><h1>Ask or command</h1>
<form id="f"><input id="q" placeholder="e.g. what is this? / thermal mode / how far" autocomplete="off"></form>
<p id="answer"></p><details><summary>Sensors and module status</summary><pre id="state">loading...</pre></details></section></main>
<script>
const T="TOKEN",MODES=MODES_JSON;
const send=t=>fetch("cmd?t="+T,{method:"POST",body:JSON.stringify({text:t})});
document.getElementById("modes").innerHTML=MODES.map(m=>`<button data-m="${m}">${m}</button>`).join("");
document.body.addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;
 if(b.dataset.m)fetch("cmd?t="+T,{method:"POST",body:JSON.stringify({mode:b.dataset.m})});else send(b.dataset.t)});
document.getElementById("f").addEventListener("submit",e=>{e.preventDefault();const q=document.getElementById("q");send(q.value);q.value=""});
async function poll(){try{const s=await (await fetch("state.json?t="+T)).json();
 document.getElementById("state").textContent=JSON.stringify(s,null,1);
 document.getElementById("alerts").textContent=(s.alerts||[]).map(a=>a[1]).join(" | ");
 document.getElementById("answer").textContent=s.ai_busy?"thinking...":(s.ai_answer||"");
 document.querySelectorAll("[data-m]").forEach(b=>b.classList.toggle("on",b.dataset.m===s.mode));
 document.getElementById("hud").src="hud.png?t="+T+"&n="+Date.now();}catch(e){}setTimeout(poll,700)}poll();
</script></body></html>"""

SKIP = {"frame", "thermal", "hud_image", "view_jpeg"}


def json_state(hub: Hub) -> dict:
    snap = {k: v for k, v in hub.snapshot().items() if k not in SKIP}
    snap["status"] = dict(hub.status)
    return snap


class Handler(BaseHTTPRequestHandler):
    hub: Hub
    token: str

    def log_message(self, fmt, *args):  # quiet access log
        log.debug(fmt, *args)

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _route(self) -> tuple[str, dict] | None:
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if not secrets.compare_digest(q.get("t", [""])[0], self.token):
            self._send(403, b"forbidden: add ?t=<token> (see the log)", "text/plain")
            return None
        return url.path, q

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        routed = self._route()
        if routed is None:
            return
        path, _q = routed
        if path == "/":
            page = PAGE.replace("TOKEN", self.token).replace("MODES_JSON", json.dumps(list(MODES)))
            self._send(200, page.encode(), "text/html; charset=utf-8")
        elif path == "/state.json":
            self._send(200, json.dumps(json_state(self.hub), default=str).encode(), "application/json")
        elif path == "/hud.png":
            img = self.hub.get("hud_image")
            if img is None:
                self._send(404, b"no hud", "text/plain")
                return
            buf = io.BytesIO()
            img.convert("RGB").save(buf, "PNG")
            self._send(200, buf.getvalue(), "image/png")
        elif path == "/stream.mjpg":
            self._stream()
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:  # noqa: N802
        routed = self._route()
        if routed is None:
            return
        if routed[0] != "/cmd":
            self._send(404, b"not found", "text/plain")
            return
        try:
            n = min(int(self.headers.get("Content-Length", 0)), 4096)
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            self._send(400, b"bad json", "text/plain")
            return
        if body.get("mode") in MODES:
            self.hub.command("mode", body["mode"])
        elif isinstance(body.get("text"), str) and body["text"].strip():
            self.hub.command("text", body["text"][:500])
        self._send(204, b"", "text/plain")

    def _stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last = None
        try:
            while not self.hub.stop.is_set():
                self.hub.put("viewer_seen", time.monotonic())
                jpg = self.hub.get("view_jpeg", max_age=3.0)
                if jpg is not None and jpg is not last:
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                     + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                    last = jpg
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass  # viewer closed the page


class WebServer:
    def __init__(self, hub: Hub, cfg: dict):
        self.token = cfg["token"] or secrets.token_urlsafe(9)
        handler = type("BoundHandler", (Handler,), {"hub": hub, "token": self.token})
        self.httpd = ThreadingHTTPServer((cfg["host"], int(cfg["port"])), handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]

    def start(self) -> None:
        threading.Thread(target=self.httpd.serve_forever, name="web", daemon=True).start()
        log.info("dashboard: http://<glasses-ip>:%d/?t=%s", self.port, self.token)

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
