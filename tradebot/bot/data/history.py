"""Price history for backtests.

Hyperliquid (Liquid) is the default and matches what the bot trades, but its markets only
go back to 2023. For long Bitcoin/Ethereum tests across several market cycles (like the
Bitcoin video), Coinbase history goes back to 2015.
"""
import time
from datetime import datetime, timezone

from .. import http
from ..models import Candle
from .hyperliquid import INTERVAL_MS, HyperliquidData

COINBASE = "https://api.exchange.coinbase.com/products/{pid}/candles"
COINBASE_GRAN = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400}


def coinbase(symbol: str, interval: str, days: int) -> list[Candle]:
    if interval not in COINBASE_GRAN:
        raise ValueError(f"Coinbase has no {interval} candles; use one of {', '.join(COINBASE_GRAN)}")
    gran = COINBASE_GRAN[interval]
    pid = symbol.upper() if "-" in symbol else f"{symbol.upper()}-USD"
    end = int(time.time()) // gran * gran
    start = end - days * 86400
    out: dict[int, Candle] = {}
    cursor = start
    while cursor < end:
        page_end = min(end, cursor + gran * 300)
        rows = http.get(COINBASE.format(pid=pid), params={
            "granularity": gran,
            "start": datetime.fromtimestamp(cursor, timezone.utc).isoformat(),
            "end": datetime.fromtimestamp(page_end, timezone.utc).isoformat()}) or []
        for t, low, high, open_, close, vol in rows:
            out[int(t) * 1000] = Candle(int(t) * 1000, float(open_), float(high), float(low), float(close), float(vol))
        cursor = page_end
    now_ms = int(time.time() * 1000)
    return [out[t] for t in sorted(out) if t + gran * 1000 <= now_ms]


def history(symbol: str, interval: str, days: int, source: str = "liquid", hl: HyperliquidData | None = None) -> list[Candle]:
    if source == "coinbase":
        return coinbase(symbol, interval, days)
    hl = hl or HyperliquidData()
    bars = int(days * 86_400_000 / INTERVAL_MS[interval])
    now = int(time.time() * 1000)
    return [c for c in hl.candles(symbol, interval, bars, now) if c.t + INTERVAL_MS[interval] <= now]
