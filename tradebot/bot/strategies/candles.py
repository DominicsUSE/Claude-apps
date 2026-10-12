"""Runs a candle strategy live on Liquid: the newest closed candle decides, once per candle."""
import time

from ..data.hyperliquid import INTERVAL_MS
from ..models import Signal
from .base import Context, Strategy
from .signals import CANDLE_STRATEGIES, DEFAULT_PARAMS

BARS_NEEDED = 400


class CandleStrategy(Strategy):
    """Trades Liquid perps from candle signals (trend, regime, breakout, mean reversion)."""

    def __init__(self, name: str, cfg: dict, state: dict | None = None):
        super().__init__(cfg, state)
        self.name = name
        self.venue = cfg.get("venue", "liquid")
        self.fn = CANDLE_STRATEGIES[cfg.get("kind", name)]
        self.params = {**DEFAULT_PARAMS.get(cfg.get("kind", name), {}), **cfg}

    def symbols(self) -> list[str]:
        return self.cfg.get("symbols") or [self.cfg.get("symbol", "BTC")]

    def scan(self, ctx: Context) -> list[Signal]:
        out = []
        mine = ctx.mine(self.name)
        seen = self.state.setdefault("last_bar", {})
        notes = []
        for sym in self.symbols():
            candles = ctx.hl.closed_candles(sym, self.cfg["interval"], BARS_NEEDED)
            if len(candles) < 60:
                notes.append(f"{sym}: not enough history yet")
                continue
            last = candles[-1]
            remembered = self.state.setdefault("notes", {})
            if seen.get(sym) == last.t:
                notes.append(remembered.get(sym, f"{sym}: waiting for the next candle"))
                continue  # already acted on this candle
            seen[sym] = last.t
            sig = self.fn(candles, self.params)[-1]
            held = mine.get(f"{self.venue}:{sym}")
            when = time.strftime("%d %b %H:%M", time.gmtime((last.t + INTERVAL_MS[self.cfg["interval"]]) / 1000))
            if sig is None:
                remembered[sym] = f"{sym}: no signal at the {when} UTC close"
                notes.append(remembered[sym])
                continue
            if held and ((held.side == "long" and (sig.exit_long or sig.enter == "short")) or
                         (held.side == "short" and (sig.exit_short or sig.enter == "long"))):
                out.append(Signal(self.venue, sym, "close", self.name, label=sym, reason="exit signal"))
                held = None
            if sig.enter and not held:
                out.append(Signal(self.venue, sym, "buy" if sig.enter == "long" else "sell", self.name, label=sym,
                                  stop_price=sig.stop, take_profit_price=sig.take_profit,
                                  leverage=self.cfg.get("leverage", 1),
                                  reason=f"{self.name} {sig.enter} signal on the {self.cfg['interval']} close"))
            remembered[sym] = f"{sym}: {sig.enter or 'exit'} signal at the {when} UTC close"
            notes.append(remembered[sym])
        self.last_note = "; ".join(notes)
        return out
