"""Risk limits. Every trade, whatever its source (strategy, TradingView, dashboard), passes through here.

Position size comes from the stop: if the stop is 10% away and you risk 1% of equity per trade,
the position is 10% of equity. Then every hard cap is applied on top, and the smallest wins.
"""
import time
from dataclasses import dataclass

from .models import Position, Signal


@dataclass
class Decision:
    ok: bool
    size_usd: float = 0.0
    stop_price: float | None = None
    take_profit_price: float | None = None
    leverage: float = 1.0
    reason: str = ""


class RiskManager:
    def __init__(self, cfg: dict):
        self.cfg = cfg

    def check_account(self, equity: float, day_start_equity: float, peak_equity: float) -> str:
        """Returns a reason to stop opening trades, or "" if all is fine."""
        r = self.cfg
        if day_start_equity > 0:
            day_loss = (day_start_equity - equity) / day_start_equity * 100
            if day_loss >= r["daily_loss_limit_pct"]:
                return f"Daily loss limit hit (-{day_loss:.1f}% today). New trades resume tomorrow (UTC)."
        if peak_equity > 0:
            dd = (peak_equity - equity) / peak_equity * 100
            if dd >= r["max_drawdown_pct"]:
                return f"Max drawdown hit (-{dd:.1f}% from the peak). Press Resume after reviewing."
        return ""

    def evaluate(self, sig: Signal, price: float, equity: float, positions: list[Position],
                 strategy_counts: dict[str, int], cooldowns: dict[str, float], supports_short: bool,
                 max_leverage_market: int | None = None) -> Decision:
        r = self.cfg
        if price <= 0:
            return Decision(False, reason="no price")
        if r["allowed_symbols"] and sig.symbol not in r["allowed_symbols"] and sig.label not in r["allowed_symbols"]:
            return Decision(False, reason="not in your allowed list")
        if sig.symbol in r["blocked_symbols"] or (sig.label and sig.label in r["blocked_symbols"]):
            return Decision(False, reason="on your blocked list")
        if sig.action == "sell" and not supports_short:
            return Decision(False, reason="this venue cannot short")
        until = cooldowns.get(sig.key, 0)
        if until > time.time():
            return Decision(False, reason=f"cooling down after a loss ({int((until - time.time()) / 60)} min left)")
        open_keys = {p.key for p in positions}
        if sig.key not in open_keys and len(positions) >= r["max_open_positions"]:
            return Decision(False, reason=f"already {len(positions)} positions open (limit {r['max_open_positions']})")
        if sig.key not in open_keys and strategy_counts.get(sig.strategy, 0) >= r["max_positions_per_strategy"]:
            return Decision(False, reason=f"{sig.strategy} already has {strategy_counts[sig.strategy]} positions")

        long = sig.action == "buy"
        # Stop: explicit price, else % from the signal, else the default.
        stop = sig.stop_price
        if stop is None:
            pct = sig.stop_pct if sig.stop_pct else r["default_stop_loss_pct"]
            stop = price * (1 - pct / 100) if long else price * (1 + pct / 100)
        if (long and stop >= price) or (not long and stop <= price):
            return Decision(False, reason="stop-loss is on the wrong side of the price")
        stop_dist = abs(price - stop) / price
        if stop_dist * 100 > r["max_stop_loss_pct"]:
            return Decision(False, reason=f"stop is {stop_dist * 100:.0f}% away (max {r['max_stop_loss_pct']}%)")

        tp = sig.take_profit_price
        if tp is None and sig.take_profit_pct:
            tp = price * (1 + sig.take_profit_pct / 100) if long else price * (1 - sig.take_profit_pct / 100)
        if tp is not None and ((long and tp <= price) or (not long and tp >= price)):
            tp = None

        risk_usd = equity * r["risk_per_trade_pct"] / 100
        size = risk_usd / stop_dist
        if sig.size_usd:
            size = min(size, sig.size_usd)
        size = min(size, r["max_position_usd"])
        exposure = sum(p.notional for p in positions)
        room = equity * r["max_total_exposure_pct"] / 100 - exposure
        size = min(size, room)
        lev_cap = r["max_leverage"]
        if max_leverage_market:
            lev_cap = min(lev_cap, max_leverage_market)
        leverage = max(1.0, min(float(sig.leverage or 1), float(lev_cap)))
        if size < r["min_position_usd"]:
            if room < r["min_position_usd"]:
                return Decision(False, reason="total exposure limit reached")
            return Decision(False, reason=f"position would be ${size:.2f}, under the ${r['min_position_usd']:.0f} minimum")
        return Decision(True, round(size, 2), stop, tp, leverage)
