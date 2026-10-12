"""Backtesting done carefully, following the videos you sent:

* No look-ahead bias (Dr. Ernest Chan): a signal is computed from bars that have closed,
  and the trade happens at the *next* bar's open. Indicators only use past data.
* Real costs: fees and slippage on every entry and exit.
* Walk-forward testing: pick parameters on one stretch of history (in-sample), then trade
  them on the following stretch the optimiser never saw (out-of-sample), roll forward, repeat.
  Only the stitched out-of-sample result says much about the future.
* Monte Carlo: reshuffle the trades thousands of times to see how bad the drawdowns could get.
* Risk of ruin: the chance of losing a given share of the account (simple and Ralph Vince formulas).
"""
import itertools
import math
import random
from dataclasses import asdict, dataclass

from .models import Candle


@dataclass
class BarSignal:
    enter: str | None = None        # "long" or "short"
    exit_long: bool = False
    exit_short: bool = False
    stop: float | None = None       # price
    take_profit: float | None = None


@dataclass
class Trade:
    side: str
    entry_i: int
    exit_i: int
    entry_t: int
    exit_t: int
    entry_px: float
    exit_px: float
    size_usd: float
    pnl_usd: float
    ret_pct: float           # on the position, after costs
    exit_reason: str


@dataclass
class Costs:
    fee_pct: float = 0.045       # Hyperliquid taker fee
    slippage_pct: float = 0.05

    @property
    def per_side(self) -> float:
        return (self.fee_pct + self.slippage_pct) / 100


def simulate(candles: list[Candle], signals: list[BarSignal | None], start: int = 0, end: int | None = None,
             capital: float = 10_000.0, position_pct: float = 100.0, leverage: float = 1.0,
             costs: Costs = Costs(), allow_shorts: bool = True) -> dict:
    """Trades the signals bar by bar. Signal on bar i (known at its close) fills at bar i+1's open.
    Stops and targets are checked inside each later bar; if both could have hit in one bar,
    the stop is assumed to have hit first (the pessimistic choice)."""
    end = len(candles) if end is None else end
    equity = capital
    pos = None
    trades: list[Trade] = []
    curve = []
    pending: BarSignal | None = None

    def close_at(i: int, px: float, reason: str):
        nonlocal equity, pos
        side, entry_px, size = pos["side"], pos["entry_px"], pos["size"]
        if side == "long":
            exit_px = px * (1 - costs.per_side)
            ret = exit_px / entry_px - 1
        else:
            exit_px = px * (1 + costs.per_side)
            ret = 1 - exit_px / entry_px
        pnl = size * ret
        equity += pnl
        trades.append(Trade(side, pos["i"], i, candles[pos["i"]].t, candles[i].t, entry_px, exit_px, size, pnl,
                            ret * 100, reason))
        pos = None

    for i in range(start, end):
        bar = candles[i]
        # 1) act on what yesterday's close told us, at today's open
        if pending is not None:
            sig = pending
            pending = None
            if pos and ((pos["side"] == "long" and (sig.exit_long or sig.enter == "short")) or
                        (pos["side"] == "short" and (sig.exit_short or sig.enter == "long"))):
                close_at(i, bar.o, "signal")
            if pos is None and sig.enter and (sig.enter == "long" or allow_shorts) and equity > 0:
                size = equity * position_pct / 100 * leverage
                entry_px = bar.o * (1 + costs.per_side) if sig.enter == "long" else bar.o * (1 - costs.per_side)
                pos = {"side": sig.enter, "entry_px": entry_px, "size": size, "i": i,
                       "stop": sig.stop, "tp": sig.take_profit}
        # 2) stops and targets during the bar
        if pos:
            stop, tp = pos["stop"], pos["tp"]
            if pos["side"] == "long":
                if stop and bar.l <= stop:
                    close_at(i, min(bar.o, stop), "stop")
                elif tp and bar.h >= tp:
                    close_at(i, max(bar.o, tp), "target")
            else:
                if stop and bar.h >= stop:
                    close_at(i, max(bar.o, stop), "stop")
                elif tp and bar.l <= tp:
                    close_at(i, min(bar.o, tp), "target")
        # 3) read the signal at the close (used next bar)
        if i < end - 1:
            pending = signals[i]
        mark = equity
        if pos:
            move = bar.c / pos["entry_px"] - 1 if pos["side"] == "long" else 1 - bar.c / pos["entry_px"]
            mark = equity + pos["size"] * move
        curve.append((bar.t, mark))
    if pos:
        close_at(end - 1, candles[end - 1].c, "end of test")
        curve[-1] = (candles[end - 1].t, equity)
    return {"trades": trades, "curve": curve, "capital": capital, "final": equity}


def periods_per_year(candles: list[Candle]) -> float:
    if len(candles) < 2:
        return 365.0
    step_ms = (candles[-1].t - candles[0].t) / (len(candles) - 1)
    return 365 * 86_400_000 / step_ms if step_ms > 0 else 365.0


def metrics(result: dict, candles: list[Candle], start: int = 0, end: int | None = None) -> dict:
    end = len(candles) if end is None else end
    trades: list[Trade] = result["trades"]
    curve = [v for _, v in result["curve"]]
    capital, final = result["capital"], result["final"]
    total_ret = (final / capital - 1) * 100 if capital else 0
    years = max((candles[end - 1].t - candles[start].t) / (365 * 86_400_000), 1e-9) if end > start else 1e-9
    cagr = ((final / capital) ** (1 / years) - 1) * 100 if final > 0 and years > 0.05 else total_ret
    peak, max_dd = -1e18, 0.0
    for v in curve:
        peak = max(peak, v)
        if peak > 0:
            max_dd = max(max_dd, (peak - v) / peak * 100)
    rets = [curve[i] / curve[i - 1] - 1 for i in range(1, len(curve)) if curve[i - 1] > 0]
    ppy = periods_per_year(candles[start:end])
    sharpe = 0.0
    if len(rets) > 2:
        mean = sum(rets) / len(rets)
        sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
        sharpe = mean / sd * math.sqrt(ppy) if sd > 0 else 0.0
    wins = [t for t in trades if t.pnl_usd > 0]
    losses = [t for t in trades if t.pnl_usd <= 0]
    gross_win = sum(t.pnl_usd for t in wins)
    gross_loss = -sum(t.pnl_usd for t in losses)
    bh = (candles[end - 1].c / candles[start].o - 1) * 100 if end > start else 0
    return {
        "total_return_pct": round(total_ret, 2),
        "cagr_pct": round(cagr, 2),
        "max_drawdown_pct": round(max_dd, 2),
        "sharpe": round(sharpe, 2),
        "trades": len(trades),
        "win_rate_pct": round(len(wins) / len(trades) * 100, 1) if trades else 0.0,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else (99.0 if gross_win > 0 else 0.0),
        "avg_win_pct": round(sum(t.ret_pct for t in wins) / len(wins), 2) if wins else 0.0,
        "avg_loss_pct": round(sum(t.ret_pct for t in losses) / len(losses), 2) if losses else 0.0,
        "buy_and_hold_pct": round(bh, 2),
        "beats_buy_and_hold": total_ret > bh,
        "years": round(years, 2),
    }


def run(candles: list[Candle], signal_fn, params: dict, **sim_kw) -> dict:
    signals = signal_fn(candles, params)
    result = simulate(candles, signals, **sim_kw)
    return {"metrics": metrics(result, candles), "trades": [asdict(t) for t in result["trades"]],
            "curve": _thin(result["curve"]), "params": params}


def _thin(curve: list, points: int = 400) -> list:
    if len(curve) <= points:
        return curve
    step = len(curve) / points
    return [curve[int(i * step)] for i in range(points)] + [curve[-1]]


def _score(m: dict, objective: str) -> float:
    if m["trades"] < 3:
        return -1e9  # too few trades to mean anything
    if objective == "return":
        return m["total_return_pct"]
    if objective == "profit_factor":
        return min(m["profit_factor"], 10)
    if objective == "return_over_drawdown":
        return m["total_return_pct"] / max(m["max_drawdown_pct"], 1)
    return m["sharpe"]


def grid(param_grid: dict) -> list[dict]:
    keys = list(param_grid)
    return [dict(zip(keys, combo)) for combo in itertools.product(*(param_grid[k] for k in keys))]


def walk_forward(candles: list[Candle], signal_fn, base_params: dict, param_grid: dict, train_bars: int,
                 test_bars: int, objective: str = "sharpe", anchored: bool = False, **sim_kw) -> dict:
    """Rolling walk-forward optimisation. For each window: try every parameter combination on the
    training bars, keep the best, then trade it on the next test_bars that the optimiser never saw."""
    combos = grid(param_grid) or [{}]
    folds, oos_trades, oos_curve = [], [], []
    capital = sim_kw.pop("capital", 10_000.0)
    equity = capital
    start = 0
    while start + train_bars + test_bars <= len(candles):
        train_lo = 0 if anchored else start
        train_hi = start + train_bars
        test_hi = train_hi + test_bars
        best, best_score, best_m = None, -1e18, None
        for combo in combos:
            p = {**base_params, **combo}
            sig = signal_fn(candles[:train_hi], p)        # only data up to the end of training
            r = simulate(candles, sig, train_lo, train_hi, capital=capital, **sim_kw)
            m = metrics(r, candles, train_lo, train_hi)
            s = _score(m, objective)
            if s > best_score:
                best, best_score, best_m = p, s, m
        # Out-of-sample: indicators may look back into training bars (that is the past, not the
        # future), but trades only happen inside the test window.
        sig = signal_fn(candles[:test_hi], best)
        r = simulate(candles, sig, train_hi, test_hi, capital=equity, **sim_kw)
        m = metrics(r, candles, train_hi, test_hi)
        equity = r["final"]
        oos_trades.extend(r["trades"])
        oos_curve.extend(r["curve"])
        folds.append({"train_from": candles[train_lo].t, "train_to": candles[train_hi - 1].t,
                      "test_from": candles[train_hi].t, "test_to": candles[test_hi - 1].t,
                      "params": {k: best[k] for k in param_grid}, "in_sample": best_m, "out_of_sample": m})
        start += test_bars
    if not folds:
        return {"error": f"Need at least {train_bars + test_bars} bars, have {len(candles)}"}
    oos_result = {"trades": oos_trades, "curve": oos_curve, "capital": capital, "final": equity}
    oos_start = train_bars
    oos_end = train_bars + test_bars * len(folds)
    summary = metrics(oos_result, candles, oos_start, oos_end)
    is_cagr = sum(f["in_sample"]["cagr_pct"] for f in folds) / len(folds)
    efficiency = summary["cagr_pct"] / is_cagr if is_cagr > 0 else 0.0
    profitable = sum(1 for f in folds if f["out_of_sample"]["total_return_pct"] > 0)
    if summary["trades"] < 10:
        verdict = "NOT ENOUGH TRADES"
    elif efficiency >= 0.6 and summary["total_return_pct"] > 0 and profitable / len(folds) >= 0.6:
        verdict = "ROBUST"
    elif efficiency >= 0.3 and summary["total_return_pct"] > 0:
        verdict = "MODERATE"
    elif summary["total_return_pct"] > 0:
        verdict = "WEAK"
    else:
        verdict = "FAILS OUT-OF-SAMPLE"
    return {"folds": folds, "out_of_sample": summary, "walk_forward_efficiency": round(efficiency, 2),
            "profitable_folds": f"{profitable}/{len(folds)}", "verdict": verdict,
            "trades": [asdict(t) for t in oos_trades], "curve": _thin(oos_curve)}


def monte_carlo(trade_returns_pct: list[float], position_pct: float = 100.0, runs: int = 2000,
                ruin_drawdown_pct: float = 30.0, seed: int | None = 7) -> dict:
    """Bootstraps the trade sequence. Each trade's % result is applied to the share of equity it used."""
    if not trade_returns_pct:
        return {"error": "no trades"}
    rng = random.Random(seed)
    n = len(trade_returns_pct)
    finals, dds, ruined = [], [], 0
    for _ in range(runs):
        eq, peak, dd = 1.0, 1.0, 0.0
        hit = False
        for _ in range(n):
            r = trade_returns_pct[rng.randrange(n)] / 100 * position_pct / 100
            eq *= 1 + r
            if eq <= 0:
                eq, dd, hit = 0.0, 100.0, True
                break
            peak = max(peak, eq)
            dd = max(dd, (peak - eq) / peak * 100)
            if eq <= 1 - ruin_drawdown_pct / 100:
                hit = True
        finals.append((eq - 1) * 100)
        dds.append(dd)
        ruined += hit
    finals.sort()
    dds.sort()

    def pct(xs, q):
        return round(xs[min(int(q * len(xs)), len(xs) - 1)], 2)

    return {"runs": runs, "trades_per_run": n,
            "return_pct": {"worst_5": pct(finals, 0.05), "median": pct(finals, 0.5), "best_5": pct(finals, 0.95)},
            "max_drawdown_pct": {"median": pct(dds, 0.5), "worst_5": pct(dds, 0.95), "worst_1": pct(dds, 0.99)},
            "chance_of_losing_money_pct": round(sum(1 for f in finals if f < 0) / runs * 100, 1),
            "risk_of_ruin_pct": round(ruined / runs * 100, 2), "ruin_level_pct": ruin_drawdown_pct}


def risk_of_ruin_simple(win_rate: float, risk_per_trade_pct: float, ruin_pct: float) -> float:
    """((1 - A) / (1 + A)) ** U, where A = win% - loss% and U = losses in a row until ruin.
    Only valid when wins and losses are the same size."""
    a = win_rate - (1 - win_rate)
    if a <= 0:
        return 100.0
    u = ruin_pct / risk_per_trade_pct
    return ((1 - a) / (1 + a)) ** u * 100


def risk_of_ruin_vince(win_rate: float, avg_win_pct: float, avg_loss_pct: float, ruin_pct: float) -> float:
    """Ralph Vince, Portfolio Management Formulas: works for any win rate and unequal wins/losses.
    avg_win_pct / avg_loss_pct are average winning / losing trade as % of the account (loss as a positive number)."""
    aw, al, g = avg_win_pct / 100, abs(avg_loss_pct) / 100, ruin_pct / 100
    z = win_rate * aw - (1 - win_rate) * al                       # average result per trade
    a = math.sqrt(win_rate * aw ** 2 + (1 - win_rate) * al ** 2)   # spread of results
    if a == 0:
        return 0.0
    p = 0.5 * (1 + z / a)
    if p <= 0.5:
        return 100.0
    return min(((1 - p) / p) ** (g / a) * 100, 100.0)
