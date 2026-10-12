"""Live strategy plumbing: what the engine hands to a strategy each time it runs."""
import time
from dataclasses import dataclass, field

from ..models import Position, Signal


@dataclass
class Context:
    cfg: dict
    hl: object                       # HyperliquidData
    sol: object                      # SolanaData
    positions: list[Position]
    owners: dict[str, dict]          # position key -> what the engine knows about it (strategy, opened_at, ...)
    now: float = field(default_factory=time.time)
    venues: tuple = ("fomo", "liquid")   # venues that are connected right now

    def mine(self, strategy: str) -> dict[str, Position]:
        """Open positions this strategy opened, by key."""
        return {p.key: p for p in self.positions if self.owners.get(p.key, {}).get("strategy") == strategy}


class Strategy:
    name = "strategy"
    venue = "liquid"

    def __init__(self, cfg: dict, state: dict | None = None):
        self.cfg = cfg
        self.state = state if state is not None else {}
        self.last_run = 0.0
        self.last_note = ""

    def due(self, now: float) -> bool:
        return now - self.last_run >= self.cfg.get("every_seconds", 300)

    def scan(self, ctx: Context) -> list[Signal]:
        raise NotImplementedError
