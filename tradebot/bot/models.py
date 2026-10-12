"""Plain data types shared by strategies, brokers and the engine."""
from dataclasses import asdict, dataclass, field
from typing import Optional


@dataclass
class Candle:
    t: int          # open time, milliseconds since 1970
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0


@dataclass
class Signal:
    """A request to trade. Strategies, TradingView alerts and the dashboard all produce these."""
    venue: str                  # "fomo" or "liquid"
    symbol: str                 # Solana mint address for fomo; "BTC" or "xyz:NVDA" for liquid
    action: str                 # "buy" (open long), "sell" (open short), "close", "stop" (raise the stop to stop_price)
    strategy: str
    label: str = ""             # human readable name, e.g. "BONK"
    size_usd: Optional[float] = None
    stop_price: Optional[float] = None
    stop_pct: Optional[float] = None
    take_profit_price: Optional[float] = None
    take_profit_pct: Optional[float] = None
    take_profit_ladder: Optional[list] = None   # [[gain_pct, fraction_to_sell], ...]
    trailing_stop_pct: Optional[float] = None
    max_hold_hours: Optional[float] = None
    leverage: Optional[float] = None
    close_fraction: float = 1.0
    reason: str = ""
    group: str = ""             # positions opened together (pair trades) share a group and close together
    setup: str = ""             # which chart setup triggered it (meme scalper), for per-setup learning
    warning: str = ""           # shown on the approval card, e.g. "training has not proven this setup"
    approved: bool = False      # you approved it on the dashboard: place it without asking again

    @property
    def key(self) -> str:
        return f"{self.venue}:{self.symbol}"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Position:
    venue: str
    symbol: str
    side: str                   # "long" or "short"
    qty: float                  # in coin/token units, always positive
    entry_price: float
    mark_price: float
    label: str = ""
    leverage: float = 1.0
    opened_at: float = 0.0      # unix seconds

    @property
    def key(self) -> str:
        return f"{self.venue}:{self.symbol}"

    @property
    def notional(self) -> float:
        return self.qty * self.mark_price

    @property
    def unrealized_pnl(self) -> float:
        diff = self.mark_price - self.entry_price
        return diff * self.qty if self.side == "long" else -diff * self.qty

    @property
    def pnl_pct(self) -> float:
        if not self.entry_price:
            return 0.0
        move = (self.mark_price / self.entry_price - 1) * 100
        return move if self.side == "long" else -move

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(key=self.key, notional=self.notional, unrealized_pnl=self.unrealized_pnl, pnl_pct=self.pnl_pct)
        return d


@dataclass
class Fill:
    ok: bool
    venue: str
    symbol: str
    side: str = ""              # "buy" or "sell"
    qty: float = 0.0
    price: float = 0.0
    fee_usd: float = 0.0
    realized_pnl: float = 0.0
    error: str = ""
    tx: str = ""                # order id or transaction signature
    raw: dict = field(default_factory=dict)

    @property
    def notional(self) -> float:
        return self.qty * self.price
