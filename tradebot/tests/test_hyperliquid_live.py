"""The Liquid (Hyperliquid) broker against a fake exchange: no network, no money."""
from bot.brokers.hyperliquid_live import HyperliquidBroker
from bot.config import DEFAULTS

OK = {"status": "ok", "response": {"data": {"statuses": [{"resting": {"oid": 2}}]}}}


class FakeData:
    def market(self, symbol):
        return {"maxLeverage": 10, "onlyIsolated": False, "szDecimals": 0}

    def price(self, symbol):
        return 0.5


class FakeExchange:
    def __init__(self, trigger_answer):
        self.trigger_answer = trigger_answer
        self.orders = []

    def update_leverage(self, lev, symbol, cross):
        return {"status": "ok", "response": {"data": {"statuses": []}}}

    def market_open(self, symbol, is_buy, qty, px, slippage):
        return {"status": "ok", "response": {"data": {"statuses": [{"filled": {"totalSz": str(qty), "avgPx": "0.501", "oid": 1}}]}}}

    def order(self, *a, **k):
        self.orders.append(a)
        if isinstance(self.trigger_answer, Exception):
            raise self.trigger_answer
        return self.trigger_answer


def broker(answer):
    return HyperliquidBroker(DEFAULTS["venues"]["liquid"], FakeData(), "0x" + "1" * 40, "", exchange=FakeExchange(answer))


def test_entry_with_exchange_stop():
    f = broker(OK).open("liquid", "WIF", "long", 25, stop_price=0.45, take_profit_price=0.6)
    assert f.ok and f.qty == 50 and f.price == 0.501 and not f.error


def test_filled_entry_stays_owned_when_the_stop_order_fails():
    for answer in ({"status": "ok", "response": {"data": {"statuses": [{"error": "Order price too far"}]}}}, RuntimeError("timeout")):
        f = broker(answer).open("liquid", "WIF", "short", 25, stop_price=0.55)
        assert f.ok and f.side == "sell" and f.qty == 50       # the position exists: the bot must own it
        assert "stop-loss" in f.error and "watches" in f.error
