import pytest

from bot import backtest as bt
from bot.indicators import atr, ema, rsi, sma
from bot.models import Candle
from bot.strategies.pair import pair_signals, ratio_candles
from bot.strategies.signals import CANDLE_STRATEGIES, DEFAULT_PARAMS, PARAM_GRIDS, heikin_ashi

from .conftest import make_candles


def test_indicators_basic():
    xs = [1, 2, 3, 4, 5, 6]
    assert sma(xs, 3) == [None, None, 2, 3, 4, 5]
    e = ema(xs, 3)
    assert e[2] == 2 and e[3] == pytest.approx(3.0)
    assert rsi(list(range(1, 30)), 14)[-1] == 100.0
    assert rsi(list(range(30, 1, -1)), 14)[-1] == 0.0
    a = atr([2] * 20, [1] * 20, [1.5] * 20, 14)
    assert a[-1] == pytest.approx(1.0)


@pytest.mark.parametrize("name", list(CANDLE_STRATEGIES))
def test_no_look_ahead(name):
    """A signal for bar i must be identical whether or not later bars exist."""
    candles = make_candles(700, seed=3)
    fn, params = CANDLE_STRATEGIES[name], DEFAULT_PARAMS[name]
    full = fn(candles, params)
    for cut in (300, 450, 699):
        part = fn(candles[:cut], params)
        assert part == full[:cut], f"{name} changed its past signals when future data was added"


def test_pair_no_look_ahead():
    r = ratio_candles(make_candles(400, 30000, seed=4), make_candles(400, 2000, seed=5))
    p = {"lookback": 30, "upper_k": 2.0, "lower_k": 1.0}
    full = pair_signals(r, p)
    assert pair_signals(r[:250], p) == full[:250]


def flat(n, px=100.0):
    return [Candle(i * 86_400_000, px, px, px, px) for i in range(n)]


def test_trades_at_next_open_with_costs():
    candles = flat(10)
    candles[3] = Candle(candles[3].t, 101, 101, 101, 101)  # next open differs from signal close
    candles[4] = Candle(candles[4].t, 105, 110, 104, 108)
    sigs = [None] * 10
    sigs[2] = bt.BarSignal(enter="long")
    sigs[5] = bt.BarSignal(exit_long=True)
    r = bt.simulate(candles, sigs, costs=bt.Costs(0.1, 0.0))
    t = r["trades"][0]
    assert t.entry_i == 3 and t.entry_px == pytest.approx(101 * 1.001)
    assert t.exit_i == 6 and t.exit_px == pytest.approx(100 * 0.999)
    assert t.pnl_usd < 0


def test_stop_hit_inside_bar_and_gap():
    candles = flat(8)
    candles[4] = Candle(candles[4].t, 100, 100, 94, 96)   # trades through the 95 stop
    sigs = [None] * 8
    sigs[1] = bt.BarSignal(enter="long", stop=95, take_profit=120)
    r = bt.simulate(candles, sigs, costs=bt.Costs(0, 0))
    t = r["trades"][0]
    assert t.exit_reason == "stop" and t.exit_px == pytest.approx(95)
    candles[4] = Candle(candles[4].t, 90, 92, 89, 91)     # gaps below the stop: filled at the open
    r = bt.simulate(candles, sigs, costs=bt.Costs(0, 0))
    assert r["trades"][0].exit_px == pytest.approx(90)


def test_short_and_end_of_test_close():
    candles = [Candle(i, 100 - i, 100 - i, 100 - i, 100 - i) for i in range(10)]
    sigs = [None] * 10
    sigs[0] = bt.BarSignal(enter="short")
    r = bt.simulate(candles, sigs, costs=bt.Costs(0, 0))
    t = r["trades"][0]
    assert t.side == "short" and t.pnl_usd > 0 and t.exit_reason == "end of test"
    r2 = bt.simulate(candles, sigs, costs=bt.Costs(0, 0), allow_shorts=False)
    assert not r2["trades"]


def test_metrics_and_run():
    candles = make_candles(800, seed=2)
    out = bt.run(candles, CANDLE_STRATEGIES["btc_regime"], DEFAULT_PARAMS["btc_regime"])
    m = out["metrics"]
    for key in ("total_return_pct", "max_drawdown_pct", "sharpe", "win_rate_pct", "buy_and_hold_pct"):
        assert key in m
    assert 0 <= m["max_drawdown_pct"] <= 100
    assert len(out["curve"]) <= 402


def test_walk_forward_only_trades_unseen_windows():
    candles = make_candles(900, seed=7)
    out = bt.walk_forward(candles, CANDLE_STRATEGIES["supertrend"], DEFAULT_PARAMS["supertrend"], PARAM_GRIDS["supertrend"], 300, 120)
    assert out["verdict"] in ("ROBUST", "MODERATE", "WEAK", "FAILS OUT-OF-SAMPLE", "NOT ENOUGH TRADES")
    assert len(out["folds"]) == 5
    first_test = candles[300].t
    assert all(t["entry_t"] >= first_test for t in out["trades"])
    for f in out["folds"]:
        assert f["test_from"] > f["train_to"]


def test_walk_forward_too_short():
    assert "error" in bt.walk_forward(make_candles(100), CANDLE_STRATEGIES["trend"], DEFAULT_PARAMS["trend"], {}, 200, 50)


def test_risk_of_ruin_matches_video_examples():
    # Video 1: 55% win rate, $200 risk per trade on $10,000, ruin = -30% -> U = 15 trades, A = 0.1.
    assert bt.risk_of_ruin_simple(0.55, 2.0, 30) == pytest.approx(((1 - 0.1) / (1 + 0.1)) ** 15 * 100)
    assert bt.risk_of_ruin_simple(0.45, 2.0, 30) == 100.0
    # Video 2: a 34% win-rate trend strategy with winners ~3x losers is fine under Vince's formula.
    v = bt.risk_of_ruin_vince(0.34, 3.0, 1.0, 30)
    assert 0 < v < 5
    assert bt.risk_of_ruin_vince(0.34, 0.5, 1.0, 30) == 100.0  # negative expectancy: certain ruin
    assert bt.risk_of_ruin_vince(0.34, 3.0, 1.0, 10) > v       # a smaller ruin level is reached more often


def test_monte_carlo():
    mc = bt.monte_carlo([5, -2, 3, -1, 4, -2] * 5, runs=500)
    assert mc["return_pct"]["worst_5"] <= mc["return_pct"]["median"] <= mc["return_pct"]["best_5"]
    assert 0 <= mc["risk_of_ruin_pct"] <= 100
    assert bt.monte_carlo([])["error"]


def test_regime_and_heikin_ashi():
    up = [Candle(i, 100 + i, 101 + i, 99 + i, 100.5 + i) for i in range(200)]
    assert any(s and s.enter == "long" for s in CANDLE_STRATEGIES["btc_regime"](up, DEFAULT_PARAMS["btc_regime"]))
    ha = heikin_ashi(up)
    assert len(ha) == len(up) and all(c.h >= max(c.o, c.c) for c in ha)
