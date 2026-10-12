"""Ask before trading: the bot proposes, you approve on the dashboard."""
import pytest

from bot.models import Signal


@pytest.fixture
def asking(engine):
    engine.cfg["approvals"]["ask"] = "always"
    engine.tick()
    return engine


def btc(**kw):
    return Signal("liquid", "BTC", "buy", "trend", label="BTC", size_usd=50, stop_pct=5, reason="EMA cross", **kw)


def test_automatic_trade_waits_and_opens_when_approved(asking):
    asking.execute(btc(warning="Unproven: training says loses on unseen charts."))
    assert not asking.last_positions and "liquid:BTC" not in asking.state.get("owners", {})
    [a] = asking.status()["approvals"]
    assert a["legs"][0]["size_usd"] == pytest.approx(50) and a["legs"][0]["stop"] == pytest.approx(57000)
    assert a["warning"].startswith("Unproven") and a["expires_in"] > 0 and asking.status()["asks_approval"]
    r = asking.answer(a["id"], True)
    assert r["placed"] and "approved by you" in asking.state["owners"]["liquid:BTC"]["reason"]
    assert not asking.pending
    with pytest.raises(ValueError):
        asking.answer(a["id"], True)          # answering twice does nothing


def test_skip_and_price_moved(asking):
    asking.execute(btc())
    pid = next(iter(asking.pending))
    assert asking.answer(pid, False) == {"ok": True, "placed": False}
    assert not asking.last_positions
    asking.execute(btc())
    pid = next(iter(asking.pending))
    asking.hl.prices["BTC"] = 62000.0     # +3.3%, over the 2% limit
    r = asking.answer(pid, True)
    assert not r["placed"] and "moved" in r["error"] and not asking.last_positions


def test_proposals_expire_and_newer_replace_older(asking):
    asking.execute(btc())
    asking.execute(btc())
    assert len(asking.pending) == 1        # the newer signal replaced the older one
    next(iter(asking.pending.values()))["expires"] = 0
    asking.tick()
    assert not asking.pending


def test_your_own_trades_and_exits_never_wait(asking):
    asking.execute(Signal("liquid", "ETH", "buy", "manual", label="ETH", size_usd=40, stop_pct=5))
    assert "liquid:ETH" in asking.state["owners"] and not asking.pending
    asking.execute(btc())
    asking.answer(next(iter(asking.pending)), True)
    asking.execute(Signal("liquid", "BTC", "close", "trend", label="BTC"))
    assert "liquid:BTC" not in asking.state["owners"]   # the strategy's exit went straight through
    asking.execute(btc())
    assert asking.pending
    asking.hl.prices["ETH"] = 2800.0                     # ETH's stop (5% under 3000) is hit while BTC waits
    asking.tick()
    assert "liquid:ETH" not in asking.state["owners"] and asking.pending


def test_pair_is_proposed_as_one(asking):
    legs = [Signal("liquid", "BTC", "buy", "eth_btc_pair", label="BTC", size_usd=50, stop_pct=20, group="pair"),
            Signal("liquid", "ETH", "sell", "eth_btc_pair", label="ETH", size_usd=50, stop_pct=20, group="pair")]
    asking.execute_group(legs)
    [a] = asking.status()["approvals"]
    assert len(a["legs"]) == 2 and not asking.last_positions
    assert asking.answer(a["id"], True)["placed"]
    assert {o["side"] for o in asking.state["owners"].values()} == {"long", "short"}


def test_pause_clears_proposals(asking):
    asking.execute(btc())
    asking.pause()
    assert not asking.pending


def test_practice_mode_does_not_ask_by_default(engine):
    engine.tick()
    engine.execute(btc())                   # default "live": practice mode trades on its own
    assert "liquid:BTC" in engine.state["owners"] and not engine.pending


def test_meme_scalper_proposes_unproven_setups_only_when_you_approve(cfg):
    from bot.strategies.base import Context
    from bot.strategies.meme import MemeScalper, unproven_warning
    cfg.update(mode="live", live_trading_acknowledged=True)
    m = MemeScalper(cfg["strategies"]["meme_scalper"])
    ctx = Context(cfg, None, None, [], {}, 0, ("fomo",))
    learned = {"verdict": "LOSES ON UNSEEN CHARTS", "test": {"trades": 34, "avg_pct": -0.66}}
    assert m.live_blocked(ctx, "FOMO", {"learned": learned}) == ""          # asks first, so it may propose
    assert "34 trades" in unproven_warning(learned) and "-0.66%" in unproven_warning(learned)
    assert unproven_warning({"verdict": "WORKS ON UNSEEN CHARTS"}) == ""
    cfg["approvals"]["ask"] = "off"
    assert "paused" in m.live_blocked(ctx, "FOMO", {"learned": learned})   # no approvals: stays blocked
