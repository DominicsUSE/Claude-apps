"""TradingView alerts -> trades.

In TradingView, create an alert, tick "Webhook URL", paste your bot's public URL and use a
message like:

    {"secret": "your-TV_WEBHOOK_SECRET", "symbol": "{{ticker}}", "action": "buy", "size_usd": 25, "stop_pct": 4}

Fields:
  secret       must match TV_WEBHOOK_SECRET in .env (alerts without it are ignored)
  symbol       BINANCE:BTCUSDT, BTCUSD, BTC, NASDAQ:NVDA, or a Solana token address
  action       buy / long, sell / short, close / exit / flat
               (strategy alerts can send "{{strategy.order.action}}" with "position": "{{strategy.market_position}}")
  venue        optional: "liquid" or "fomo" (default: Solana addresses -> fomo, everything else -> liquid)
  size_usd, stop_pct, stop_price, take_profit_pct, take_profit_price, leverage   all optional
"""
import hmac
import re

from .models import Signal

QUOTE_SUFFIXES = ("USDT.P", "USDC.P", "USD.P", "PERP", ".P", "USDT", "USDC", "BUSD", "USD")
SOLANA_ADDRESS = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
STOCK_EXCHANGES = {"NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "CBOE", "OTC"}


class AlertError(ValueError):
    pass


def normalize_symbol(raw: str, has_market=None) -> tuple[str, str]:
    """-> (venue, symbol). has_market(symbol) -> bool tells which Liquid markets exist."""
    text = raw.strip()
    if SOLANA_ADDRESS.match(text) and not text.isupper():
        return "fomo", text
    exchange, _, ticker = text.upper().rpartition(":")
    ticker = ticker.replace("/", "").replace("-", "")
    if exchange in STOCK_EXCHANGES:
        return "liquid", f"xyz:{ticker}"
    base = ticker
    for suffix in QUOTE_SUFFIXES:
        if base.endswith(suffix) and len(base) > len(suffix):
            base = base[: -len(suffix)]
            break
    if base.startswith("1000") and has_market and has_market("k" + base[4:]):
        return "liquid", "k" + base[4:]  # Hyperliquid names 1000x memecoin contracts kPEPE etc.
    if has_market and not has_market(base) and has_market(f"xyz:{base}"):
        return "liquid", f"xyz:{base}"
    return "liquid", base


def _num(v):
    if v in (None, "", "null"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        raise AlertError(f"not a number: {v!r}")


def parse_alert(body: dict, secret: str | None, cfg: dict, has_market=None) -> Signal:
    if not secret:
        raise AlertError("TV_WEBHOOK_SECRET is not set in .env, so alerts are refused")
    if not hmac.compare_digest(str(body.get("secret", "")), secret):
        raise AlertError("wrong secret")
    action = str(body.get("action", "")).strip().lower()
    position = str(body.get("position", "")).strip().lower()
    if action in ("close", "exit", "flat") or position == "flat":
        action = "close"
    elif action in ("buy", "long"):
        action = "buy"
    elif action in ("sell", "short"):
        action = "sell"
    else:
        raise AlertError(f"unknown action {action!r}")
    if not body.get("symbol"):
        raise AlertError("symbol missing")
    venue, symbol = normalize_symbol(str(body["symbol"]), has_market)
    if body.get("venue") in ("liquid", "fomo"):
        venue = body["venue"]
    # A strategy alert that sells to close a long arrives as "sell" + position "flat"; handled above.
    # On FOMO there is no shorting, so a plain "sell" there means: sell what we hold.
    if venue == "fomo" and action == "sell":
        action = "close"
    tv = cfg["strategies"]["tradingview"]
    return Signal(
        venue=venue, symbol=symbol, action=action, strategy="tradingview", label=str(body.get("label") or symbol.split(":")[-1])[:20],
        size_usd=_num(body.get("size_usd")) or tv["default_size_usd"],
        stop_price=_num(body.get("stop_price")),
        stop_pct=_num(body.get("stop_pct")) or tv["default_stop_loss_pct"],
        take_profit_price=_num(body.get("take_profit_price")),
        take_profit_pct=_num(body.get("take_profit_pct")),
        trailing_stop_pct=_num(body.get("trailing_stop_pct")),
        leverage=_num(body.get("leverage")) or 1,
        close_fraction=min(max(_num(body.get("close_fraction")) or 1.0, 0.0), 1.0),
        reason=str(body.get("comment") or body.get("reason") or "TradingView alert")[:200],
    )
