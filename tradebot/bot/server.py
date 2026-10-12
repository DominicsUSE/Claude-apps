"""Two small web servers.

* Dashboard (127.0.0.1:8787): only reachable from your own computer.
* TradingView webhook (127.0.0.1:8788): receives alerts only. To let TradingView reach it, run a
  tunnel (see README) that points at this port, never at the dashboard's.
"""
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import config as config_mod
from . import lab
from .models import Signal
from .tradingview import AlertError, parse_alert

log = logging.getLogger("tradebot")
STATIC = Path(__file__).resolve().parent / "static"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
EDITABLE_SECRETS = set(config_mod.SECRET_NAMES)


def write_env(updates: dict, path: Path | None = None) -> None:
    """Set or replace KEY=VALUE lines in .env; an empty value removes the key."""
    path = path or config_mod.ENV_PATH
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    done = set()
    out = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if key in updates:
            done.add(key)
            if updates[key]:
                out.append(f"{key}={updates[key]}")
            continue
        out.append(line)
    for key, value in updates.items():
        if key not in done and value:
            out.append(f"{key}={value}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    import os
    for key, value in updates.items():
        if value:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)


class DashboardHandler(BaseHTTPRequestHandler):
    engine = None
    lab_lock = threading.Lock()

    def log_message(self, fmt, *args):
        pass

    def _send(self, code: int, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(data)

    def _host_ok(self) -> bool:
        # Blocks "DNS rebinding": a website pretending to be localhost to reach this dashboard.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in LOCAL_HOSTS

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ValueError("request too large")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw or b"{}")

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "forbidden"})
        path = urlparse(self.path).path
        e = self.engine
        if path in ("/", "/index.html"):
            return self._send(200, (STATIC / "dashboard.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/api/status":
            return self._send(200, e.status())
        if path == "/api/trades":
            return self._send(200, e.trades(300))
        if path == "/api/stats":
            s = e.stats()
            a = s["all"]
            if a["trades"]:
                s["ruin"] = lab.ruin_from_stats(a["win_rate"], a["avg_win"], a["avg_loss"], e.last_equity or 1,
                                                e.cfg["risk"]["max_drawdown_pct"], e.cfg["risk"]["risk_per_trade_pct"])
            return self._send(200, s)
        if path == "/api/config":
            return self._send(200, e.cfg)
        if path == "/api/secrets":
            return self._send(200, {k: bool(config_mod.secret(k)) for k in config_mod.SECRET_NAMES})
        if path == "/api/lab/strategies":
            return self._send(200, lab.strategies_list())
        if path == "/api/training":
            return self._send(200, e.training_report())
        if path == "/api/chart":
            q = parse_qs(urlparse(self.path).query)
            arg = lambda k: (q.get(k) or [""])[0]
            venue, mint = arg("venue") or "fomo", arg("mint")
            meme = e.strategies.get("meme_scalper")
            if not meme or not mint:
                return self._send(400, {"error": "meme_scalper is not available"})
            try:
                if venue == "liquid":
                    ident = mint
                else:
                    ident = arg("pool") or meme.state.get("pools", {}).get(mint)
                    if not ident:
                        ident = (e.sol.pairs([mint]).get(mint) or {}).get("pairAddress")
                    if not ident:
                        return self._send(404, {"error": "no trading pool found for this token"})
                out = meme.chart_payload(venue, ident, arg("interval") or None, e.hl)
            except Exception as ex:
                return self._send(502, {"error": f"chart data unavailable: {ex}"})
            out["mint"], out["pool"] = mint, ident
            out["trades"] = [r for r in e.trades(2000) if r["symbol"] == mint and r["venue"] == venue]
            o = e.state.get("owners", {}).get(f"{venue}:{mint}")
            out["position"] = {"entry": o.get("entry_price"), "stop": o.get("stop"), "setup": o.get("setup"), "side": o.get("side")} if o else None
            return self._send(200, out)
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        # The custom header can't be sent by a plain form on another website, which stops
        # other sites from clicking buttons on your dashboard behind your back.
        if not self._host_ok() or self.headers.get("X-Tradebot") != "1":
            return self._send(403, {"error": "forbidden"})
        path = urlparse(self.path).path
        e = self.engine
        try:
            body = self._body()
            if path == "/api/pause":
                e.pause()
            elif path == "/api/resume":
                e.resume()
            elif path == "/api/close_all":
                e.close_all()
            elif path == "/api/close":
                venue, _, symbol = str(body["key"]).partition(":")
                e.submit(Signal(venue, symbol, "close", "manual", label=body.get("label", ""),
                                close_fraction=float(body.get("fraction", 1.0)), reason="closed from the dashboard"))
            elif path == "/api/trade":
                side = body.get("side")
                if side not in ("buy", "sell"):
                    raise ValueError("side must be buy or sell")
                e.submit(Signal(body["venue"], str(body["symbol"]).strip(), side, "manual", label=body.get("label") or str(body["symbol"])[:12],
                                size_usd=float(body["size_usd"]), stop_pct=float(body.get("stop_pct") or 0) or None,
                                take_profit_pct=float(body.get("take_profit_pct") or 0) or None,
                                leverage=float(body.get("leverage") or 1), reason="manual trade from the dashboard"))
            elif path == "/api/config":
                cfg = config_mod.deep_merge(config_mod.DEFAULTS, body)
                config_mod.save_config(cfg)
                e.reload_config(cfg)
            elif path == "/api/strategy":
                cfg = e.cfg
                cfg["strategies"][body["name"]]["enabled"] = bool(body["enabled"])
                config_mod.save_config(cfg)
                e.reload_config(cfg)
                e.event("info", f"{body['name']} {'turned on' if body['enabled'] else 'turned off'}")
            elif path == "/api/secrets":
                updates = {k: str(v).strip() for k, v in body.items() if k in EDITABLE_SECRETS}
                write_env(updates)
                e.event("info", f"Saved {', '.join(updates)}. Restart the bot to reconnect.")
            elif path == "/api/training/start":
                if not e.trainer.start(body.get("profile", "fomo")):
                    raise RuntimeError("training is already running")
                e.event("info", "Training started from the dashboard")
            elif path == "/api/paper_reset":
                e.reset_paper(float(body.get("balance", 1000)))
            elif path.startswith("/api/lab/"):
                if not self.lab_lock.acquire(timeout=1):
                    return self._send(409, {"error": "another backtest is still running"})
                try:
                    kind = path.rsplit("/", 1)[-1]
                    fn = {"backtest": lab.run_backtest, "walkforward": lab.run_walk_forward, "compare": lab.compare}.get(kind)
                    if kind == "ruin":
                        return self._send(200, lab.ruin_from_stats(float(body["win_rate"]), float(body["avg_win"]), float(body["avg_loss"]),
                                                                   float(body["equity"]), float(body["ruin_pct"]), float(body["risk_pct"])))
                    if not fn:
                        return self._send(404, {"error": "not found"})
                    return self._send(200, fn(body, e.hl))
                finally:
                    self.lab_lock.release()
            else:
                return self._send(404, {"error": "not found"})
            return self._send(200, {"ok": True})
        except (KeyError, ValueError, TypeError, RuntimeError) as ex:
            return self._send(400, {"error": str(ex)})
        except Exception as ex:
            log.exception("dashboard request failed")
            return self._send(500, {"error": str(ex)})


class WebhookHandler(BaseHTTPRequestHandler):
    engine = None
    recent: list = []

    def log_message(self, fmt, *args):
        pass

    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True, "hint": "POST TradingView alerts here"})

    def do_POST(self):
        now = time.time()
        WebhookHandler.recent = [t for t in WebhookHandler.recent if now - t < 60]
        if len(WebhookHandler.recent) >= 30:
            return self._send(429, {"error": "too many alerts this minute"})
        WebhookHandler.recent.append(now)
        e = self.engine
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 20_000:
                raise AlertError("alert too large")
            raw = self.rfile.read(n).decode("utf-8", "replace")
            try:
                body = json.loads(raw)
            except ValueError:
                raise AlertError("the alert message must be JSON, e.g. {\"secret\": \"...\", \"symbol\": \"{{ticker}}\", \"action\": \"buy\"}")
            if not e.cfg["strategies"]["tradingview"]["enabled"]:
                raise AlertError("TradingView alerts are turned off in the dashboard")
            sig = parse_alert(body, config_mod.secret("TV_WEBHOOK_SECRET"), e.cfg, e.hl.has_market)
        except AlertError as ex:
            e.event("blocked", f"TradingView alert refused: {ex}")
            return self._send(400, {"error": str(ex)})
        e.event("signal", f"TradingView: {sig.action} {sig.label} ({sig.venue})")
        e.submit(sig)
        return self._send(200, {"ok": True})


def serve(engine) -> list[ThreadingHTTPServer]:
    servers = []
    d = engine.cfg["dashboard"]
    DashboardHandler.engine = engine
    dash = ThreadingHTTPServer((d["host"], d["port"]), DashboardHandler)
    servers.append(dash)
    if engine.cfg["webhook"]["enabled"]:
        w = engine.cfg["webhook"]
        WebhookHandler.engine = engine
        servers.append(ThreadingHTTPServer((w["host"], w["port"]), WebhookHandler))
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    return servers
