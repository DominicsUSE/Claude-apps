"""The TradingView tunnel, with a stand-in for cloudflared (no network)."""
import stat
import sys
import time

import pytest

from bot import tunnel


@pytest.fixture
def fake_cloudflared(tmp_path, monkeypatch):
    if sys.platform == "win32":
        pytest.skip("the stand-in is a shell script")
    exe = tmp_path / "cloudflared"
    exe.write_text("#!/bin/sh\n"
                   "echo \"2026-10-13T08:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...\"\n"
                   "echo \"2026-10-13T08:00:01Z INF |  https://quiet-river-1234.trycloudflare.com  |\"\n"
                   "exec sleep 30\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(tunnel.shutil, "which", lambda name: None)
    return tmp_path


def wait_for(cond, seconds=5):
    end = time.time() + seconds
    while time.time() < end and not cond():
        time.sleep(0.05)
    return cond()


def test_tunnel_finds_cloudflared_and_reads_the_address(fake_cloudflared):
    t = tunnel.Tunnel()
    assert t.start(8788, [fake_cloudflared])
    try:
        assert wait_for(lambda: t.url)
        assert t.status() == {"running": True, "url": "https://quiet-river-1234.trycloudflare.com", "error": "",
                              "install": tunnel.INSTALL_HINT}
    finally:
        t.stop()
    assert wait_for(lambda: not t.status()["running"]) and "stopped" in t.error


def test_missing_cloudflared_explains_how_to_install(tmp_path, monkeypatch):
    monkeypatch.setattr(tunnel.shutil, "which", lambda name: None)
    monkeypatch.setattr(tunnel.sys, "platform", "linux")
    t = tunnel.Tunnel()
    assert not t.start(8788, [tmp_path]) and "not installed" in t.error


def test_tunnel_only_when_alerts_are_on_and_protected(cfg, monkeypatch):
    monkeypatch.delenv("TV_WEBHOOK_SECRET", raising=False)
    assert not tunnel.wanted(cfg)                      # no password: never expose the alert port
    monkeypatch.setenv("TV_WEBHOOK_SECRET", "pw")
    assert tunnel.wanted(cfg)
    cfg["webhook"]["public_url"] = "https://my.example.com/webhook"
    assert not tunnel.wanted(cfg)                      # you run your own address
    cfg["webhook"]["public_url"] = ""
    cfg["strategies"]["tradingview"]["enabled"] = False
    assert not tunnel.wanted(cfg)


def test_dashboard_shows_the_webhook_address(engine, monkeypatch):
    monkeypatch.setenv("TV_WEBHOOK_SECRET", "pw")
    st = engine.status()["tradingview"]
    assert st["webhook_url"] == "" and st["secret_set"]

    class Running:
        def status(self):
            return {"running": True, "url": "https://quiet-river-1234.trycloudflare.com", "error": "", "install": ""}
    engine.tunnel = Running()
    assert engine.status()["tradingview"]["webhook_url"] == "https://quiet-river-1234.trycloudflare.com/webhook"
    engine.cfg["webhook"]["public_url"] = "https://my.example.com/webhook"
    assert engine.status()["tradingview"]["webhook_url"] == "https://my.example.com/webhook"
