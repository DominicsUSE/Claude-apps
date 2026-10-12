"""Follow US Congress stock purchases (Quiver data, the source you sent), traded as stock perps on Liquid.

Looks at purchases *reported* in the last few days (never the trade date: that information
was not public yet). Ranks stocks by how many members bought and how much, and buys the top
ones that Liquid lists (e.g. NVDA trades on Liquid as xyz:NVDA). Exits on the stop, the
target, the time limit, or when members report selling.
"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from ..data import quiver
from ..models import Signal
from .base import Context, Strategy

STOCK_DEXES = ("xyz",)


def rank_purchases(trades: list, today, lookback_days: int, min_trade_usd: float, min_buyers: int) -> list[dict]:
    since = today - timedelta(days=lookback_days)
    buyers: dict[str, set] = defaultdict(set)
    sellers: dict[str, set] = defaultdict(set)
    amount: dict[str, float] = defaultdict(float)
    for t in trades:
        if t.reported < since or t.reported > today:
            continue
        if t.side == "buy" and t.amount_usd >= min_trade_usd:
            buyers[t.ticker].add(t.member)
            amount[t.ticker] += t.amount_usd
        elif t.side == "sell":
            sellers[t.ticker].add(t.member)
    out = []
    for ticker, who in buyers.items():
        net = len(who) - len(sellers.get(ticker, ()))
        if len(who) >= min_buyers and net > 0:
            out.append({"ticker": ticker, "buyers": len(who), "sellers": len(sellers.get(ticker, ())),
                        "amount": amount[ticker], "members": sorted(who)[:5]})
    out.sort(key=lambda r: (r["buyers"], r["amount"]), reverse=True)
    return out


def sold_by_congress(trades: list, today, lookback_days: int) -> set[str]:
    since = today - timedelta(days=lookback_days)
    sells = defaultdict(set)
    for t in trades:
        if t.side == "sell" and since <= t.reported <= today:
            sells[t.ticker].add(t.member)
    return {k for k, v in sells.items() if len(v) >= 2}


class CongressStrategy(Strategy):
    """Buys stocks that members of Congress recently reported buying (needs a Quiver key)."""
    name = "congress"
    venue = "liquid"

    def liquid_symbol(self, ctx: Context, ticker: str) -> str | None:
        for dex in STOCK_DEXES:
            sym = f"{dex}:{ticker}"
            if ctx.hl.has_market(sym):
                return sym
        return None

    def scan(self, ctx: Context) -> list[Signal]:
        p = self.cfg
        trades = quiver.fetch()
        today = datetime.now(timezone.utc).date()
        mine = ctx.mine(self.name)
        out = []
        dumped = sold_by_congress(trades, today, p["lookback_days"])
        for key, pos in mine.items():
            ticker = pos.symbol.split(":")[-1]
            if ticker in dumped:
                out.append(Signal("liquid", pos.symbol, "close", self.name, label=ticker, reason="members reported selling"))
        day_key = today.isoformat()
        opened_today = self.state.get("opened", {}).get(day_key, 0)
        ranked = rank_purchases(trades, today, p["lookback_days"], p["min_trade_usd"], p["min_buyers"])
        held = {pos.symbol for pos in ctx.positions}
        done = set(self.state.get("done", []))
        for row in ranked:
            if opened_today >= p["max_new_per_day"]:
                break
            sym = self.liquid_symbol(ctx, row["ticker"])
            if not sym or sym in held or row["ticker"] in done:
                continue
            out.append(Signal("liquid", sym, "buy", self.name, label=row["ticker"], size_usd=p["position_usd"],
                              stop_pct=p["stop_loss_pct"], take_profit_pct=p["take_profit_pct"],
                              max_hold_hours=p["max_hold_days"] * 24,
                              reason=f"{row['buyers']} member(s) bought ~${row['amount']:,.0f}: {', '.join(row['members'][:3])}"))
            done.add(row["ticker"])
            opened_today += 1
        self.state["opened"] = {day_key: opened_today}
        self.state["done"] = sorted(done)[-300:]
        self.last_note = f"{len(trades)} filings, {len(ranked)} stocks with net buying"
        return out
