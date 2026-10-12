"""Public market data from Hyperliquid, the exchange Liquid trades on. No key needed.

Main markets use plain names ("BTC"). Stock and commodity markets live on builder exchanges
and carry a prefix ("xyz:NVDA"), which is how Liquid lists them too.
"""
import time

from .. import http
from ..models import Candle

INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000,
    "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
}


def dex_of(symbol: str) -> str:
    return symbol.split(":", 1)[0] if ":" in symbol else ""


class HyperliquidData:
    def __init__(self, api_url: str = "https://api.hyperliquid.xyz"):
        self.url = api_url.rstrip("/") + "/info"
        self._meta: dict[str, tuple[float, dict]] = {}
        self._mids: dict[str, tuple[float, dict]] = {}

    def _info(self, payload: dict):
        return http.post(self.url, json=payload)

    def mids(self, dex: str = "", max_age: float = 3.0) -> dict[str, float]:
        cached = self._mids.get(dex)
        if cached and time.time() - cached[0] < max_age:
            return cached[1]
        raw = self._info({"type": "allMids", "dex": dex} if dex else {"type": "allMids"})
        mids = {k: float(v) for k, v in raw.items()}
        self._mids[dex] = (time.time(), mids)
        return mids

    def price(self, symbol: str) -> float:
        mids = self.mids(dex_of(symbol))
        if symbol not in mids:
            raise KeyError(f"{symbol} is not trading on Hyperliquid")
        return mids[symbol]

    def markets(self, dex: str = "") -> dict[str, dict]:
        """name -> {szDecimals, maxLeverage, onlyIsolated, index}. Cached for 10 minutes."""
        cached = self._meta.get(dex)
        if cached and time.time() - cached[0] < 600:
            return cached[1]
        raw = self._info({"type": "meta", "dex": dex} if dex else {"type": "meta"})
        out = {}
        for i, m in enumerate(raw.get("universe", [])):
            if m.get("isDelisted"):
                continue
            out[m["name"]] = {
                "szDecimals": int(m.get("szDecimals", 0)),
                "maxLeverage": int(m.get("maxLeverage", 1)),
                "onlyIsolated": bool(m.get("onlyIsolated", False)),
                "index": i,
            }
        self._meta[dex] = (time.time(), out)
        return out

    def market(self, symbol: str) -> dict:
        info = self.markets(dex_of(symbol)).get(symbol)
        if not info:
            raise KeyError(f"{symbol} is not a Hyperliquid market")
        return info

    def has_market(self, symbol: str) -> bool:
        try:
            return symbol in self.markets(dex_of(symbol))
        except http.HttpError:
            return False

    def candles(self, symbol: str, interval: str, bars: int = 300, end_ms: int | None = None) -> list[Candle]:
        """The most recent `bars` candles. The last one may still be forming; see closed_candles."""
        step = INTERVAL_MS[interval]
        end = end_ms or int(time.time() * 1000)
        start = end - step * bars
        out: dict[int, Candle] = {}
        # The API returns at most 5000 candles per call, so long histories are fetched in pages.
        cursor = start
        while cursor < end:
            page_end = min(end, cursor + step * 4900)
            raw = self._info({"type": "candleSnapshot", "req": {"coin": symbol, "interval": interval, "startTime": cursor, "endTime": page_end}})
            for c in raw or []:
                out[int(c["t"])] = Candle(int(c["t"]), float(c["o"]), float(c["h"]), float(c["l"]), float(c["c"]), float(c.get("v", 0)))
            cursor = page_end + 1
        return [out[t] for t in sorted(out)]

    def closed_candles(self, symbol: str, interval: str, bars: int = 300) -> list[Candle]:
        """Only finished candles. Deciding on a half-built candle would repaint, like look-ahead bias."""
        now = int(time.time() * 1000)
        step = INTERVAL_MS[interval]
        return [c for c in self.candles(symbol, interval, bars + 1, now) if c.t + step <= now][-bars:]

    def user_state(self, address: str, dex: str = "") -> dict:
        payload = {"type": "clearinghouseState", "user": address}
        if dex:
            payload["dex"] = dex
        return self._info(payload)

    def open_orders(self, address: str, dex: str = "") -> list:
        """Includes orderType ("Stop Market", "Take Profit Market", "Limit", ...) and reduceOnly."""
        payload = {"type": "frontendOpenOrders", "user": address}
        if dex:
            payload["dex"] = dex
        return self._info(payload)
