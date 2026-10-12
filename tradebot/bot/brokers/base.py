"""What every broker (paper, FOMO wallet, Liquid/Hyperliquid) can do."""
from ..models import Fill, Position


class Broker:
    name = "broker"
    venues: tuple[str, ...] = ()
    supports_short = False

    def equity(self) -> float:
        """Account value in USD: cash plus open positions at current prices."""
        raise NotImplementedError

    def cash(self) -> float:
        raise NotImplementedError

    def positions(self) -> list[Position]:
        raise NotImplementedError

    def open(self, venue: str, symbol: str, side: str, size_usd: float, *, leverage: float = 1.0,
             label: str = "", stop_price: float | None = None, take_profit_price: float | None = None) -> Fill:
        """side is "long" or "short". size_usd is the position size, not the margin."""
        raise NotImplementedError

    def close(self, venue: str, symbol: str, fraction: float = 1.0) -> Fill:
        raise NotImplementedError

    def update_stop(self, venue: str, symbol: str, stop_price: float) -> None:
        """Move an exchange-side stop. Brokers without exchange-side stops ignore this."""

    def status(self) -> dict:
        return {"name": self.name, "connected": True}
