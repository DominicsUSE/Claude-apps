"""Live trading on Hyperliquid, the exchange your Liquid account runs on.

Hyperliquid has no API keys. Instead you create an "API wallet" (also called agent wallet) at
app.hyperliquid.xyz > More > API for your account. It can place and cancel orders but can never
withdraw money. Put its private key in HL_API_PRIVATE_KEY and your account address
(the one Liquid shows, starting 0x) in HL_ACCOUNT_ADDRESS.

Every position also gets a stop-loss order on the exchange itself, so you stay protected
even if your computer turns off.
"""
import math
import time

from ..data.hyperliquid import HyperliquidData, dex_of
from ..models import Fill, Position
from .base import Broker


def round_size(size: float, sz_decimals: int) -> float:
    factor = 10 ** sz_decimals
    return math.floor(size * factor) / factor


def round_price(price: float, sz_decimals: int, spot: bool = False) -> float:
    """Hyperliquid accepts at most 5 significant figures and (6 - szDecimals) decimals for perps."""
    if price <= 0:
        return 0.0
    max_decimals = (8 if spot else 6) - sz_decimals
    if price >= 100_000:
        return float(round(price))
    sig = float(f"{price:.5g}")
    return round(sig, max(max_decimals, 0))


class HyperliquidBroker(Broker):
    name = "liquid"
    venues = ("liquid",)
    supports_short = True

    def __init__(self, venue_cfg: dict, data: HyperliquidData, account_address: str, api_private_key: str,
                 dexes: list[str] | None = None, exchange=None, state: dict | None = None):
        self.cfg = venue_cfg
        self.data = data
        self.address = account_address
        self.dexes = dexes or [""]
        self.opened_at: dict[str, float] = (state or {}).get("opened_at", {})
        self.labels: dict[str, str] = (state or {}).get("labels", {})
        if exchange is None:
            from eth_account import Account
            from hyperliquid.exchange import Exchange
            wallet = Account.from_key(api_private_key)
            exchange = Exchange(wallet, venue_cfg["api_url"], account_address=account_address,
                                perp_dexs=self.dexes if self.dexes != [""] else None)
        self.ex = exchange

    def to_state(self) -> dict:
        return {"opened_at": self.opened_at, "labels": self.labels}

    def _states(self) -> list[dict]:
        return [self.data.user_state(self.address, dex) for dex in self.dexes]

    def equity(self) -> float:
        return sum(float(s.get("marginSummary", {}).get("accountValue", 0)) for s in self._states())

    def cash(self) -> float:
        return sum(float(s.get("withdrawable", 0)) for s in self._states())

    def positions(self) -> list[Position]:
        out = []
        for state in self._states():
            for ap in state.get("assetPositions", []):
                p = ap.get("position", {})
                szi = float(p.get("szi", 0))
                if szi == 0:
                    continue
                coin = p["coin"]
                qty = abs(szi)
                value = float(p.get("positionValue", 0))
                mark = value / qty if qty else float(p.get("entryPx", 0))
                lev = float((p.get("leverage") or {}).get("value", 1))
                out.append(Position("liquid", coin, "long" if szi > 0 else "short", qty, float(p.get("entryPx", 0)), mark,
                                    self.labels.get(coin, coin), lev, self.opened_at.get(coin, 0.0)))
        return out

    @staticmethod
    def _parse(resp) -> tuple[bool, str, dict]:
        """Hyperliquid answers {"status":"ok","response":{"data":{"statuses":[...]}}} or {"status":"err",...}."""
        if not isinstance(resp, dict) or resp.get("status") != "ok":
            return False, str(resp.get("response") if isinstance(resp, dict) else resp), {}
        statuses = ((resp.get("response") or {}).get("data") or {}).get("statuses") or []
        first = statuses[0] if statuses else {}
        if isinstance(first, dict) and first.get("error"):
            return False, first["error"], first
        return True, "", first if isinstance(first, dict) else {}

    def open(self, venue, symbol, side, size_usd, *, leverage=1.0, label="", stop_price=None, take_profit_price=None) -> Fill:
        try:
            info = self.data.market(symbol)
            lev = max(1, min(int(leverage), info["maxLeverage"]))
            cross = not info["onlyIsolated"] and dex_of(symbol) == ""
            ok, err, _ = self._parse(self.ex.update_leverage(lev, symbol, cross))
            if not ok:
                return Fill(False, venue, symbol, error=f"could not set leverage: {err}")
            mid = self.data.price(symbol)
            qty = round_size(size_usd / mid, info["szDecimals"])
            if qty <= 0:
                return Fill(False, venue, symbol, error="order too small for this market")
            is_buy = side == "long"
            resp = self.ex.market_open(symbol, is_buy, qty, None, self.cfg.get("slippage_pct", 1.0) / 100)
            ok, err, status = self._parse(resp)
            if not ok:
                return Fill(False, venue, symbol, error=err)
            filled = status.get("filled") or {}
            fqty = float(filled.get("totalSz", 0))
            if fqty <= 0:
                return Fill(False, venue, symbol, error="order did not fill (price moved too fast)")
        except Exception as e:
            return Fill(False, venue, symbol, error=str(e))
        # The position is open from here on: report it as filled whatever happens next, so the bot owns
        # it and its own stop check guards it even if the exchange stop order could not be placed.
        price = float(filled.get("avgPx", mid) or mid)
        self.opened_at[symbol] = time.time()
        self.labels[symbol] = label or symbol
        warnings = []
        for trigger, kind, name in ((stop_price, "sl", "stop-loss"), (take_profit_price, "tp", "take-profit")):
            if not trigger:
                continue
            try:
                ok, err, _ = self._parse(self._place_trigger(symbol, not is_buy, fqty, trigger, kind, info["szDecimals"]))
            except Exception as e:
                ok, err = False, str(e)
            if not ok:
                warnings.append(f"the exchange {name} order could not be placed ({err}); the bot watches the {name} itself")
        return Fill(True, venue, symbol, "buy" if is_buy else "sell", fqty, price, fqty * price * 0.00045,
                    error="; ".join(warnings), tx=str(filled.get("oid", "")), raw=resp)

    def _place_trigger(self, symbol: str, is_buy: bool, qty: float, trigger: float, kind: str, sz_decimals: int):
        px = round_price(trigger, sz_decimals)
        # For a market trigger the limit price only caps slippage: give it room.
        limit = round_price(trigger * (1.1 if is_buy else 0.9), sz_decimals)
        order_type = {"trigger": {"triggerPx": px, "isMarket": True, "tpsl": kind}}
        return self.ex.order(symbol, is_buy, qty, limit, order_type, reduce_only=True)

    def _cancel_triggers(self, symbol: str, kinds=("sl", "tp")) -> None:
        """Cancel this market's stop-loss ("sl") and/or take-profit ("tp") orders."""
        for o in self.data.open_orders(self.address, dex_of(symbol)):
            if o.get("coin") != symbol:
                continue
            kind = str(o.get("orderType", "")).lower()
            is_tp = "take profit" in kind
            is_sl = "stop" in kind and not is_tp
            if (is_sl and "sl" in kinds) or (is_tp and "tp" in kinds) or (not kind and o.get("reduceOnly")):
                try:
                    self.ex.cancel(symbol, int(o["oid"]))
                except Exception:
                    pass

    def update_stop(self, venue, symbol, stop_price) -> None:
        pos = next((p for p in self.positions() if p.symbol == symbol), None)
        if not pos:
            return
        info = self.data.market(symbol)
        self._cancel_triggers(symbol, kinds=("sl",))   # keep the take-profit order in place
        self._place_trigger(symbol, pos.side == "short", pos.qty, stop_price, "sl", info["szDecimals"])

    def close(self, venue, symbol, fraction=1.0) -> Fill:
        try:
            pos = next((p for p in self.positions() if p.symbol == symbol), None)
            if not pos:
                return Fill(False, venue, symbol, error="no open position")
            info = self.data.market(symbol)
            qty = pos.qty if fraction >= 0.999 else round_size(pos.qty * fraction, info["szDecimals"])
            if qty <= 0:
                return Fill(False, venue, symbol, error="nothing to close")
            resp = self.ex.market_close(symbol, qty, None, self.cfg.get("slippage_pct", 1.0) / 100)
            ok, err, status = self._parse(resp)
            if not ok:
                return Fill(False, venue, symbol, error=err)
            filled = status.get("filled") or {}
            fqty = float(filled.get("totalSz", qty))
            price = float(filled.get("avgPx", pos.mark_price))
            pnl = (price - pos.entry_price) * fqty if pos.side == "long" else (pos.entry_price - price) * fqty
            if fraction >= 0.999:
                self._cancel_triggers(symbol)
                self.opened_at.pop(symbol, None)
            return Fill(True, venue, symbol, "sell" if pos.side == "long" else "buy", fqty, price, fqty * price * 0.00045,
                        pnl, tx=str(filled.get("oid", "")), raw=resp)
        except Exception as e:
            return Fill(False, venue, symbol, error=str(e))

    def status(self) -> dict:
        try:
            eq = self.equity()
            return {"name": "liquid", "connected": True, "detail": f"Account {self.address[:6]}…{self.address[-4:]}, ${eq:,.2f}"}
        except Exception as e:
            return {"name": "liquid", "connected": False, "detail": str(e)}
