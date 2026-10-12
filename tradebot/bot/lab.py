"""Backtest lab: what the dashboard's Backtest tab and `python run.py backtest ...` call."""
from . import backtest as bt
from .data.history import history
from .strategies.pair import pair_costs, pair_signals, ratio_candles
from .strategies.signals import CANDLE_STRATEGIES, DEFAULT_PARAMS, LABELS, PARAM_GRIDS

PAIR = "eth_btc_pair"


def _costs(opts: dict) -> bt.Costs:
    return bt.Costs(float(opts.get("fee_pct", 0.045)), float(opts.get("slippage_pct", 0.05)))


def _sim_kw(opts: dict) -> dict:
    return {"capital": float(opts.get("capital", 10_000)), "position_pct": float(opts.get("position_pct", 100)),
            "leverage": float(opts.get("leverage", 1)), "costs": _costs(opts)}


def load(opts: dict, hl=None):
    """-> (candles, signal_fn, params, sim_kw). For the pair strategy the candles are the ratio."""
    strategy = opts.get("strategy", "trend")
    interval, days, source = opts.get("interval", "1d"), int(opts.get("days", 730)), opts.get("source", "liquid")
    params = dict(opts.get("params") or {})
    kw = _sim_kw(opts)
    if strategy == PAIR:
        a = history(opts.get("symbol_a", "BTC"), interval, days, source, hl)
        b = history(opts.get("symbol_b", "ETH"), interval, days, source, hl)
        candles = ratio_candles(a, b)
        params = {"lookback": 30, "upper_k": 2.0, "lower_k": 1.0, **params}
        kw["costs"] = pair_costs(kw["costs"])
        kw["allow_shorts"] = bool(params.get("both_sides"))
        return candles, pair_signals, params, kw
    if strategy not in CANDLE_STRATEGIES:
        raise ValueError(f"unknown strategy {strategy}")
    candles = history(opts.get("symbol", "BTC"), interval, days, source, hl)
    params = {**DEFAULT_PARAMS[strategy], **params}
    kw["allow_shorts"] = bool(params.get("allow_shorts", False))
    return candles, CANDLE_STRATEGIES[strategy], params, kw


def run_backtest(opts: dict, hl=None) -> dict:
    candles, fn, params, kw = load(opts, hl)
    if len(candles) < 60:
        return {"error": f"Only {len(candles)} candles of history; pick a longer period or a bigger interval"}
    out = bt.run(candles, fn, params, **kw)
    out["monte_carlo"] = bt.monte_carlo([t["ret_pct"] for t in out["trades"]], kw["position_pct"] * kw["leverage"],
                                        ruin_drawdown_pct=float(opts.get("ruin_pct", 30)))
    out["candles"] = len(candles)
    out["buy_and_hold_curve"] = _bh_curve(candles, kw["capital"])
    return out


def run_walk_forward(opts: dict, hl=None) -> dict:
    candles, fn, params, kw = load(opts, hl)
    strategy = opts.get("strategy", "trend")
    grid = opts.get("grid") or (PARAM_GRIDS.get(strategy) if strategy != PAIR else
                                {"lookback": [20, 30, 45], "upper_k": [1.5, 2.0], "lower_k": [1.0, 1.5]})
    n = len(candles)
    train = int(opts.get("train_bars") or max(int(n * 0.4), 120))
    test = int(opts.get("test_bars") or max(int(n * 0.15), 40))
    out = bt.walk_forward(candles, fn, params, grid, train, test, opts.get("objective", "sharpe"),
                          bool(opts.get("anchored", False)), **kw)
    if "error" not in out:
        out["monte_carlo"] = bt.monte_carlo([t["ret_pct"] for t in out["trades"]], kw["position_pct"] * kw["leverage"],
                                            ruin_drawdown_pct=float(opts.get("ruin_pct", 30)))
        out["candles"] = n
    return out


def compare(opts: dict, hl=None) -> dict:
    """Every candle strategy on the same history, next to buy and hold."""
    candles, _, _, kw = load({**opts, "strategy": "trend", "params": {}}, hl)
    rows = []
    for name, fn in CANDLE_STRATEGIES.items():
        params = DEFAULT_PARAMS[name]
        m = bt.run(candles, fn, params, **{**kw, "allow_shorts": bool(params.get("allow_shorts", False))})["metrics"]
        rows.append({"strategy": name, "label": LABELS.get(name, name), **m})
    rows.sort(key=lambda r: r["sharpe"], reverse=True)
    return {"rows": rows, "candles": len(candles)}


def _bh_curve(candles, capital):
    first = candles[0].o
    return bt._thin([(c.t, capital * c.c / first) for c in candles])


def ruin_from_stats(win_rate_pct: float, avg_win_usd: float, avg_loss_usd: float, equity: float, ruin_pct: float,
                    risk_per_trade_pct: float) -> dict:
    wr = win_rate_pct / 100
    # The simple formula needs a win rate above 50% and equal-sized wins and losses.
    out = {"simple_pct": round(bt.risk_of_ruin_simple(wr, risk_per_trade_pct, ruin_pct), 3) if wr > 0.5 else None}
    if equity > 0 and avg_loss_usd:
        out["vince_pct"] = round(bt.risk_of_ruin_vince(wr, avg_win_usd / equity * 100, abs(avg_loss_usd) / equity * 100, ruin_pct), 3)
    return out


def strategies_list() -> list[dict]:
    rows = [{"id": k, "label": LABELS.get(k, k), "grid": PARAM_GRIDS.get(k, {}), "params": DEFAULT_PARAMS.get(k, {})}
            for k in CANDLE_STRATEGIES]
    rows.append({"id": PAIR, "label": "BTC/ETH pair (pair-trading video)",
                 "grid": {"lookback": [20, 30, 45], "upper_k": [1.5, 2.0], "lower_k": [1.0, 1.5]},
                 "params": {"lookback": 30, "upper_k": 2.0, "lower_k": 1.0}})
    return rows

