"""Venue code tested against fakes: TradingView alerts, FOMO screening and signing, Liquid orders, Quiver data."""
import base64
from datetime import date

import pytest

from bot.brokers.hyperliquid_live import HyperliquidBroker, round_price, round_size
from bot.data import quiver
from bot.strategies.congress import rank_purchases, sold_by_congress
from bot.strategies.fomo_momentum import screen_pair
from bot.tradingview import AlertError, normalize_symbol, parse_alert

from .conftest import FakeHL

MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"


# ---------- TradingView ----------

def has(symbol):
    return symbol in {"BTC", "ETH", "kPEPE", "xyz:NVDA", "xyz:TSLA"}


@pytest.mark.parametrize("raw,expected", [
    ("BINANCE:BTCUSDT", ("liquid", "BTC")),
    ("BYBIT:ETHUSDT.P", ("liquid", "ETH")),
    ("BTCUSD", ("liquid", "BTC")),
    ("NASDAQ:NVDA", ("liquid", "xyz:NVDA")),
    ("TSLA", ("liquid", "xyz:TSLA")),
    ("BINANCE:1000PEPEUSDT", ("liquid", "kPEPE")),
    (MINT, ("fomo", MINT)),
])
def test_symbol_normalization(raw, expected):
    assert normalize_symbol(raw, has) == expected


def test_alert_parsing(cfg):
    sig = parse_alert({"secret": "s3", "symbol": "BINANCE:BTCUSDT", "action": "long", "stop_pct": "3", "size_usd": 40}, "s3", cfg, has)
    assert (sig.venue, sig.symbol, sig.action, sig.stop_pct, sig.size_usd) == ("liquid", "BTC", "buy", 3.0, 40.0)
    sig = parse_alert({"secret": "s3", "symbol": "ETHUSDT", "action": "sell", "position": "flat"}, "s3", cfg, has)
    assert sig.action == "close"
    sig = parse_alert({"secret": "s3", "symbol": MINT, "action": "sell"}, "s3", cfg, has)
    assert (sig.venue, sig.action) == ("fomo", "close")
    with pytest.raises(AlertError, match="wrong secret"):
        parse_alert({"secret": "nope", "symbol": "BTC", "action": "buy"}, "s3", cfg, has)
    with pytest.raises(AlertError, match="not set"):
        parse_alert({"secret": "", "symbol": "BTC", "action": "buy"}, None, cfg, has)
    with pytest.raises(AlertError, match="unknown action"):
        parse_alert({"secret": "s3", "symbol": "BTC", "action": "moon"}, "s3", cfg, has)


# ---------- FOMO momentum screen ----------

def good_pair(now_ms, **over):
    p = {"priceUsd": "0.01", "liquidity": {"usd": 200000}, "volume": {"h1": 120000, "h24": 900000},
         "priceChange": {"m5": 1.2, "h1": 12}, "txns": {"h1": {"buys": 600, "sells": 400}},
         "marketCap": 4_000_000, "pairCreatedAt": now_ms - 30 * 3_600_000, "baseToken": {"symbol": "MEME"}}
    p.update(over)
    return p


def test_fomo_screen(cfg):
    p = cfg["strategies"]["fomo_momentum"]
    now = 1_800_000_000_000
    ok, why, score = screen_pair(good_pair(now), p, now)
    assert ok and score > 0
    assert not screen_pair(good_pair(now, pairCreatedAt=now - 1_800_000), p, now)[0]          # 30 minutes old
    assert not screen_pair(good_pair(now, liquidity={"usd": 5000}), p, now)[0]                 # thin liquidity
    assert not screen_pair(good_pair(now, priceChange={"m5": 2, "h1": 250}), p, now)[0]       # vertical pump
    assert not screen_pair(good_pair(now, txns={"h1": {"buys": 100, "sells": 300}}), p, now)[0]  # sellers win


# ---------- Quiver / congress ----------

def test_quiver_parse_and_rank():
    rows = [
        {"Representative": "A", "Ticker": "NVDA", "Transaction": "Purchase", "Range": "$15,001 - $50,000", "ReportDate": "2026-10-08", "TransactionDate": "2026-09-01"},
        {"Representative": "B", "Ticker": "NVDA", "Transaction": "Purchase", "Amount": "50001", "ReportDate": "2026-10-09", "TransactionDate": "2026-09-20"},
        {"Name": "C", "Ticker": "AAPL", "Transaction": "Sale (Full)", "Trade_Size_USD": "1001", "Filed": "2026-10-09", "Traded": "2026-10-01"},
        {"Name": "D", "Ticker": "AAPL", "Transaction": "Sale (Partial)", "Trade_Size_USD": "1001", "Filed": "2026-10-10", "Traded": "2026-10-02"},
        {"Representative": "E", "Ticker": "TSLA", "Transaction": "Purchase", "Range": "$1,001 - $15,000", "ReportDate": "2026-10-10", "TransactionDate": "2026-10-01"},
        {"Representative": "F", "Ticker": "MSFT", "Transaction": "Purchase", "Range": "$15,001 - $50,000", "ReportDate": "2026-12-01", "TransactionDate": "2026-10-01"},
        {"Representative": "G", "Ticker": "XYZW", "TickerType": "OP", "Transaction": "Purchase", "ReportDate": "2026-10-10", "TransactionDate": "2026-10-01"},
    ]
    trades = quiver.parse(rows)
    assert len(trades) == 6 and trades[0].amount_usd == 15001
    ranked = rank_purchases(trades, date(2026, 10, 12), 10, 15001, 1)
    # NVDA (2 buyers) first; TSLA below the size floor; MSFT not reported yet (no look-ahead)
    assert [r["ticker"] for r in ranked] == ["NVDA"]
    assert sold_by_congress(trades, date(2026, 10, 12), 10) == {"AAPL"}


# ---------- FOMO wallet signing ----------

def test_sign_transaction_places_our_signature():
    from solders.hash import Hash
    from solders.instruction import AccountMeta, Instruction
    from solders.keypair import Keypair
    from solders.message import MessageV0
    from solders.pubkey import Pubkey
    from solders.signature import Signature
    from solders.transaction import VersionedTransaction
    from bot.brokers.fomo_wallet import load_keypair, sign_transaction
    import base58
    kp = Keypair()
    ix = Instruction(Pubkey.default(), b"\x01", [AccountMeta(kp.pubkey(), True, True)])
    msg = MessageV0.try_compile(kp.pubkey(), [ix], [], Hash.default())
    unsigned = VersionedTransaction.populate(msg, [Signature.default()])
    signed_b64 = sign_transaction(base64.b64encode(bytes(unsigned)).decode(), kp)
    tx = VersionedTransaction.from_bytes(base64.b64decode(signed_b64))
    assert tx.verify_with_results() == [True]
    # both export formats load the same wallet
    assert load_keypair(base58.b58encode(bytes(kp)).decode()).pubkey() == kp.pubkey()
    assert load_keypair(str(list(bytes(kp)))).pubkey() == kp.pubkey()
    with pytest.raises(ValueError):
        sign_transaction(base64.b64encode(bytes(unsigned)).decode(), Keypair())


# ---------- Liquid / Hyperliquid ----------

class FakeExchange:
    def __init__(self, fill=True):
        self.calls = []
        self.fill = fill

    def update_leverage(self, lev, name, is_cross=True):
        self.calls.append(("leverage", name, lev, is_cross))
        return {"status": "ok", "response": {"type": "default"}}

    def market_open(self, name, is_buy, sz, px=None, slippage=0.01):
        self.calls.append(("open", name, is_buy, sz))
        if not self.fill:
            return {"status": "ok", "response": {"type": "order", "data": {"statuses": [{"error": "Insufficient margin"}]}}}
        return {"status": "ok", "response": {"type": "order", "data": {"statuses": [{"filled": {"totalSz": str(sz), "avgPx": "60010", "oid": 7}}]}}}

    def order(self, name, is_buy, sz, limit_px, order_type, reduce_only=False):
        self.calls.append(("trigger", name, is_buy, sz, limit_px, order_type, reduce_only))
        return {"status": "ok", "response": {"type": "order", "data": {"statuses": [{"resting": {"oid": 8}}]}}}


def test_hyperliquid_open_places_exchange_stop(cfg):
    ex = FakeExchange()
    b = HyperliquidBroker(cfg["venues"]["liquid"], FakeHL(), "0xabc", "unused", exchange=ex)
    f = b.open("liquid", "BTC", "long", 120, leverage=3, stop_price=57000.123, take_profit_price=66000)
    assert f.ok and f.price == 60010 and f.qty == pytest.approx(0.002)
    kinds = [c[0] for c in ex.calls]
    assert kinds == ["leverage", "open", "trigger", "trigger"]
    sl = ex.calls[2]
    assert sl[2] is False and sl[6] is True and sl[5]["trigger"]["tpsl"] == "sl" and sl[5]["trigger"]["triggerPx"] == 57000
    assert ex.calls[0][3] is True                          # main markets: cross margin
    b.open("liquid", "xyz:NVDA", "short", 50)
    assert ex.calls[-2][3] is False                        # stock markets: isolated margin


def test_hyperliquid_reports_errors(cfg):
    b = HyperliquidBroker(cfg["venues"]["liquid"], FakeHL(), "0xabc", "unused", exchange=FakeExchange(fill=False))
    f = b.open("liquid", "BTC", "long", 120)
    assert not f.ok and "Insufficient margin" in f.error
    assert not b.open("liquid", "BTC", "long", 1).ok      # rounds to zero size


def test_rounding():
    assert round_size(0.123456, 3) == 0.123
    assert round_price(1234.5678, 2) == 1234.6
    assert round_price(0.000123456, 0) == 0.000123
    assert round_price(123456.7, 5) == 123457


def test_moving_the_stop_keeps_the_take_profit(cfg):
    ex = FakeExchange()
    ex.cancelled = []
    ex.cancel = lambda name, oid: ex.cancelled.append(oid)
    hl = FakeHL()
    hl.open_orders = lambda addr, dex="": [
        {"coin": "BTC", "oid": 1, "orderType": "Stop Market", "reduceOnly": True},
        {"coin": "BTC", "oid": 2, "orderType": "Take Profit Market", "reduceOnly": True},
        {"coin": "ETH", "oid": 3, "orderType": "Stop Market", "reduceOnly": True}]
    hl.user_state = lambda addr, dex="": {"assetPositions": [{"position": {"coin": "BTC", "szi": "0.002", "entryPx": "60000", "positionValue": "122", "leverage": {"value": 3}}}]}
    b = HyperliquidBroker(cfg["venues"]["liquid"], hl, "0xabc", "unused", exchange=ex)
    b.update_stop("liquid", "BTC", 60500)
    assert ex.cancelled == [1]
    assert ex.calls[-1][0] == "trigger" and ex.calls[-1][5]["trigger"]["tpsl"] == "sl" and ex.calls[-1][3] == 0.002


def test_connection_checks_never_trade_and_explain(monkeypatch):
    from bot import connections, http as http_mod
    from bot.config import DEFAULTS
    from solders.keypair import Keypair
    import base58
    kp = Keypair()
    agent_key = "0x" + "11" * 32
    from eth_account import Account
    agent = Account.from_key(agent_key).address
    account = "0x" + "ab" * 20
    env = {"SOLANA_WALLET_PRIVATE_KEY": base58.b58encode(bytes(kp)).decode(), "JUPITER_API_KEY": "k",
           "HL_ACCOUNT_ADDRESS": account, "HL_API_PRIVATE_KEY": agent_key}
    monkeypatch.setattr(connections, "secret", lambda n: env.get(n))
    calls = []

    def fake_post(url, json=None, **kw):
        calls.append(("POST", url, json.get("method") or json.get("type")))
        if "method" in json:
            if json["method"] == "getBalance":
                return {"result": {"value": 50_000_000}}
            return {"result": {"value": [{"account": {"data": {"parsed": {"info": {"tokenAmount": {"uiAmount": 42.5}}}}}}]}}
        if json["type"] == "clearinghouseState":
            return {"marginSummary": {"accountValue": "100"}}
        if json["type"] == "userRole":
            return {"role": "agent", "data": {"user": account}}
        return [{"address": agent, "validUntil": (time.time() + 30 * 86400) * 1000}]

    def fake_get(url, params=None, headers=None, **kw):
        calls.append(("GET", url, params.get("taker")))
        assert headers == {"x-api-key": "k"}
        return {"outAmount": "6500000", "transaction": None}
    import time
    monkeypatch.setattr(http_mod, "post", fake_post)
    monkeypatch.setattr(http_mod, "get", fake_get)
    fomo = connections.test_fomo(DEFAULTS["venues"]["fomo"])
    assert all(r["ok"] for r in fomo), fomo
    assert str(kp.pubkey()) in fomo[0]["detail"] and "42.50 USDC" in fomo[2]["detail"]
    liq = connections.test_liquid(DEFAULTS["venues"]["liquid"])
    assert all(r["ok"] for r in liq), liq
    assert "approved" in liq[-1]["detail"]
    # quote only: no taker, so Jupiter never builds a transaction we could sign
    assert all(c[2] is None for c in calls if c[0] == "GET")
    env["HL_ACCOUNT_ADDRESS"] = "not-an-address"
    assert connections.test_liquid(DEFAULTS["venues"]["liquid"])[0]["ok"] is False


def test_old_wallet_key_name_still_works(monkeypatch):
    from bot.config import secret
    monkeypatch.delenv("SOLANA_WALLET_PRIVATE_KEY", raising=False)
    monkeypatch.setenv("FOMO_WALLET_PRIVATE_KEY", "old-name-key")
    assert secret("SOLANA_WALLET_PRIVATE_KEY") == "old-name-key"
    monkeypatch.setenv("SOLANA_WALLET_PRIVATE_KEY", "new-name-key")
    assert secret("SOLANA_WALLET_PRIVATE_KEY") == "new-name-key"
