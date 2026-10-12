import json
import urllib.error
import urllib.request

import pytest

from bot import config as config_mod
from bot.server import serve


@pytest.fixture
def servers(engine, monkeypatch, tmp_path):
    engine.cfg["dashboard"]["port"] = 0
    engine.cfg["webhook"]["port"] = 0
    monkeypatch.setattr(config_mod, "ENV_PATH", tmp_path / ".env")
    monkeypatch.setattr(config_mod, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setenv("TV_WEBHOOK_SECRET", "hunter2")
    engine.tick()
    srv = serve(engine)
    yield [f"http://127.0.0.1:{s.server_address[1]}" for s in srv]
    for s in srv:
        s.shutdown()


def call(url, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}") if "json" in r.headers.get("Content-Type", "") else r.read()
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_dashboard_pages_and_controls(servers, engine):
    dash, _ = servers
    code, html = call(dash + "/")
    assert code == 200 and b"Tradebot" in html
    code, st = call(dash + "/api/status")
    assert code == 200 and st["mode"] == "paper"
    assert call(dash + "/api/pause", {})[0] == 403                     # no X-Tradebot header: refused
    assert call(dash + "/api/pause", {}, {"X-Tradebot": "1"})[0] == 200
    assert engine.state["paused"]
    assert call(dash + "/api/resume", {}, {"X-Tradebot": "1"})[0] == 200
    code, _ = call(dash + "/api/trade", {"venue": "liquid", "symbol": "BTC", "side": "buy", "size_usd": 30, "stop_pct": 5}, {"X-Tradebot": "1"})
    assert code == 200
    engine._drain_inbox()
    assert "liquid:BTC" in engine.state["owners"]
    code, _ = call(dash + "/api/strategy", {"name": "trend", "enabled": True}, {"X-Tradebot": "1"})
    assert code == 200 and engine.cfg["strategies"]["trend"]["enabled"]
    code, r = call(dash + "/api/lab/ruin", {"win_rate": 55, "avg_win": 20, "avg_loss": 20, "equity": 1000, "ruin_pct": 30, "risk_pct": 2}, {"X-Tradebot": "1"})
    assert code == 200 and r["simple_pct"] == pytest.approx(4.929, abs=0.01)


def test_secrets_never_echoed(servers, tmp_path):
    dash, _ = servers
    code, _ = call(dash + "/api/secrets", {"QUIVER_API_TOKEN": "abc123", "NOT_ALLOWED": "x"}, {"X-Tradebot": "1"})
    assert code == 200
    code, have = call(dash + "/api/secrets")
    assert have["QUIVER_API_TOKEN"] is True and "abc123" not in json.dumps(have)
    env = (tmp_path / ".env").read_text()
    assert "QUIVER_API_TOKEN=abc123" in env and "NOT_ALLOWED" not in env


def test_bad_host_header_refused(servers):
    dash, _ = servers
    req = urllib.request.Request(dash + "/api/status", headers={"Host": "evil.example"})
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(req, timeout=5)
    assert e.value.code == 403


def test_webhook(servers, engine):
    _, hook = servers
    assert call(hook + "/webhook", {"secret": "wrong", "symbol": "BTC", "action": "buy"})[0] == 400
    code, _ = call(hook + "/webhook", {"secret": "hunter2", "symbol": "BINANCE:ETHUSDT", "action": "buy", "size_usd": 25})
    assert code == 200
    engine._drain_inbox()
    assert engine.state["owners"]["liquid:ETH"]["strategy"] == "tradingview"


def test_approve_from_the_dashboard(servers, engine):
    from bot.models import Signal
    dash = servers[0]
    engine.cfg["approvals"]["ask"] = "always"
    engine.execute(Signal("liquid", "BTC", "buy", "trend", label="BTC", size_usd=50, stop_pct=5))
    code, st = call(dash + "/api/status")
    [a] = st["approvals"]
    assert call(dash + "/api/approvals", {"id": a["id"], "approve": True})[0] == 403      # no X-Tradebot header
    code, r = call(dash + "/api/approvals", {"id": a["id"], "approve": True}, {"X-Tradebot": "1"})
    assert code == 200 and r["placed"] and "liquid:BTC" in engine.state["owners"]
    code, r = call(dash + "/api/approvals", {"id": a["id"], "approve": True}, {"X-Tradebot": "1"})
    assert code >= 400                                                                     # already answered
