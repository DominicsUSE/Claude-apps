"""Stock trades by members of the US Congress, from Quiver Quantitative (needs QUIVER_API_TOKEN).

Same data set as the QuantConnect "QuiverQuantCongressTrading" source you sent. Like that
code, we date every trade by when it was *reported* (filed), never by when it happened:
members file up to 45 days late, and using the trade date would be look-ahead bias.
"""
from dataclasses import dataclass
from datetime import date, datetime

from .. import http
from ..config import secret

URL = "https://api.quiverquant.com/beta/live/congresstrading"


@dataclass
class CongressTrade:
    member: str
    ticker: str
    side: str           # "buy" or "sell"
    amount_usd: float   # lower bound of the reported range
    traded: date
    reported: date
    chamber: str = ""
    party: str = ""


def _date(value) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except ValueError:
        return None


def _amount(row: dict) -> float:
    for key in ("Amount", "Trade_Size_USD", "Range"):
        raw = row.get(key)
        if raw in (None, ""):
            continue
        text = str(raw).replace("$", "").replace(",", "").split("-")[0].strip()
        try:
            return float(text)
        except ValueError:
            continue
    return 0.0


def parse(rows: list[dict]) -> list[CongressTrade]:
    """Accepts both Quiver's live format and the bulk format the Lean downloader reads."""
    out = []
    for row in rows or []:
        ticker = str(row.get("Ticker") or "").strip().upper()
        kind = str(row.get("TickerType") or "").strip()
        if not ticker or (kind and kind not in ("Stock", "ST")):
            continue
        txn = str(row.get("Transaction") or "").lower()
        if txn.startswith("purchase") or txn == "buy":
            side = "buy"
        elif txn.startswith("sale") or txn == "sell":
            side = "sell"
        else:
            continue  # exchanges, holds and other entries carry no direction
        reported = _date(row.get("ReportDate") or row.get("Filed"))
        traded = _date(row.get("TransactionDate") or row.get("Traded"))
        if not reported or not traded:
            continue
        out.append(CongressTrade(
            member=str(row.get("Representative") or row.get("Name") or ""),
            ticker=ticker, side=side, amount_usd=_amount(row), traded=traded, reported=reported,
            chamber=str(row.get("House") or row.get("Chamber") or ""), party=str(row.get("Party") or ""),
        ))
    return out


def fetch() -> list[CongressTrade]:
    token = secret("QUIVER_API_TOKEN")
    if not token:
        raise RuntimeError("Add QUIVER_API_TOKEN to .env to use the congress strategy")
    rows = http.get(URL, headers={"Authorization": f"Token {token}"}, timeout=30)
    return parse(rows)
