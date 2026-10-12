"""Intraday candles for any Solana token pool, from GeckoTerminal (free, no key).

DexScreener tells us which pool a token trades in ("pairAddress"); GeckoTerminal gives that
pool's 1m / 5m / 15m / 1h candles. The free API allows roughly 30 calls a minute, so results
are cached and only refetched once a new candle has closed.
"""
import json
import time
from pathlib import Path

from .. import http
from ..models import Candle

GT = "https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/{tf}"
FRAMES = {"1m": ("minute", 1, 60), "5m": ("minute", 5, 300), "15m": ("minute", 15, 900), "1h": ("hour", 1, 3600),
          "4h": ("hour", 4, 14400)}
http.MIN_INTERVAL.setdefault("api.geckoterminal.com", 2.2)


def step_seconds(interval: str) -> int:
    return FRAMES[interval][2]


class DexCandles:
    def __init__(self, cache_dir: Path | None = None):
        self._mem: dict[tuple, tuple[float, list[Candle]]] = {}
        self.cache_dir = cache_dir

    def fetch(self, pool: str, interval: str = "5m", limit: int = 300, before: int | None = None) -> list[Candle]:
        """Closed candles, oldest first. `before` is a unix time in seconds."""
        tf, agg, _ = FRAMES[interval]
        params = {"aggregate": agg, "limit": min(limit, 1000), "currency": "usd", "token": "base"}
        if before:
            params["before_timestamp"] = int(before)
        raw = http.get(GT.format(pool=pool, tf=tf), params=params,
                       headers={"Accept": "application/json;version=20230302"}, timeout=20)
        rows = (((raw or {}).get("data") or {}).get("attributes") or {}).get("ohlcv_list") or []
        out = {}
        for t, o, h, lo, c, v in rows:
            out[int(t) * 1000] = Candle(int(t) * 1000, float(o), float(h), float(lo), float(c), float(v or 0))
        return [out[t] for t in sorted(out)]

    def closed(self, pool: str, interval: str = "5m", limit: int = 300) -> list[Candle]:
        """Cached until the next candle closes, so watching a token costs one call per candle."""
        step = step_seconds(interval)
        key = (pool, interval)
        now = time.time()
        cached = self._mem.get(key)
        current_bar_start = int(now // step * step)
        if cached and cached[0] >= current_bar_start and len(cached[1]) >= min(limit, 50):
            return cached[1][-limit:]
        candles = [c for c in self.fetch(pool, interval, limit) if c.t / 1000 + step <= now]
        self._mem[key] = (now, candles)
        if len(self._mem) > 300:  # forget the oldest pools
            for k in sorted(self._mem, key=lambda k: self._mem[k][0])[:100]:
                self._mem.pop(k, None)
        return candles[-limit:]

    def history(self, pool: str, interval: str = "5m", bars: int = 1000) -> list[Candle]:
        """Longer history for training, kept on disk so retraining does not refetch everything."""
        path = self.cache_dir / f"{pool}_{interval}.json" if self.cache_dir else None
        known: dict[int, Candle] = {}
        if path and path.exists():
            try:
                for row in json.loads(path.read_text()):
                    known[row[0]] = Candle(*row)
            except (ValueError, TypeError):
                known = {}
        step = step_seconds(interval)
        fresh = self.fetch(pool, interval, min(bars, 1000))
        for c in fresh:
            known[c.t] = c
        candles = [known[t] for t in sorted(known) if t / 1000 + step <= time.time()][-max(bars, 1000) * 3:]
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps([[c.t, c.o, c.h, c.l, c.c, c.v] for c in candles]))
        return candles[-bars:] if bars else candles
