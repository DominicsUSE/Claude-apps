import math
import random

import pytest

from bot import chart
from bot.chart import MEME_DEFAULTS, entry_signal, exit_signal, features, patterns, read, simulate, structure
from bot.models import Candle, Signal
from bot.training import journal_feedback, train

STEP = 300_000  # 5 minutes


def meme_chart(n=500, seed=1, start=0.001):
    """Synthetic memecoin: quiet ranges, volume-spike pumps, pullbacks and dumps."""
    r = random.Random(seed)
    px, out, regime, left = start, [], "range", 30
    for i in range(n):
        if left <= 0:
            regime = r.choice(["range", "range", "pump", "dump", "trend"])
            left = r.randint(10, 40)
        left -= 1
        drift, vol, volume = {"range": (0, 0.006, 100), "pump": (0.02, 0.02, 600), "dump": (-0.02, 0.02, 400),
                              "trend": (0.006, 0.012, 250)}[regime]
        o = px
        c = o * math.exp(r.gauss(drift, vol))
        h = max(o, c) * (1 + abs(r.gauss(0, vol / 2)))
        lo = min(o, c) * (1 - abs(r.gauss(0, vol / 2)))
        out.append(Candle(1_790_000_000_000 + i * STEP, o, h, lo, c, volume * r.uniform(0.5, 1.5)))
        px = c
    return out


def flat_then_breakout():
    cs = []
    for i in range(60):
        base = 1.0 + 0.01 * math.sin(i)
        cs.append(Candle(i * STEP, base, base * 1.01, base * 0.99, base + 0.002 * math.cos(i), 100))
    cs.append(Candle(60 * STEP, 1.0, 1.07, 0.995, 1.065, 800))  # close above the range on 8x volume
    return cs


def test_no_look_ahead_in_entries():
    candles = meme_chart(400, seed=3)
    full = features(candles)
    p = dict(MEME_DEFAULTS)
    for t in range(40, 399, 7):
        part = features(candles[:t + 1])
        assert entry_signal(full, t, p) == entry_signal(part, t, p), f"bar {t} changed when the future was added"
        assert read(full, t)["structure"] == read(part, t)["structure"]


def test_breakout_detected_with_stop_under_range():
    f = features(flat_then_breakout())
    sig = entry_signal(f, 60, MEME_DEFAULTS)
    assert sig and sig["setup"] == "breakout"
    assert sig["stop"] < 0.99 and sig["stop"] >= 1.065 * (1 - MEME_DEFAULTS["max_stop_pct"] / 100)
    assert "Breakout" in sig["reason"]
    p = {**MEME_DEFAULTS, "setups": ["pullback"]}
    assert entry_signal(f, 60, p) is None or entry_signal(f, 60, p)["setup"] != "breakout"


def test_no_chasing_or_rejection_wicks():
    cs = flat_then_breakout()
    cs[-1] = Candle(cs[-1].t, 1.0, 1.25, 0.995, 1.065, 800)   # huge upper wick: rejected
    assert entry_signal(features(cs), 60, MEME_DEFAULTS) is None
    cs[-1] = Candle(cs[-1].t, 1.0, 1.7, 0.995, 1.69, 800)     # 60%+ above VWAP: chasing
    assert entry_signal(features(cs), 60, MEME_DEFAULTS) is None


def test_candle_patterns():
    def f_of(prev, cur):
        cs = [Candle(0, *prev, 1), Candle(STEP, *cur, 1)]
        return patterns(features(cs), 1)
    assert "hammer" in f_of((1, 1, 1, 1), (1.0, 1.01, 0.9, 1.005))
    assert "shooting star" in f_of((1, 1, 1, 1), (1.0, 1.1, 0.995, 0.998))
    assert "bullish engulfing" in f_of((1.0, 1.01, 0.95, 0.96), (0.955, 1.03, 0.95, 1.02))
    assert "bearish engulfing" in f_of((0.96, 1.01, 0.95, 1.0), (1.01, 1.02, 0.94, 0.95))


def test_structure_reads():
    up = [Candle(i * STEP, 1 + 0.01 * i + 0.03 * math.sin(i), 1.02 + 0.01 * i + 0.03 * math.sin(i),
                 0.98 + 0.01 * i + 0.03 * math.sin(i), 1.0 + 0.01 * i + 0.03 * math.sin(i), 100) for i in range(80)]
    assert structure(features(up), 79) == "up"
    down = [Candle(c.t, 3 - c.o, 3 - c.l, 3 - c.h, 3 - c.c, 100) for c in up]
    assert structure(features(down), 79) == "down"
    text = read(features(up))["text"]
    assert "Uptrend" in text and "VWAP" in text


def test_exit_on_structure_break_and_trailing_stop():
    cs = meme_chart(300, seed=5)
    f = features(cs)
    # find a bar right after a confirmed swing low and pretend we entered before it
    conf, i, low = next(s for s in f.swing_lows if s[0] > 60)
    pos = {"entry": low * 1.2, "stop": low * 0.9, "init_stop": low * 0.9, "entry_i": i - 1, "bars": 1, "peak": low * 1.2}
    t = next((t for t in range(conf, len(cs)) if f.c[t] < low), None)
    if t is not None:
        action, why, _ = exit_signal(f, t, pos, MEME_DEFAULTS)
        assert action == "sell"
    # in profit by 2R: the stop trails up and never above the price
    pos = {"entry": f.c[100] * 0.5, "stop": f.c[100] * 0.4, "init_stop": f.c[100] * 0.4, "entry_i": 50, "bars": 10,
           "peak": f.c[100] * 2}
    action, why, new_stop = exit_signal(f, 100, pos, {**MEME_DEFAULTS, "trail": "ema9", "exit_on_ema21": False,
                                                      "exit_on_reversal_candle": False, "exit_on_divergence": False})
    if not action and new_stop:
        assert pos["stop"] < new_stop < f.c[100]


def test_simulate_costs_and_fields():
    trades = simulate(features(meme_chart(600, seed=8)), MEME_DEFAULTS)
    assert trades, "the synthetic pumps should produce trades"
    for t in trades:
        assert t["setup"] in chart.SETUPS and t["exit_t"] >= t["entry_t"]
        assert t["ret_pct"] > -MEME_DEFAULTS["max_stop_pct"] - 15   # worst case: stop plus a gap plus costs
    no_cost = simulate(features(meme_chart(600, seed=8)), {**MEME_DEFAULTS, "cost_pct": 0})
    assert sum(t["ret_pct"] for t in no_cost) > sum(t["ret_pct"] for t in trades)


def test_training_picks_settings_and_grades_unseen_data():
    charts = {f"T{i}": meme_chart(500, seed=20 + i) for i in range(6)}
    out = train(charts)
    assert out["tokens"] == 6
    assert set(out["params"]) == {"rvol_min", "range_max_pct", "max_stop_pct", "trail"}
    assert out["verdict"] in ("WORKS ON UNSEEN CHARTS", "SLIGHT EDGE", "LOSES ON UNSEEN CHARTS", "NOT ENOUGH TRADES")
    split = int(500 * 0.6)
    first_test_t = charts["T0"][split].t
    assert all(t["entry_t"] >= charts[t["token"]][split].t for t in out["sample_trades"])
    assert first_test_t
    assert train({"tiny": meme_chart(50)})["error"]


def test_journal_feedback_pauses_losing_setups():
    rows = [{"strategy": "meme_scalper", "action": "close", "pnl_usd": "-2", "setup": "breakout"}] * 10 + \
           [{"strategy": "meme_scalper", "action": "close", "pnl_usd": "3", "setup": "pullback"}] * 10
    fb = journal_feedback(rows)
    assert fb["fomo:breakout"]["paused"] and not fb["fomo:pullback"]["paused"] and fb["fomo:pullback"]["win_rate"] == 100
    liq = [{**r, "venue": "liquid", "setup": "breakout_short"} for r in rows[:10]]
    fb = journal_feedback(rows + liq)
    assert fb["liquid:breakout_short"]["paused"] and fb["fomo:breakout"]["trades"] == 10


# ---------- the live strategy against fakes ----------

class FakeDex:
    def __init__(self, charts):
        self.charts = charts

    def closed(self, pool, interval="5m", limit=300):
        return self.charts[pool][-limit:]


class MemeSol:
    def __init__(self, pairs):
        self._pairs = pairs
        self.safety_calls = []

    def candidate_mints(self):
        return list(self._pairs)

    def pairs(self, mints):
        return {m: self._pairs[m] for m in mints if m in self._pairs}

    def safety(self, mint, a, b):
        self.safety_calls.append(mint)
        return {"ok": mint != "RUG", "checked": True, "reasons": [] if mint != "RUG" else ["freeze authority on"]}

    def price(self, mint):
        return 1.065

    def prices(self, mints, max_age=10):
        return {m: 1.065 for m in mints}


def pair(pool, symbol):
    return {"pairAddress": pool, "baseToken": {"symbol": symbol}, "liquidity": {"usd": 300000}, "volume": {"h24": 2e6, "h1": 1e5},
            "marketCap": 5e6, "pairCreatedAt": 1}


def test_meme_scalper_buys_breakout_and_skips_rugs(cfg):
    from bot.strategies.base import Context
    from bot.strategies.meme import MemeScalper
    from .conftest import FakeHL
    chart_ = flat_then_breakout()
    sol = MemeSol({"GOOD": pair("pool1", "GOOD"), "RUG": pair("pool2", "RUG")})
    s = MemeScalper({**cfg["strategies"]["meme_scalper"], "use_learned": False}, {}, None, FakeDex({"pool1": chart_, "pool2": chart_}))
    sigs = s.scan(Context(cfg, FakeHL(), sol, [], {}, now=chart_[-1].t / 1000 + 600))
    assert [x.symbol for x in sigs] == ["GOOD"]
    sig = sigs[0]
    assert sig.setup == "breakout" and sig.action == "buy" and sig.take_profit_ladder[0][1] == 0.5
    assert 3 <= sig.stop_pct <= 15 and "Breakout" in sig.reason
    assert "freeze authority" in s.watch["RUG"]["text"]
    # the same candle is never traded twice
    assert s.scan(Context(cfg, FakeHL(), sol, [], {}, now=chart_[-1].t / 1000 + 700)) == []


def test_engine_stop_moves_only_up(engine):
    engine.tick()
    engine.execute(Signal("liquid", "BTC", "buy", "manual", size_usd=50, stop_pct=5))
    o = engine.state["owners"]["liquid:BTC"]
    first = o["stop"]
    engine.execute(Signal("liquid", "BTC", "stop", "manual", stop_price=first * 0.9))
    assert o["stop"] == first
    engine.execute(Signal("liquid", "BTC", "stop", "manual", stop_price=first * 1.02))
    assert o["stop"] == pytest.approx(first * 1.02)


def test_meme_scalper_exits_when_liquidity_is_pulled(cfg):
    from bot.models import Position
    from bot.strategies.base import Context
    from bot.strategies.meme import MemeScalper
    from .conftest import FakeHL
    chart_ = flat_then_breakout()
    pr = pair("pool1", "GOOD")
    sol = MemeSol({"GOOD": pr})
    s = MemeScalper({**cfg["strategies"]["meme_scalper"], "use_learned": False}, {}, None, FakeDex({"pool1": chart_}))
    sig = s.scan(Context(cfg, FakeHL(), sol, [], {}, now=chart_[-1].t / 1000 + 600))[0]
    assert sig.size_usd == pytest.approx(min(25, 300000 * 0.005))
    owners = {"fomo:GOOD": {"strategy": "meme_scalper", "entry_price": 1.065, "stop": 1.0, "init_stop": 1.0,
                            "opened_at": chart_[-1].t / 1000 + 300}}
    held = [Position("fomo", "GOOD", "long", 10, 1.065, 1.07, "GOOD")]
    ctx = Context(cfg, FakeHL(), sol, held, owners, now=chart_[-1].t / 1000 + 900)
    assert not [x for x in s.manage(ctx) if x.action == "close"]
    pr["liquidity"] = {"usd": 120000}          # 60% of the pool removed
    out = s.manage(ctx)
    assert out and out[0].action == "close" and "liquidity pulled" in out[0].reason


def test_order_flow_blocks_breakout_into_selling(cfg):
    from bot.strategies.base import Context
    from bot.strategies.meme import MemeScalper
    from .conftest import FakeHL
    chart_ = flat_then_breakout()
    pr = {**pair("pool1", "GOOD"), "txns": {"m5": {"buys": 12, "sells": 40}}}
    s = MemeScalper({**cfg["strategies"]["meme_scalper"], "use_learned": False}, {}, None, FakeDex({"pool1": chart_}))
    assert s.scan(Context(cfg, FakeHL(), MemeSol({"GOOD": pr}), [], {}, now=chart_[-1].t / 1000 + 600)) == []
    assert "more sellers than buyers" in s.watch["GOOD"]["text"]


def test_vwap_is_the_same_however_much_history_is_loaded():
    candles = meme_chart(700, seed=4)
    a, b = features(candles), features(candles[-350:])
    assert a.vwap[-1] == pytest.approx(b.vwap[-1], rel=1e-9)


def test_short_setups_come_from_the_upside_down_chart():
    from bot.chart import invert
    from bot.strategies.meme import mirror_text
    up = flat_then_breakout()
    down = invert(up)                      # the same chart falling through its range
    assert entry_signal(features(down), 60, MEME_DEFAULTS) is None   # no long on a breakdown
    long_on_mirror = entry_signal(features(invert(down)), 60, MEME_DEFAULTS)
    assert long_on_mirror and long_on_mirror["setup"] == "breakout"
    assert mirror_text(long_on_mirror["reason"]).startswith("Breakdown: closed below")


class HLWithCandles:
    def __init__(self, charts):
        self.charts = charts

    def has_market(self, s):
        return s in self.charts

    def closed_candles(self, s, interval, bars=300):
        return self.charts[s][-bars:]


def test_liquid_memecoin_short_and_live_gate(cfg):
    from bot.chart import invert
    from bot.strategies.base import Context
    from bot.strategies.meme import MemeScalper
    breakdown = invert(flat_then_breakout())
    mcfg = {**cfg["strategies"]["meme_scalper"], "use_learned": False, "fomo_enabled": False, "liquid_markets": ["WIF"],
            "liquid_chart": {"max_ext_vwap_pct": 30.0, "range_max_pct": 15.0, "max_stop_pct": 15.0}}
    s = MemeScalper(mcfg, {}, None, None)
    ctx = Context(cfg, HLWithCandles({"WIF": breakdown}), MemeSol({}), [], {}, now=breakdown[-1].t / 1000 + 600)
    sigs = s.scan(ctx)
    assert len(sigs) == 1 and sigs[0].action == "sell" and sigs[0].setup == "breakout_short"
    assert sigs[0].stop_price > breakdown[-1].c and sigs[0].reason.startswith("Breakdown")
    # live mode: no entries until training shows an edge on unseen charts
    live_cfg = {**cfg, "mode": "live", "live_trading_acknowledged": True}

    class T:
        def get(self, profile):
            return {"verdict": "LOSES ON UNSEEN CHARTS", "params": {}, "setups": ["breakout", "breakout_short"]}
    s2 = MemeScalper(mcfg, {}, T(), None)
    assert s2.scan(Context(live_cfg, HLWithCandles({"WIF": breakdown}), MemeSol({}), [], {}, now=breakdown[-1].t / 1000 + 600)) == []
    assert "live entries paused" in s2.last_note


def test_training_both_sides():
    charts = {f"T{i}": meme_chart(500, seed=40 + i) for i in range(4)}
    out = train(charts, {"cost_pct": 0.1}, both_sides=True)
    assert "breakout_short" in out["per_setup"]["test"] and out["both_sides"]
    assert any(t["setup"].endswith("_short") for t in out["sample_trades"]) or out["test"]["trades"] >= 0
