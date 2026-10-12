"""Practice account: real live prices, simulated orders, fees and slippage. Nothing leaves your computer.

FOMO tokens are bought outright (spot): buying spends cash. Liquid markets are perpetual
futures: only fees and profit or loss touch cash, and leverage decides how much margin is used.
"""
import time

from ..models import Fill, Position
from .base import Broker

SPOT_VENUES = {"fomo"}


class PaperBroker(Broker):
    name = "paper"
    venues = ("fomo", "liquid")
    supports_short = True

    def __init__(self, price_fn, starting_balance: float = 1000.0, fee_pct: float = 0.1, slippage_pct: float = 0.3,
                 state: dict | None = None):
        self.price_fn = price_fn            # (venue, symbol) -> float
        self.fee = fee_pct / 100
        self.slippage = slippage_pct / 100
        state = state or {}
        self.starting_balance = float(state.get("starting_balance", starting_balance))
        self._cash = float(state.get("cash", starting_balance))
        self.book: dict[str, dict] = state.get("positions", {})
        self.realized = float(state.get("realized", 0.0))
        self.fees_paid = float(state.get("fees_paid", 0.0))
        self._marks: dict[str, float] = {}

    def to_state(self) -> dict:
        return {"starting_balance": self.starting_balance, "cash": self._cash, "positions": self.book,
                "realized": self.realized, "fees_paid": self.fees_paid}

    def reset(self, balance: float) -> None:
        self.starting_balance = self._cash = float(balance)
        self.book, self.realized, self.fees_paid = {}, 0.0, 0.0

    def _mark(self, venue: str, symbol: str, fallback: float) -> float:
        key = f"{venue}:{symbol}"
        try:
            price = float(self.price_fn(venue, symbol))
            if price > 0:
                self._marks[key] = price
        except Exception:
            pass
        return self._marks.get(key, fallback)

    def positions(self) -> list[Position]:
        out = []
        for p in self.book.values():
            mark = self._mark(p["venue"], p["symbol"], p["entry_price"])
            out.append(Position(p["venue"], p["symbol"], p["side"], p["qty"], p["entry_price"], mark,
                                p.get("label", ""), p.get("leverage", 1.0), p.get("opened_at", 0.0)))
        return out

    def cash(self) -> float:
        return self._cash

    def equity(self) -> float:
        total = self._cash
        for pos in self.positions():
            if pos.venue in SPOT_VENUES:
                total += pos.notional
            else:
                total += pos.unrealized_pnl
        return total

    def margin_used(self) -> float:
        return sum(p.notional / max(p.leverage, 1) for p in self.positions() if p.venue not in SPOT_VENUES)

    def open(self, venue, symbol, side, size_usd, *, leverage=1.0, label="", stop_price=None, take_profit_price=None) -> Fill:
        if venue in SPOT_VENUES and side != "long":
            return Fill(False, venue, symbol, error="FOMO tokens can only be bought, not shorted")
        try:
            mid = float(self.price_fn(venue, symbol))
        except Exception as e:
            return Fill(False, venue, symbol, error=f"no price: {e}")
        if mid <= 0:
            return Fill(False, venue, symbol, error="no price")
        price = mid * (1 + self.slippage) if side == "long" else mid * (1 - self.slippage)
        qty = size_usd / price
        fee = size_usd * self.fee
        if venue in SPOT_VENUES:
            if size_usd + fee > self._cash:
                return Fill(False, venue, symbol, error=f"not enough cash (${self._cash:.2f})")
            self._cash -= size_usd + fee
        else:
            free = self.equity() - self.margin_used()
            if size_usd / max(leverage, 1) + fee > free:
                return Fill(False, venue, symbol, error=f"not enough free margin (${free:.2f})")
            self._cash -= fee
        self.fees_paid += fee
        key = f"{venue}:{symbol}"
        existing = self.book.get(key)
        if existing and existing["side"] == side:
            total_qty = existing["qty"] + qty
            existing["entry_price"] = (existing["entry_price"] * existing["qty"] + price * qty) / total_qty
            existing["qty"] = total_qty
        elif existing:
            return Fill(False, venue, symbol, error="close the opposite position first")
        else:
            self.book[key] = {"venue": venue, "symbol": symbol, "side": side, "qty": qty, "entry_price": price,
                              "leverage": float(leverage), "label": label, "opened_at": time.time()}
        self._marks[key] = mid
        return Fill(True, venue, symbol, "buy" if side == "long" else "sell", qty, price, fee, tx="paper")

    def close(self, venue, symbol, fraction=1.0) -> Fill:
        key = f"{venue}:{symbol}"
        p = self.book.get(key)
        if not p:
            return Fill(False, venue, symbol, error="no open position")
        fraction = min(max(fraction, 0.0), 1.0)
        try:
            mid = float(self.price_fn(venue, symbol))
        except Exception:
            mid = self._marks.get(key, 0)
        if mid <= 0:
            return Fill(False, venue, symbol, error="no price to close at")
        price = mid * (1 - self.slippage) if p["side"] == "long" else mid * (1 + self.slippage)
        qty = p["qty"] if fraction >= 0.999 else p["qty"] * fraction
        notional = qty * price
        fee = notional * self.fee
        pnl = (price - p["entry_price"]) * qty if p["side"] == "long" else (p["entry_price"] - price) * qty
        if venue in SPOT_VENUES:
            self._cash += notional - fee
        else:
            self._cash += pnl - fee
        self.fees_paid += fee
        self.realized += pnl - fee
        if fraction >= 0.999:
            del self.book[key]
        else:
            p["qty"] -= qty
        return Fill(True, venue, symbol, "sell" if p["side"] == "long" else "buy", qty, price, fee, pnl - fee, tx="paper")

    def status(self) -> dict:
        return {"name": "paper", "connected": True, "detail": "Practice money with live prices"}
