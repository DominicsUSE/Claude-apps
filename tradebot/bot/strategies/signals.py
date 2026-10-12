"""Candle strategies as pure functions: candles + settings -> one BarSignal (or None) per bar.

The same function drives the backtester and live trading, so what you test is exactly what runs.
Each bar's signal only uses that bar and earlier ones.
"""
from ..backtest import BarSignal
from ..indicators import atr, crossed_above, crossed_below, ema, highest, lowest, rsi, rolling_std
from ..models import Candle


def trend_signals(candles: list[Candle], p: dict) -> list[BarSignal | None]:
    """EMA crossover with a long-term trend filter, an RSI momentum check and ATR-based stops.

    Long: fast EMA crosses above slow EMA, price above the trend EMA, RSI 50-75.
    Short: the mirror image. Exit: the opposite crossover, the stop, or the target.
    """
    closes = [c.c for c in candles]
    fast, slow = ema(closes, p["fast"]), ema(closes, p["slow"])
    trend = ema(closes, p["trend_filter"]) if p.get("trend_filter") else [None] * len(closes)
    r = rsi(closes, p.get("rsi_period", 14))
    a = atr([c.h for c in candles], [c.l for c in candles], closes, p.get("atr_period", 14))
    stop_mult, rr = p.get("atr_stop", 2.0), p.get("reward_risk", 2.5)
    out: list[BarSignal | None] = []
    for i, c in enumerate(candles):
        if a[i] is None or r[i] is None:
            out.append(None)
            continue
        up, down = crossed_above(fast, slow, i), crossed_below(fast, slow, i)
        sig = BarSignal(exit_long=down, exit_short=up)
        risk = a[i] * stop_mult
        trend_ok_long = trend[i] is None or c.c > trend[i]
        trend_ok_short = trend[i] is None or c.c < trend[i]
        if p.get("trend_filter") and trend[i] is None:
            trend_ok_long = trend_ok_short = False
        if up and trend_ok_long and 50 <= r[i] <= 75:
            sig.enter, sig.stop, sig.take_profit = "long", c.c - risk, c.c + risk * rr
        elif down and p.get("allow_shorts", True) and trend_ok_short and 25 <= r[i] <= 50:
            sig.enter, sig.stop, sig.take_profit = "short", c.c + risk, c.c - risk * rr
        out.append(sig if (sig.enter or sig.exit_long or sig.exit_short) else None)
    return out


def regime_bands(candles: list[Candle], p: dict):
    """The volatility-regime ("Alpha Flow" style) bands from the Bitcoin video: fast and slow EMAs
    of the typical price (high+low+close)/3, averaged into a basis, with bands of
    +- mult x smoothed standard deviation."""
    tp = [(c.h + c.l + c.c) / 3 for c in candles]
    fast, slow = ema(tp, p.get("fast", 21)), ema(tp, p.get("slow", 55))
    basis = [None if f is None or s is None else (f + s) / 2 for f, s in zip(fast, slow)]
    sd_raw = rolling_std(tp, p.get("std_period", 50))
    first = next((i for i, v in enumerate(sd_raw) if v is not None), None)
    sd = [None] * len(tp)
    if first is not None:
        smoothed = ema(sd_raw[first:], p.get("std_smooth", 10))
        sd[first:] = smoothed
    mult = p.get("mult", 1.0)
    upper = [None if b is None or s is None else b + mult * s for b, s in zip(basis, sd)]
    lower = [None if b is None or s is None else b - mult * s for b, s in zip(basis, sd)]
    return basis, upper, lower


def regime_signals(candles: list[Candle], p: dict) -> list[BarSignal | None]:
    """Bull regime starts when a candle closes above the upper band and lasts until a close below
    the lower band (bear regime). Long only: in the market during bull regimes, in cash during bear
    ones. Optional slope filter: only enter while a long moving average is rising."""
    _, upper, lower = regime_bands(candles, p)
    closes = [c.c for c in candles]
    slope_ma = ema(closes, p["slope_ma"]) if p.get("slope_ma") else None
    lookback = p.get("slope_lookback", 10)
    a = atr([c.h for c in candles], [c.l for c in candles], closes, p.get("atr_period", 14))
    regime = None
    out: list[BarSignal | None] = []
    for i, c in enumerate(candles):
        if upper[i] is None:
            out.append(None)
            continue
        flipped = None
        if regime != "bull" and c.c > upper[i]:
            regime = flipped = "bull"
        elif regime != "bear" and c.c < lower[i]:
            regime = flipped = "bear"
        if flipped == "bull":
            rising = True
            if slope_ma is not None:
                rising = i >= lookback and slope_ma[i] is not None and slope_ma[i - lookback] is not None and slope_ma[i] > slope_ma[i - lookback]
            stop = c.c - a[i] * p["atr_stop"] if p.get("atr_stop") and a[i] else None
            out.append(BarSignal(enter="long", stop=stop) if rising else None)
        elif flipped == "bear":
            out.append(BarSignal(exit_long=True))
        else:
            out.append(None)
    return out



def breakout_signals(candles: list[Candle], p: dict) -> list[BarSignal | None]:
    """Donchian channel breakout (turtle style): buy a close above the highest high of the last
    N bars, exit below the lowest low of the last M bars."""
    highs, lows = [c.h for c in candles], [c.l for c in candles]
    n, m = p.get("entry_period", 20), p.get("exit_period", 10)
    hh, ll = highest(highs, n), lowest(lows, m)
    hh_short, ll_short = lowest(lows, n), highest(highs, m)
    a = atr(highs, lows, [c.c for c in candles], p.get("atr_period", 14))
    out: list[BarSignal | None] = []
    for i, c in enumerate(candles):
        if i < 1 or hh[i - 1] is None or ll[i - 1] is None or a[i] is None:
            out.append(None)
            continue
        sig = BarSignal(exit_long=c.c < ll[i - 1], exit_short=c.c > ll_short[i - 1])
        if c.c > hh[i - 1]:
            sig.enter, sig.stop = "long", c.c - a[i] * p.get("atr_stop", 2.0)
        elif p.get("allow_shorts", False) and c.c < hh_short[i - 1]:
            sig.enter, sig.stop = "short", c.c + a[i] * p.get("atr_stop", 2.0)
        out.append(sig if (sig.enter or sig.exit_long or sig.exit_short) else None)
    return out


def mean_reversion_signals(candles: list[Candle], p: dict) -> list[BarSignal | None]:
    """RSI pullback in an uptrend: buy when RSI dips under `oversold` while price is above the
    trend EMA; sell when RSI recovers above `exit_rsi`."""
    closes = [c.c for c in candles]
    r = rsi(closes, p.get("rsi_period", 2 if p.get("fast_rsi") else 14))
    trend = ema(closes, p.get("trend_filter", 200))
    a = atr([c.h for c in candles], [c.l for c in candles], closes, p.get("atr_period", 14))
    out: list[BarSignal | None] = []
    for i, c in enumerate(candles):
        if r[i] is None or trend[i] is None or a[i] is None:
            out.append(None)
            continue
        sig = BarSignal(exit_long=r[i] > p.get("exit_rsi", 60))
        if r[i] < p.get("oversold", 30) and c.c > trend[i]:
            sig.enter, sig.stop = "long", c.c - a[i] * p.get("atr_stop", 3.0)
            sig.exit_long = False
        out.append(sig if (sig.enter or sig.exit_long) else None)
    return out


def supertrend_signals(candles: list[Candle], p: dict) -> list[BarSignal | None]:
    """Supertrend: an ATR band that flips sides when price closes through it. Green = long, red = exit
    (or short when shorts are allowed). The band itself is the stop."""
    highs, lows, closes = [c.h for c in candles], [c.l for c in candles], [c.c for c in candles]
    a = atr(highs, lows, closes, p.get("atr_period", 10))
    mult = p.get("multiplier", 3.0)
    up_band = dn_band = None
    direction = 0
    out: list[BarSignal | None] = []
    for i, c in enumerate(candles):
        if a[i] is None:
            out.append(None)
            continue
        mid = (c.h + c.l) / 2
        basic_up, basic_dn = mid - mult * a[i], mid + mult * a[i]
        prev_close = closes[i - 1] if i else c.c
        up_band = basic_up if up_band is None or prev_close < up_band else max(basic_up, up_band)
        dn_band = basic_dn if dn_band is None or prev_close > dn_band else min(basic_dn, dn_band)
        new_dir = 1 if c.c > dn_band else -1 if c.c < up_band else direction
        sig = None
        if new_dir != direction and direction != 0:
            if new_dir == 1:
                sig = BarSignal(enter="long", exit_short=True, stop=up_band)
            else:
                sig = BarSignal(enter="short" if p.get("allow_shorts") else None, exit_long=True, stop=dn_band)
        direction = new_dir
        out.append(sig)
    return out


def macd_signals(candles: list[Candle], p: dict) -> list[BarSignal | None]:
    """MACD line crossing its signal line, only in the direction of the trend EMA."""
    closes = [c.c for c in candles]
    fast, slow = ema(closes, p.get("fast", 12)), ema(closes, p.get("slow", 26))
    macd = [None if f is None or s is None else f - s for f, s in zip(fast, slow)]
    first = next((i for i, v in enumerate(macd) if v is not None), None)
    signal = [None] * len(closes)
    if first is not None:
        signal[first:] = ema([v for v in macd[first:]], p.get("signal", 9))
    trend = ema(closes, p.get("trend_filter", 200)) if p.get("trend_filter") else [None] * len(closes)
    a = atr([c.h for c in candles], [c.l for c in candles], closes, 14)
    out: list[BarSignal | None] = []
    for i, c in enumerate(candles):
        if a[i] is None or signal[i] is None:
            out.append(None)
            continue
        up, down = crossed_above(macd, signal, i), crossed_below(macd, signal, i)
        sig = BarSignal(exit_long=down, exit_short=up)
        if up and (trend[i] is None or c.c > trend[i]):
            sig.enter, sig.stop = "long", c.c - a[i] * p.get("atr_stop", 2.5)
        elif down and p.get("allow_shorts") and (trend[i] is None or c.c < trend[i]):
            sig.enter, sig.stop = "short", c.c + a[i] * p.get("atr_stop", 2.5)
        out.append(sig if (sig.enter or sig.exit_long or sig.exit_short) else None)
    return out


def heikin_ashi(candles: list[Candle]) -> list[Candle]:
    out: list[Candle] = []
    for i, c in enumerate(candles):
        close = (c.o + c.h + c.l + c.c) / 4
        open_ = (c.o + c.c) / 2 if i == 0 else (out[-1].o + out[-1].c) / 2
        out.append(Candle(c.t, open_, max(c.h, open_, close), min(c.l, open_, close), close, c.v))
    return out


def heikin_ashi_signals(candles: list[Candle], p: dict) -> list[BarSignal | None]:
    """Heikin Ashi trend: after `confirm` green candles with no lower wick, go long; exit on the
    first red candle. Trades happen at real prices, Heikin Ashi only decides when."""
    ha = heikin_ashi(candles)
    n = p.get("confirm", 2)
    a = atr([c.h for c in candles], [c.l for c in candles], [c.c for c in candles], 14)
    out: list[BarSignal | None] = []
    for i in range(len(candles)):
        if i < n or a[i] is None:
            out.append(None)
            continue
        strong_green = all(ha[j].c > ha[j].o and abs(ha[j].l - min(ha[j].o, ha[j].c)) < 1e-12 for j in range(i - n + 1, i + 1))
        red = ha[i].c < ha[i].o
        if strong_green and not (ha[i - n].c > ha[i - n].o):
            out.append(BarSignal(enter="long", stop=candles[i].c - a[i] * p.get("atr_stop", 3.0)))
        elif red:
            out.append(BarSignal(exit_long=True))
        else:
            out.append(None)
    return out


CANDLE_STRATEGIES = {
    "trend": trend_signals,
    "btc_regime": regime_signals,
    "breakout": breakout_signals,
    "mean_reversion": mean_reversion_signals,
    "supertrend": supertrend_signals,
    "macd": macd_signals,
    "heikin_ashi": heikin_ashi_signals,
}

# What the walk-forward optimiser is allowed to try. Kept small on purpose: every extra knob is
# another way to fit noise ("degrees of freedom", as the walk-forward video puts it).
PARAM_GRIDS = {
    "trend": {"fast": [10, 20, 30], "slow": [50, 100], "atr_stop": [1.5, 2.5]},
    "btc_regime": {"fast": [14, 21, 34], "slow": [55, 89], "mult": [0.5, 1.0, 1.5]},
    "breakout": {"entry_period": [20, 55], "exit_period": [10, 20], "atr_stop": [2.0, 3.0]},
    "mean_reversion": {"oversold": [20, 30], "exit_rsi": [55, 70]},
    "supertrend": {"atr_period": [10, 14], "multiplier": [2.0, 3.0, 4.0]},
    "macd": {"fast": [8, 12], "slow": [21, 26], "atr_stop": [2.0, 3.0]},
    "heikin_ashi": {"confirm": [1, 2, 3], "atr_stop": [2.0, 3.0]},
}

DEFAULT_PARAMS = {
    "trend": {"fast": 20, "slow": 50, "trend_filter": 200, "rsi_period": 14, "atr_period": 14, "atr_stop": 2.0,
              "reward_risk": 2.5, "allow_shorts": True},
    "btc_regime": {"fast": 21, "slow": 55, "std_period": 50, "std_smooth": 10, "mult": 1.0, "atr_period": 14},
    "breakout": {"entry_period": 20, "exit_period": 10, "atr_period": 14, "atr_stop": 2.0, "allow_shorts": False},
    "mean_reversion": {"rsi_period": 14, "oversold": 30, "exit_rsi": 60, "trend_filter": 200, "atr_stop": 3.0},
    "supertrend": {"atr_period": 10, "multiplier": 3.0, "allow_shorts": False},
    "macd": {"fast": 12, "slow": 26, "signal": 9, "trend_filter": 200, "atr_stop": 2.5, "allow_shorts": False},
    "heikin_ashi": {"confirm": 2, "atr_stop": 3.0},
}

LABELS = {
    "trend": "EMA trend (20/50 + 200 filter)",
    "btc_regime": "Volatility regime (Bitcoin video)",
    "breakout": "Donchian breakout",
    "mean_reversion": "RSI pullback in an uptrend",
    "supertrend": "Supertrend",
    "macd": "MACD crossover",
    "heikin_ashi": "Heikin Ashi trend",
}
