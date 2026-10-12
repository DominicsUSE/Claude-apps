"""Reading a memecoin chart: what a short-term trader looks at, as code.

From the "Every Trading Strategy Explained" video, the parts that work on fast 1m-15m memecoin
charts:
  * market structure: higher highs + higher lows = uptrend; a break of the last higher low
    ("change of character") = the trend is over
  * dynamic support: VWAP and the 9/21 EMAs; pullbacks into them, or into the 0.382-0.618
    Fibonacci zone of the last leg, are where buyers step in
  * breakouts: a tight consolidation, then a close above it on a volume spike
  * candles: hammer / bullish engulfing at support = buyers; shooting star / bearish engulfing
    at the highs = sellers
  * divergence: price makes a higher high but RSI a lower high = momentum fading
  * volume: moves without volume fail; volume drying up = interest is gone

Everything at bar t only uses bars 0..t. Swing highs/lows need k bars on their right to be
confirmed, so they only count from bar i+k onwards (no look-ahead).
"""
from bisect import bisect_right
from dataclasses import dataclass, field

from .indicators import atr, ema, rsi
from .models import Candle

SETUPS = ("breakout", "pullback", "vwap_reclaim")

MEME_DEFAULTS = {
    "interval": "5m",
    "swing_k": 2,                 # bars each side to confirm a swing high/low
    "setups": list(SETUPS),       # which entry setups are allowed
    "range_bars": 12,             # consolidation length before a breakout (1 hour on 5m)
    "range_max_pct": 15.0,        # consolidation must be tighter than this
    "rvol_min": 2.0,              # breakout candle volume vs the 20-candle average
    "pullback_rvol_min": 0.8,
    "reclaim_rvol_min": 1.5,
    "max_ext_vwap_pct": 30.0,     # never buy more than this far above VWAP (chasing)
    "rsi_max": 80.0,
    "max_stop_pct": 15.0,         # skip trades whose logical stop is further away than this
    "min_stop_pct": 3.0,          # stops tighter than this get shaken out by noise: widen to this
    "tp_r": [[1.0, 0.5], [2.0, 0.25]],  # sell 50% at +1R, 25% at +2R (R = entry minus stop)
    "trail": "swing",             # after +1R, trail the stop under each new higher low ("swing") or the 9 EMA ("ema9")
    "exit_on_ema21": True,        # in profit and a candle closes below the 21 EMA: momentum gone, sell
    "exit_on_reversal_candle": True,  # shooting star / bearish engulfing on volume at the highs: sell
    "exit_on_divergence": True,
    "dead_volume_bars": 6,        # volume under 40% of normal for this many candles and no profit: sell
    "max_hold_bars": 48,          # 4 hours on 5m candles
    "cost_pct": 1.0,              # fees + slippage per side on memecoins (Jupiter + price impact)
}


@dataclass
class Features:
    candles: list[Candle]
    o: list[float]
    h: list[float]
    l: list[float]
    c: list[float]
    v: list[float]
    vwap: list[float]
    ema9: list
    ema21: list
    rsi: list
    atr: list
    rvol: list
    k: int
    swing_highs: list = field(default_factory=list)   # (confirmed_at, index, price)
    swing_lows: list = field(default_factory=list)
    _sh_conf: list = field(default_factory=list)
    _sl_conf: list = field(default_factory=list)


def vwap_bars(candles: list[Candle]) -> int:
    """How many candles make 24 hours (the rolling VWAP window, as Liquid uses)."""
    if len(candles) < 2:
        return 288
    step = max(candles[1].t - candles[0].t, 1)
    return max(int(86_400_000 / step), 1)


def invert(candles: list[Candle]) -> list[Candle]:
    """The chart upside down (price -> 1/price): a short setup on the real chart is a long setup here.
    Lets every buy rule double as a short-selling rule on Liquid perps."""
    return [Candle(c.t, 1 / c.o, 1 / c.l, 1 / c.h, 1 / c.c, c.v) for c in candles if c.o > 0 and c.l > 0]


def features(candles: list[Candle], k: int = 2) -> Features:
    o = [x.o for x in candles]
    h = [x.h for x in candles]
    lo = [x.l for x in candles]
    c = [x.c for x in candles]
    v = [x.v for x in candles]
    # Rolling 24-hour VWAP, so it reads the same however much history was loaded
    n = vwap_bars(candles)
    vwap, pv, vol = [], 0.0, 0.0
    for i in range(len(c)):
        pv += (h[i] + lo[i] + c[i]) / 3 * v[i]
        vol += v[i]
        if i >= n:
            j = i - n
            pv -= (h[j] + lo[j] + c[j]) / 3 * v[j]
            vol -= v[j]
        vwap.append(pv / vol if vol > 1e-12 else c[i])
    # relative volume: this candle vs the average of the 20 before it
    rvol = [None] * len(v)
    run = 0.0
    for i in range(len(v)):
        if i >= 20:
            avg = run / 20
            rvol[i] = v[i] / avg if avg > 0 else None
            run -= v[i - 20]
        run += v[i]
    f = Features(candles, o, h, lo, c, v, vwap, ema(c, 9), ema(c, 21), rsi(c, 14), atr(h, lo, c, 14), rvol, k)
    for i in range(k, len(c) - k):
        if h[i] > max(h[i - k:i]) and h[i] >= max(h[i + 1:i + k + 1]):
            f.swing_highs.append((i + k, i, h[i]))
        if lo[i] < min(lo[i - k:i]) and lo[i] <= min(lo[i + 1:i + k + 1]):
            f.swing_lows.append((i + k, i, lo[i]))
    f._sh_conf = [s[0] for s in f.swing_highs]
    f._sl_conf = [s[0] for s in f.swing_lows]
    return f


def swings(f: Features, t: int, kind: str, n: int = 2) -> list[tuple[int, float]]:
    """The last n swing highs ("high") or lows ("low") already confirmed at bar t: [(index, price)]."""
    lst, conf = (f.swing_highs, f._sh_conf) if kind == "high" else (f.swing_lows, f._sl_conf)
    j = bisect_right(conf, t)
    return [(i, p) for _, i, p in lst[max(0, j - n):j]]


def structure(f: Features, t: int) -> str:
    hs, ls = swings(f, t, "high"), swings(f, t, "low")
    if len(hs) < 2 or len(ls) < 2:
        return "unclear"
    hh, hl = hs[1][1] > hs[0][1], ls[1][1] > ls[0][1]
    if hh and hl:
        return "up"
    if not hh and not hl:
        return "down"
    return "range"


def patterns(f: Features, t: int) -> list[str]:
    o, h, lo, c = f.o[t], f.h[t], f.l[t], f.c[t]
    rng = h - lo
    if rng <= 0:
        return []
    body = abs(c - o)
    upper, lower = h - max(o, c), min(o, c) - lo
    out = []
    if lower >= 2 * body and upper <= max(body, rng * 0.1):
        out.append("hammer")
    if upper >= 2 * body and lower <= max(body, rng * 0.1):
        out.append("shooting star")
    if body <= 0.1 * rng:
        out.append("doji")
    if t > 0:
        po, pc = f.o[t - 1], f.c[t - 1]
        if c > o and pc < po and c >= po and o <= pc:
            out.append("bullish engulfing")
        if c < o and pc > po and o >= pc and c <= po:
            out.append("bearish engulfing")
    if f.atr[t] and body >= 1.5 * f.atr[t]:
        out.append("big green candle" if c > o else "big red candle")
    return out


def bearish_divergence(f: Features, t: int, recent: int = 10) -> bool:
    hs = swings(f, t, "high")
    if len(hs) < 2:
        return False
    (i1, p1), (i2, p2) = hs
    r1, r2 = f.rsi[i1], f.rsi[i2]
    return t - i2 <= recent and p2 > p1 and r1 is not None and r2 is not None and r2 < r1 - 3


def fib_zone(f: Features, t: int) -> tuple[float, float, float] | None:
    """(0.382, 0.5, 0.618) retracement prices of the leg from the last swing low to the high since."""
    ls = swings(f, t, "low", 1)
    if not ls:
        return None
    a, low = ls[0]
    high = max(f.h[a:t + 1])
    if high <= low:
        return None
    d = high - low
    return high - d * 0.382, high - d * 0.5, high - d * 0.618


def consolidation(f: Features, t: int, bars: int) -> tuple[float, float] | None:
    """(range high, range low) of the `bars` candles before t, or None if there is not enough history."""
    if t - bars < 0:
        return None
    return max(f.h[t - bars:t]), min(f.l[t - bars:t])


def ext_vwap_pct(f: Features, t: int) -> float:
    return (f.c[t] / f.vwap[t] - 1) * 100 if f.vwap[t] else 0.0


def read(f: Features, t: int | None = None) -> dict:
    """A plain-English read of the chart at bar t (default: the last closed candle)."""
    t = len(f.c) - 1 if t is None else t
    s = structure(f, t)
    ext = ext_vwap_pct(f, t)
    notes = []
    notes.append({"up": "Uptrend: higher highs and higher lows.", "down": "Downtrend: lower highs and lower lows.",
                  "range": "Choppy: no clean trend.", "unclear": "Too few swings to call a trend yet."}[s])
    notes.append(f"Price is {abs(ext):.1f}% {'above' if ext >= 0 else 'below'} VWAP.")
    if f.ema9[t] and f.ema21[t]:
        notes.append("9 EMA above 21 EMA (short-term momentum up)." if f.ema9[t] > f.ema21[t] else "9 EMA below 21 EMA (momentum down).")
    if f.rvol[t]:
        notes.append(f"Volume {f.rvol[t]:.1f}x the recent average." + (" Strong interest." if f.rvol[t] >= 2 else " Quiet." if f.rvol[t] < 0.5 else ""))
    if f.rsi[t] is not None:
        notes.append(f"RSI {f.rsi[t]:.0f}" + (" (overbought)." if f.rsi[t] >= 75 else " (oversold)." if f.rsi[t] <= 30 else "."))
    p = patterns(f, t)
    if p:
        notes.append("Last candle: " + ", ".join(p) + ".")
    if bearish_divergence(f, t):
        notes.append("Bearish RSI divergence: new high in price, weaker RSI. Momentum is fading.")
    hs, ls = swings(f, t, "high", 1), swings(f, t, "low", 1)
    levels = {"resistance": hs[0][1] if hs else None, "support": ls[0][1] if ls else None}
    if levels["support"]:
        notes.append(f"Last swing low {levels['support']:.6g}, last swing high {levels['resistance']:.6g}." if levels["resistance"] else "")
    return {"t": f.candles[t].t, "structure": s, "ext_vwap_pct": round(ext, 2), "rsi": f.rsi[t], "rvol": f.rvol[t],
            "patterns": p, "divergence": bearish_divergence(f, t), "levels": levels, "fib": fib_zone(f, t),
            "text": " ".join(n for n in notes if n)}


# ---------------- entries ----------------

def _stop(entry: float, logical: float, p: dict) -> float | None:
    """Clamp the chart stop: too tight gets widened to min_stop_pct, too wide means skip."""
    dist = (entry - logical) / entry * 100
    if dist > p["max_stop_pct"]:
        return None
    if dist < p["min_stop_pct"]:
        return entry * (1 - p["min_stop_pct"] / 100)
    return logical


def entry_signal(f: Features, t: int, p: dict) -> dict | None:
    """Checks the buy setups on closed candle t. Returns {"setup", "stop", "reason"} or None."""
    if t < 30 or f.atr[t] is None or f.rsi[t] is None or f.rvol[t] is None:
        return None
    c, o = f.c[t], f.o[t]
    ext = ext_vwap_pct(f, t)
    # things a good trader never buys
    if ext > p["max_ext_vwap_pct"] or f.rsi[t] > p["rsi_max"] or bearish_divergence(f, t):
        return None
    rng = f.h[t] - f.l[t]
    if rng > 0 and (f.h[t] - max(o, c)) / rng > 0.5:
        return None  # long upper wick: sellers rejected the move
    s = structure(f, t)
    pats = patterns(f, t)
    allowed = p["setups"]

    if "breakout" in allowed:
        box = consolidation(f, t, p["range_bars"])
        if box:
            hi, lo = box
            height = (hi - lo) / lo * 100 if lo > 0 else 999
            if height <= p["range_max_pct"] and c > hi and f.c[t - 1] <= hi and f.rvol[t] >= p["rvol_min"] and c > f.vwap[t] and c > o:
                stop = _stop(c, lo * 0.995, p)
                if stop:
                    return {"setup": "breakout", "stop": stop,
                            "reason": f"Breakout: closed above a {p['range_bars']}-candle range ({height:.0f}% tall) on {f.rvol[t]:.1f}x volume, above VWAP."}

    if "pullback" in allowed and s == "up" and c > f.vwap[t] and f.ema21[t]:
        zone_lo = min(x for x in (f.ema21[t], f.vwap[t]) if x)
        fib = fib_zone(f, t)
        touched = f.l[t] <= f.ema21[t] * 1.01 or f.l[t] <= f.vwap[t] * 1.015
        if fib:
            touched = touched or (fib[2] <= f.l[t] <= fib[0])
        bullish = ("hammer" in pats or "bullish engulfing" in pats or (c > o and f.c[t - 1] < f.o[t - 1])) and c > f.ema9[t]
        if touched and bullish and f.rvol[t] >= p["pullback_rvol_min"] and 40 <= f.rsi[t] <= 70:
            ls = swings(f, t, "low", 1)
            logical = min(f.l[t], f.l[t - 1], ls[0][1] if ls else f.l[t]) * 0.995
            stop = _stop(c, min(logical, zone_lo * 0.99), p) or _stop(c, logical, p)
            if stop:
                where = "the 0.382-0.618 Fibonacci zone" if fib and fib[2] <= f.l[t] <= fib[0] else "the 21 EMA / VWAP"
                kind = next((x for x in pats if x in ("hammer", "bullish engulfing")), "a green reversal candle")
                return {"setup": "pullback", "stop": stop,
                        "reason": f"Pullback in an uptrend (higher highs and lows) into {where}, bounced with {kind}."}

    if "vwap_reclaim" in allowed and s != "down":
        below_before = all(f.c[i] < f.vwap[i] for i in range(t - 3, t))
        if below_before and c > f.vwap[t] and c > o and f.rvol[t] >= p["reclaim_rvol_min"]:
            stop = _stop(c, min(f.l[t], f.l[t - 1]) * 0.995, p)
            if stop:
                return {"setup": "vwap_reclaim", "stop": stop,
                        "reason": f"Reclaimed VWAP after trading under it, on {f.rvol[t]:.1f}x volume."}
    return None


# ---------------- exits ----------------

def exit_signal(f: Features, t: int, pos: dict, p: dict) -> tuple[str, str, float | None]:
    """For an open long, on closed candle t. pos: entry, stop, init_stop, bars, peak.
    Returns (action, reason, new_stop): action "sell" or "" (hold); new_stop is a tighter stop or None."""
    entry, init_stop = pos["entry"], pos["init_stop"]
    r = entry - init_stop
    c = f.c[t]
    gained_r = (pos.get("peak", c) - entry) / r if r > 0 else 0
    now_r = (c - entry) / r if r > 0 else 0
    pats = patterns(f, t)
    if pos.get("bars", 0) >= p["max_hold_bars"]:
        return "sell", "time limit: the move did not come", None
    ls = swings(f, t, "low", 1)
    # change of character: the last higher low broke
    if ls and ls[0][0] > pos.get("entry_i", -1) and c < ls[0][1]:
        return "sell", "structure broke: closed below the last higher low", None
    if p["exit_on_ema21"] and gained_r >= 1 and f.ema21[t] and c < f.ema21[t]:
        return "sell", "momentum lost: closed below the 21 EMA after a +1R move", None
    if p["exit_on_reversal_candle"] and now_r >= 1 and ("shooting star" in pats or "bearish engulfing" in pats) and (f.rvol[t] or 0) >= 1.5:
        return "sell", f"sellers showed up at the highs ({', '.join(x for x in pats if x in ('shooting star', 'bearish engulfing'))} on volume)", None
    if p["exit_on_divergence"] and now_r >= 0.5 and bearish_divergence(f, t, recent=3):
        return "sell", "bearish RSI divergence at the high", None
    n = p["dead_volume_bars"]
    if n and t >= n and now_r < 0.5 and all((f.rvol[i] or 0) < 0.4 for i in range(t - n + 1, t + 1)):
        return "sell", "volume dried up: nobody is buying any more", None
    new_stop = None
    if gained_r >= 1:
        cand = None
        if p["trail"] == "ema9" and f.ema9[t]:
            cand = f.ema9[t] * 0.99
        elif ls and ls[0][0] > pos.get("entry_i", -1):
            cand = ls[0][1] * 0.995
        if cand and cand > pos["stop"] and cand < c:
            new_stop = cand
    return "", "", new_stop


# ---------------- backtest on one token ----------------

def simulate(f: Features, p: dict, start: int = 30, end: int | None = None) -> list[dict]:
    """Trades one token's chart with the setups and exit rules above. Signal on candle t (closed)
    fills at candle t+1's open. Stops and profit targets are checked inside each candle, stop first."""
    end = len(f.c) if end is None else end
    cost = p["cost_pct"] / 100
    trades, pos = [], None
    for t in range(max(start, 1), end):
        bar = f.candles[t]
        if pos is not None:
            pos["bars"] += 1
            # stop inside the candle
            if bar.l <= pos["stop"]:
                px = min(bar.o, pos["stop"])
                pos["fills"].append((pos["left"], px, "stop" if pos["stop"] < pos["entry"] else "trailing stop"))
                pos["left"] = 0
            else:
                for j, (rr, frac) in enumerate(p["tp_r"]):
                    if j < pos["tp_done"]:
                        continue
                    target = pos["entry"] + rr * (pos["entry"] - pos["init_stop"])
                    if bar.h >= target and pos["left"] > 0:
                        part = min(frac, pos["left"])
                        pos["fills"].append((part, max(bar.o, target), f"take profit +{rr}R"))
                        pos["left"] -= part
                        pos["tp_done"] = j + 1
                        pos["stop"] = max(pos["stop"], pos["entry"])  # rest can no longer lose
            if pos["left"] > 1e-9:
                pos["peak"] = max(pos["peak"], bar.h)
                action, why, new_stop = exit_signal(f, t, pos, p)
                if action == "sell" and t + 1 < end:
                    pos["pending_exit"] = why
                elif new_stop:
                    pos["stop"] = new_stop
            if pos["left"] <= 1e-9:
                trades.append(_close(pos, f, t, cost))
                pos = None
                continue
        if pos is None and t + 1 < end:
            sig = entry_signal(f, t, p)
            if sig:
                entry = f.o[t + 1]
                if entry > sig["stop"]:
                    pos = {"setup": sig["setup"], "reason": sig["reason"], "entry_i": t + 1, "entry": entry,
                           "stop": sig["stop"], "init_stop": sig["stop"], "bars": -1, "peak": entry, "left": 1.0,
                           "tp_done": 0, "fills": [], "signal_t": t}
                    continue
        if pos is not None and pos.get("pending_exit") and t + 1 < end:
            nxt = f.candles[t + 1]
            pos["fills"].append((pos["left"], nxt.o, pos.pop("pending_exit")))
            pos["left"] = 0
            trades.append(_close(pos, f, t + 1, cost))
            pos = None
    if pos is not None:
        pos["fills"].append((pos["left"], f.c[end - 1], "end of data"))
        trades.append(_close(pos, f, end - 1, cost))
    return trades


def _close(pos: dict, f: Features, t: int, cost: float) -> dict:
    entry = pos["entry"] * (1 + cost)
    ret = sum(frac * (px * (1 - cost) / entry - 1) for frac, px, _ in pos["fills"])
    r_pct = (pos["entry"] - pos["init_stop"]) / pos["entry"]
    return {"setup": pos["setup"], "entry_t": f.candles[pos["entry_i"]].t, "exit_t": f.candles[t].t,
            "entry": pos["entry"], "stop": pos["init_stop"], "ret_pct": ret * 100,
            "r": ret / r_pct if r_pct > 0 else 0.0, "bars": max(pos["bars"], 0),
            "exit_reason": pos["fills"][-1][2], "reason": pos["reason"]}
