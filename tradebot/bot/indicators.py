"""Indicators in plain Python. Each returns a list the same length as its input, with None
until there is enough history. Value i only uses data up to and including bar i, so nothing
here can leak future prices into a decision (no look-ahead bias)."""
import math
from typing import Optional

Series = list[Optional[float]]


def sma(values: list[float], period: int) -> Series:
    out: Series = [None] * len(values)
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= period:
            total -= values[i - period]
        if i >= period - 1:
            out[i] = total / period
    return out


def ema(values: list[float], period: int) -> Series:
    out: Series = [None] * len(values)
    if len(values) < period:
        return out
    k = 2 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(closes: list[float], period: int = 14) -> Series:
    """Wilder's RSI, as on TradingView."""
    out: Series = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        change = closes[i] - closes[i - 1]
        gains += max(change, 0)
        losses += max(-change, 0)
    avg_gain, avg_loss = gains / period, losses / period
    out[period] = _rsi_value(avg_gain, avg_loss)
    for i in range(period + 1, len(closes)):
        change = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0)) / period
        out[i] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    return 100 - 100 / (1 + avg_gain / avg_loss)


def true_range(highs: list[float], lows: list[float], closes: list[float]) -> list[float]:
    out = []
    for i in range(len(closes)):
        if i == 0:
            out.append(highs[0] - lows[0])
        else:
            out.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    return out


def atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> Series:
    """Wilder's average true range."""
    tr = true_range(highs, lows, closes)
    out: Series = [None] * len(tr)
    if len(tr) < period:
        return out
    prev = sum(tr[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(tr)):
        prev = (prev * (period - 1) + tr[i]) / period
        out[i] = prev
    return out


def rolling_std(values: list[float], period: int) -> Series:
    out: Series = [None] * len(values)
    for i in range(period - 1, len(values)):
        window = values[i - period + 1:i + 1]
        mean = sum(window) / period
        out[i] = math.sqrt(sum((x - mean) ** 2 for x in window) / (period - 1)) if period > 1 else 0.0
    return out



def highest(values: list[float], period: int) -> Series:
    return [max(values[i - period + 1:i + 1]) if i >= period - 1 else None for i in range(len(values))]


def lowest(values: list[float], period: int) -> Series:
    return [min(values[i - period + 1:i + 1]) if i >= period - 1 else None for i in range(len(values))]


def crossed_above(fast: Series, slow: Series, i: int) -> bool:
    if i < 1 or None in (fast[i], slow[i], fast[i - 1], slow[i - 1]):
        return False
    return fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]


def crossed_below(fast: Series, slow: Series, i: int) -> bool:
    if i < 1 or None in (fast[i], slow[i], fast[i - 1], slow[i - 1]):
        return False
    return fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]
