"""BTC/ETH pair trading, from the "ETH Pair Trading Strategy" video.

The video holds ETH and swaps it into BTC when the BTC/ETH ratio drops below its lower band
(30-day mean - 1 x std), then back to ETH when the ratio rises above the upper band
(30-day mean + 2 x std). Measured in ETH, holding BTC is the same as being long BTC and short
ETH, so on Liquid the bot opens a long BTC + short ETH pair of equal size. That keeps the bet
purely on the ratio: if the whole crypto market drops, the two legs cancel out.

Two fixes over the video: the trade happens on the candle *after* the signal (the video traded at
the same close it measured, a small look-ahead bias), and fees are counted on all four fills.
"""
from ..backtest import BarSignal, Costs
from ..indicators import rolling_std, sma
from ..models import Candle, Signal
from .base import Context, Strategy


def ratio_candles(a: list[Candle], b: list[Candle]) -> list[Candle]:
    """A/B as candles, matched on time. High/low are only approximated from open and close."""
    bmap = {c.t: c for c in b}
    out = []
    for ca in a:
        cb = bmap.get(ca.t)
        if cb and cb.o > 0 and cb.c > 0:
            o, c = ca.o / cb.o, ca.c / cb.c
            out.append(Candle(ca.t, o, max(o, c), min(o, c), c, 0.0))
    return out


def pair_signals(ratio: list[Candle], p: dict) -> list[BarSignal | None]:
    closes = [c.c for c in ratio]
    n = p.get("lookback", 30)
    mean, sd = sma(closes, n), rolling_std(closes, n)
    up_k, lo_k, stop_k = p.get("upper_k", 2.0), p.get("lower_k", 1.0), p.get("stop_k", 0)
    out: list[BarSignal | None] = []
    for i, c in enumerate(closes):
        if mean[i] is None or not sd[i]:
            out.append(None)
            continue
        upper, lower = mean[i] + up_k * sd[i], mean[i] - lo_k * sd[i]
        sig = BarSignal(exit_long=c > upper, exit_short=c < lower)
        if c < lower:
            sig.enter = "long"   # ratio is cheap: long A, short B
            if stop_k:
                sig.stop = mean[i] - stop_k * sd[i]
        elif c > upper and p.get("both_sides", False):
            sig.enter = "short"  # ratio is rich: short A, long B
            if stop_k:
                sig.stop = mean[i] + stop_k * sd[i]
        out.append(sig if (sig.enter or sig.exit_long or sig.exit_short) else None)
    return out


def pair_costs(costs: Costs) -> Costs:
    """Two legs, so twice the fees and slippage of a single trade."""
    return Costs(costs.fee_pct * 2, costs.slippage_pct * 2)


class PairStrategy(Strategy):
    """Long BTC / short ETH when BTC is cheap against ETH, closed when it is rich again."""
    name = "eth_btc_pair"
    venue = "liquid"

    def scan(self, ctx: Context) -> list[Signal]:
        p = self.cfg
        a_sym, b_sym = p.get("symbol_a", "BTC"), p.get("symbol_b", "ETH")
        a = ctx.hl.closed_candles(a_sym, p["interval"], p["lookback"] * 4)
        b = ctx.hl.closed_candles(b_sym, p["interval"], p["lookback"] * 4)
        ratio = ratio_candles(a, b)
        if len(ratio) < p["lookback"] + 2:
            self.last_note = "not enough history"
            return []
        last_t = ratio[-1].t
        if self.state.get("last_bar") == last_t:
            return []
        self.state["last_bar"] = last_t
        sig = pair_signals(ratio, p)[-1]
        group = f"pair:{a_sym}/{b_sym}"
        mine = ctx.mine(self.name)
        leg_a = mine.get(f"liquid:{a_sym}")
        side = None if not leg_a else ("long" if leg_a.side == "long" else "short")
        held_bars = self.state.get("bars_held", 0) + 1 if side else 0
        self.state["bars_held"] = held_bars
        self.last_note = f"{a_sym}/{b_sym} = {ratio[-1].c:.4f}"
        out = []
        too_long = side and p.get("max_hold_bars") and held_bars >= p["max_hold_bars"]
        if side and (too_long or sig and ((side == "long" and (sig.exit_long or sig.enter == "short")) or
                                          (side == "short" and (sig.exit_short or sig.enter == "long")))):
            out += [Signal("liquid", a_sym, "close", self.name, label=a_sym, group=group, reason="pair exit"),
                    Signal("liquid", b_sym, "close", self.name, label=b_sym, group=group, reason="pair exit")]
            side = None
        if sig and sig.enter and not side:
            long_a = sig.enter == "long"
            why = f"{a_sym}/{b_sym} ratio {ratio[-1].c:.4f} {'below lower' if long_a else 'above upper'} band"
            common = dict(strategy=self.name, size_usd=p["leg_usd"], stop_pct=p.get("leg_stop_pct", 20), group=group,
                          leverage=p.get("leverage", 1), reason=why)
            out += [Signal("liquid", a_sym, "buy" if long_a else "sell", label=a_sym, **common),
                    Signal("liquid", b_sym, "sell" if long_a else "buy", label=b_sym, **common)]
            self.state["bars_held"] = 0
        return out
