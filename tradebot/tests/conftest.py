import math
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bot import config as config_mod  # noqa: E402
from bot.models import Candle  # noqa: E402


def make_candles(n=600, start=100.0, drift=0.0004, vol=0.02, seed=1, step_ms=86_400_000, cycle=40.0):
    r = random.Random(seed)
    px, out = start, []
    for i in range(n):
        o = px
        c = o * math.exp(r.gauss(drift, vol) + 0.015 * math.sin(i / cycle))
        h = max(o, c) * (1 + abs(r.gauss(0, vol / 3)))
        lo = min(o, c) * (1 - abs(r.gauss(0, vol / 3)))
        out.append(Candle(1_600_000_000_000 + i * step_ms, o, h, lo, c, 1000.0))
        px = c
    return out


class FakeHL:
    """Stands in for Hyperliquid market data."""

    def __init__(self, prices=None, candles=None):
        self.prices = prices or {"BTC": 60000.0, "ETH": 3000.0, "SOL": 150.0, "xyz:NVDA": 180.0}
        self.candle_map = candles or {}

    def price(self, symbol):
        if symbol not in self.prices:
            raise KeyError(symbol)
        return self.prices[symbol]

    def mids(self, dex=""):
        return {k: v for k, v in self.prices.items() if (k.split(":")[0] if ":" in k else "") == dex}

    def market(self, symbol):
        if symbol not in self.prices:
            raise KeyError(symbol)
        return {"szDecimals": 4 if symbol == "BTC" else 2, "maxLeverage": 40 if symbol == "BTC" else 10,
                "onlyIsolated": ":" in symbol, "index": 0}

    def markets(self, dex=""):
        return {k: self.market(k) for k in self.mids(dex)}

    def has_market(self, symbol):
        return symbol in self.prices

    def closed_candles(self, symbol, interval, bars=300):
        return self.candle_map.get(symbol, [])[-bars:]

    def candles(self, symbol, interval, bars=300, end_ms=None):
        return self.closed_candles(symbol, interval, bars)


class FakeSol:
    def __init__(self, prices=None):
        self.price_map = prices or {"MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA": 0.01}

    def price(self, mint):
        if mint not in self.price_map:
            raise KeyError(mint)
        return self.price_map[mint]

    def prices(self, mints, max_age=10):
        return {m: self.price_map[m] for m in mints if m in self.price_map}

    def candidate_mints(self):
        return []

    def pairs(self, mints):
        return {}


@pytest.fixture
def cfg():
    c = config_mod.deep_merge(config_mod.DEFAULTS, {})
    for name in c["strategies"]:
        if name != "tradingview":
            c["strategies"][name]["enabled"] = False
    c["paper"]["slippage_pct"] = 0.0
    c["paper"]["fee_pct"] = 0.0
    c["research"]["enabled"] = False
    return c


@pytest.fixture
def engine(cfg, tmp_path):
    from bot.engine import Engine
    return Engine(cfg, data_dir=tmp_path, hl=FakeHL(), sol=FakeSol())
