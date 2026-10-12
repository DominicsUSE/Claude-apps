import time

import pytest

from bot.brokers.paper import PaperBroker
from bot.models import Position, Signal
from bot.risk import RiskManager

MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"


# ---------- risk ----------

def test_risk_sizing_from_stop(cfg):
    rm = RiskManager(cfg["risk"])
    sig = Signal("liquid", "BTC", "buy", "t", stop_pct=10)
    d = rm.evaluate(sig, 100.0, 1000.0, [], {}, {}, True)
    # 1% of $1000 = $10 at risk; 10% stop -> $100 position, which is also the max_position_usd cap
    assert d.ok and d.size_usd == pytest.approx(100) and d.stop_price == pytest.approx(90)
    d = rm.evaluate(Signal("liquid", "BTC", "buy", "t", stop_pct=20), 100.0, 1000.0, [], {}, {}, True)
    assert d.size_usd == pytest.approx(50)


def test_risk_rejections(cfg):
    rm = RiskManager(cfg["risk"])
    ok = lambda sig, **kw: rm.evaluate(sig, 100.0, kw.get("eq", 1000.0), kw.get("pos", []), kw.get("counts", {}), kw.get("cd", {}), kw.get("short", True))
    assert not ok(Signal("fomo", MINT, "sell", "t"), short=False).ok
    assert "wrong side" in ok(Signal("liquid", "BTC", "buy", "t", stop_price=105)).reason
    assert "away" in ok(Signal("liquid", "BTC", "buy", "t", stop_pct=50)).reason
    assert "cooling" in ok(Signal("liquid", "BTC", "buy", "t"), cd={"liquid:BTC": time.time() + 600}).reason
    full = [Position("liquid", f"S{i}", "long", 1, 10, 10) for i in range(5)]
    assert "positions open" in ok(Signal("liquid", "BTC", "buy", "t"), pos=full).reason
    assert "minimum" in ok(Signal("liquid", "BTC", "buy", "t"), eq=20.0).reason
    cfg["risk"]["blocked_symbols"] = ["BTC"]
    assert "blocked" in ok(Signal("liquid", "BTC", "buy", "t")).reason


def test_account_limits(cfg):
    rm = RiskManager(cfg["risk"])
    assert rm.check_account(1000, 1000, 1000) == ""
    assert "Daily loss" in rm.check_account(940, 1000, 1000)
    assert "drawdown" in rm.check_account(790, 790, 1000)


def test_leverage_capped(cfg):
    rm = RiskManager(cfg["risk"])
    d = rm.evaluate(Signal("liquid", "BTC", "buy", "t", leverage=50), 100, 1000, [], {}, {}, True, max_leverage_market=40)
    assert d.leverage == cfg["risk"]["max_leverage"]


# ---------- paper broker ----------

def test_paper_spot_and_perp():
    prices = {("fomo", MINT): 1.0, ("liquid", "BTC"): 100.0}
    b = PaperBroker(lambda v, s: prices[(v, s)], 1000, fee_pct=0.1, slippage_pct=0)
    f = b.open("fomo", MINT, "long", 100)
    assert f.ok and b.cash() == pytest.approx(1000 - 100 - 0.1)
    assert not b.open("fomo", MINT, "short", 10).ok
    prices[("fomo", MINT)] = 2.0
    assert b.equity() == pytest.approx(899.9 + 200)
    f = b.close("fomo", MINT, 0.5)
    assert f.ok and f.realized_pnl == pytest.approx(50 - 0.1)
    b.open("liquid", "BTC", "short", 200, leverage=2)
    prices[("liquid", "BTC")] = 90.0
    pos = {p.symbol: p for p in b.positions()}
    assert pos["BTC"].unrealized_pnl == pytest.approx(20)
    f = b.close("liquid", "BTC")
    assert f.realized_pnl == pytest.approx(20 - 0.18)
    assert "BTC" not in {p.symbol for p in b.positions()}
    assert PaperBroker(lambda v, s: 1.0, **{"starting_balance": 1, "state": b.to_state()}).cash() == pytest.approx(b.cash())


def test_paper_margin_check():
    b = PaperBroker(lambda v, s: 100.0, 100, fee_pct=0, slippage_pct=0)
    assert b.open("liquid", "BTC", "long", 300, leverage=3).ok
    assert not b.open("liquid", "ETH", "long", 50, leverage=1).ok  # no free margin left


# ---------- engine ----------

def prime(engine):
    engine.tick()
    return engine


def test_engine_opens_and_stops_out(engine):
    prime(engine)
    engine.execute(Signal("liquid", "BTC", "buy", "manual", label="BTC", size_usd=50, stop_pct=5, take_profit_pct=20))
    assert "liquid:BTC" in engine.state["owners"]
    o = engine.state["owners"]["liquid:BTC"]
    assert o["stop"] == pytest.approx(57000) and o["take_profit"] == pytest.approx(72000)
    engine.hl.prices["BTC"] = 56000.0
    engine.tick()
    assert "liquid:BTC" not in engine.state["owners"]
    trades = engine.trades()
    assert trades[0]["action"] == "close" and float(trades[0]["pnl_usd"]) < 0
    assert engine.state["cooldowns"]["liquid:BTC"] > time.time()
    # cooldown blocks re-entry
    engine.execute(Signal("liquid", "BTC", "buy", "manual", size_usd=50))
    assert "liquid:BTC" not in engine.state["owners"]


def test_engine_take_profit_ladder_and_breakeven(engine):
    prime(engine)
    engine.execute(Signal("fomo", MINT, "buy", "fomo_momentum", label="MEME", size_usd=40, stop_pct=15,
                          take_profit_ladder=[[30, 0.5], [80, 0.25]], trailing_stop_pct=20))
    o = engine.state["owners"][f"fomo:{MINT}"]
    engine.sol.price_map[MINT] = 0.0135  # +35%
    engine.tick()
    assert o["ladder_done"] == 1 and o["stop"] == pytest.approx(o["entry_price"])
    pos = [p for p in engine.last_positions if p.symbol == MINT][0]
    assert pos.qty == pytest.approx(o["orig_qty"] * 0.5)
    engine.sol.price_map[MINT] = 0.02   # +100%: second step sells 25% of the original
    engine.tick()
    pos = [p for p in engine.last_positions if p.symbol == MINT][0]
    assert pos.qty == pytest.approx(o["orig_qty"] * 0.25)
    engine.sol.price_map[MINT] = 0.0155  # -22.5% from the 0.02 peak -> trailing stop
    engine.tick()
    assert f"fomo:{MINT}" not in engine.state["owners"]
    assert float(engine.trades()[0]["pnl_usd"]) > 0


def test_engine_time_limit(engine):
    prime(engine)
    engine.execute(Signal("liquid", "ETH", "buy", "congress", size_usd=30, max_hold_hours=1))
    engine.state["owners"]["liquid:ETH"]["opened_at"] -= 7200
    engine.tick()
    assert "liquid:ETH" not in engine.state["owners"]
    assert "time limit" in engine.trades()[0]["reason"]


def test_engine_daily_loss_halts_new_trades(engine):
    prime(engine)
    engine.state["day"]["start_equity"] = 2000
    engine.tick()
    assert "Daily loss" in engine.state["halted"]
    engine.execute(Signal("liquid", "BTC", "buy", "manual", size_usd=20))
    assert "liquid:BTC" not in engine.state["owners"]
    engine.resume()
    assert not engine.state["halted"]


def test_engine_pair_opens_together_and_closes_together(engine):
    prime(engine)
    legs = [Signal("liquid", "BTC", "buy", "eth_btc_pair", size_usd=50, stop_pct=20, group="pair:BTC/ETH"),
            Signal("liquid", "ETH", "sell", "eth_btc_pair", size_usd=50, stop_pct=20, group="pair:BTC/ETH")]
    engine.execute_group(legs)
    owners = engine.state["owners"]
    assert owners["liquid:BTC"]["side"] == "long" and owners["liquid:ETH"]["side"] == "short"
    sizes = {p.symbol: p.notional for p in engine.last_positions}
    assert sizes["BTC"] == pytest.approx(sizes["ETH"], rel=1e-6)
    engine.execute(Signal("liquid", "BTC", "close", "eth_btc_pair", group="pair:BTC/ETH"))
    assert "liquid:BTC" not in owners and "liquid:ETH" not in owners


def test_engine_pair_unwinds_if_a_leg_fails(engine):
    prime(engine)
    legs = [Signal("liquid", "BTC", "buy", "eth_btc_pair", size_usd=50, stop_pct=20, group="g"),
            Signal("liquid", "DOGE", "sell", "eth_btc_pair", size_usd=50, stop_pct=20, group="g")]
    engine.execute_group(legs)  # DOGE has no market -> nothing opens
    assert not engine.state.get("owners")


def test_engine_flip_and_duplicate(engine):
    prime(engine)
    engine.execute(Signal("liquid", "SOL", "buy", "trend", size_usd=30))
    engine.execute(Signal("liquid", "SOL", "buy", "trend", size_usd=30))
    assert len([p for p in engine.last_positions if p.symbol == "SOL"]) == 1
    engine.execute(Signal("liquid", "SOL", "sell", "trend", size_usd=30))
    assert engine.state["owners"]["liquid:SOL"]["side"] == "short"


def test_engine_pause_and_errors(engine):
    prime(engine)
    engine.pause()
    engine.execute(Signal("liquid", "BTC", "buy", "manual", size_usd=20))
    assert not engine.state.get("owners")
    engine.resume()
    for _ in range(engine.cfg["risk"]["max_consecutive_errors"]):
        engine._order_failed("boom")
    assert engine.state["paused"]


def test_engine_state_survives_restart(engine, cfg, tmp_path):
    from bot.engine import Engine
    from .conftest import FakeHL, FakeSol
    prime(engine)
    engine.execute(Signal("liquid", "BTC", "buy", "manual", size_usd=50))
    engine.save_state()
    again = Engine(cfg, data_dir=tmp_path, hl=FakeHL(), sol=FakeSol())
    again.tick()
    assert "liquid:BTC" in again.state["owners"]
    assert any(p.symbol == "BTC" for p in again.last_positions)


def test_status_and_stats(engine):
    prime(engine)
    engine.execute(Signal("liquid", "BTC", "buy", "manual", size_usd=50))
    engine.execute(Signal("liquid", "BTC", "close", "manual"))
    s = engine.status()
    assert s["mode"] == "paper" and s["connections"]["liquid"]["connected"]
    st = engine.stats()
    assert st["all"]["trades"] == 1 and "manual" in st["by_strategy"]


def test_strategies_do_not_touch_each_others_positions(engine):
    prime(engine)
    engine.execute(Signal("liquid", "BTC", "buy", "btc_regime", size_usd=50))
    engine.execute(Signal("liquid", "BTC", "sell", "trend", size_usd=50))
    assert engine.state["owners"]["liquid:BTC"]["side"] == "long"
    engine.execute(Signal("liquid", "BTC", "close", "trend"))
    assert "liquid:BTC" in engine.state["owners"]
    engine.execute(Signal("liquid", "BTC", "close", "tradingview"))   # your own alerts may
    assert "liquid:BTC" not in engine.state["owners"]


def test_already_closed_is_not_an_error(engine):
    prime(engine)
    engine.execute(Signal("liquid", "ETH", "buy", "trend", size_usd=50))
    engine.brokers["liquid"].book.clear()          # the exchange stop closed it
    engine.execute(Signal("liquid", "ETH", "close", "trend"))
    assert engine.state.get("errors", 0) == 0 and "liquid:ETH" not in engine.state["owners"]


def test_fresh_position_survives_a_lagging_wallet(engine):
    prime(engine)
    engine.execute(Signal("liquid", "SOL", "buy", "trend", size_usd=40))
    engine.brokers["liquid"].book.clear()          # wallet has not caught up yet
    engine.tick()
    assert "liquid:SOL" in engine.state["owners"]
    engine.state["owners"]["liquid:SOL"]["opened_at"] -= 600
    engine.tick()
    assert "liquid:SOL" not in engine.state["owners"]
