"""The FOMO wallet broker against a fake Solana RPC and a fake Jupiter (no network, no money)."""
import base64

import base58
import pytest
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from bot import http as http_mod
from bot.brokers import fomo_wallet as fw
from bot.config import DEFAULTS, SOL_MINT, USDC_MINT

MEME = "Meme111111111111111111111111111111111111111"


def unsigned_tx(*signers):
    ix = Instruction(Pubkey.default(), b"\x01", [AccountMeta(s.pubkey(), True, True) for s in signers])
    msg = MessageV0.try_compile(signers[0].pubkey(), [ix], [], Hash.default())
    return base64.b64encode(bytes(VersionedTransaction.populate(msg, [Signature.default()] * len(signers)))).decode()


class FakeChain:
    def __init__(self, kp, sol=0.05, usdc=100.0, meme_raw=0, user_meme_raw=0):
        self.kp = kp
        self.sol, self.usdc = sol, usdc
        self.meme_raw = meme_raw + user_meme_raw
        self.execute_mode = "ok"      # ok | timeout_landed | timeout_lost
        self.orders, self.executes = [], 0
        self.gasless = False

    def post(self, url, json=None, **kw):
        if "execute" in url:
            self.executes += 1
            order = self.orders[-1]
            if self.execute_mode.startswith("timeout"):
                if self.execute_mode == "timeout_landed":
                    self._settle(order)
                self.execute_mode = "dead"
                raise http_mod.HttpError("api.jup.ag could not be reached: timeout")
            if self.execute_mode == "dead":
                raise http_mod.HttpError("api.jup.ag could not be reached: timeout")
            self._settle(order)
            return {"status": "Success", "signature": "sig1", "code": 0, "totalInputAmount": str(order["in"]),
                    "totalOutputAmount": str(order["out"]), "inputAmountResult": str(order["in"] - 1000),
                    "outputAmountResult": str(order["out"] + 5000)}
        method = json["method"]
        if method == "getBalance":
            return {"result": {"value": int(self.sol * 1e9)}}
        if method == "getTokenSupply":
            return {"result": {"value": {"decimals": 6}}}
        if method == "getTokenAccountsByOwner":
            if json["params"][1]["programId"] != fw.TOKEN_PROGRAMS[0]:
                return {"result": {"value": []}}
            rows = [(USDC_MINT, int(self.usdc * 1e6))] + ([(MEME, self.meme_raw)] if self.meme_raw else [])
            return {"result": {"value": [{"account": {"data": {"parsed": {"info": {"mint": m, "tokenAmount": {"amount": str(r), "decimals": 6}}}}}} for m, r in rows]}}
        raise AssertionError(method)

    def _settle(self, order):
        if order["inputMint"] == USDC_MINT:
            self.usdc -= order["in"] / 1e6
            self.meme_raw += order["out"]
        else:
            self.meme_raw -= order["in"]
            self.usdc += order["out"] / 1e6

    def get(self, url, params=None, headers=None, **kw):
        amount = int(params["amount"])
        out = amount * 1000 if params["inputMint"] == USDC_MINT else amount // 1000
        order = {"inputMint": params["inputMint"], "in": amount, "out": out}
        self.orders.append(order)
        return {"transaction": unsigned_tx(self.kp), "requestId": f"r{len(self.orders)}", "outAmount": str(out),
                "transactionVersion": 0, "priceImpact": -0.2, "gasless": self.gasless,
                "signatureFeeLamports": 5000, "signatureFeePayer": str(self.kp.pubkey()), "prioritizationFeeLamports": 10000}


class Prices:
    def price(self, mint):
        return {SOL_MINT: 150.0, USDC_MINT: 1.0}.get(mint, 0.001)

    def prices(self, mints, max_age=10):
        return {m: self.price(m) for m in mints}


@pytest.fixture
def setup(monkeypatch):
    kp = Keypair()
    chain = FakeChain(kp)
    monkeypatch.setattr(http_mod, "post", chain.post)
    monkeypatch.setattr(http_mod, "get", chain.get)
    monkeypatch.setattr(fw.time, "sleep", lambda s: None)
    broker = fw.FomoWalletBroker({**DEFAULTS["venues"]["fomo"], "execute_retry_seconds": 0.05}, Prices(), base58.b58encode(bytes(kp)).decode())
    return broker, chain


def test_buy_and_sell_use_wallet_amounts_and_count_fees(setup):
    broker, chain = setup
    f = broker.open("fomo", MEME, "long", 25.0, label="MEME")
    assert f.ok and f.qty == pytest.approx(25_000)          # totalOutputAmount, not outputAmountResult
    assert f.price == pytest.approx(0.001) and f.fee_usd > 0
    f2 = broker.close("fomo", MEME)
    assert f2.ok and f2.qty == pytest.approx(25_000)
    assert MEME not in broker.entries


def test_never_sells_coins_you_bought_yourself(setup, monkeypatch):
    broker, chain = setup
    chain.meme_raw = 7_000 * 10 ** 6                        # you already hold 7,000 MEME
    broker.open("fomo", MEME, "long", 25.0)
    pos = broker.positions()
    assert len(pos) == 1 and pos[0].qty == pytest.approx(25_000)   # only the bot's part
    broker.close("fomo", MEME)
    assert chain.orders[-1]["in"] == 25_000 * 10 ** 6       # sold exactly what the bot bought
    assert chain.meme_raw == 7_000 * 10 ** 6
    assert broker.positions() == []


def test_uncertain_swap_is_reconciled_from_the_wallet_not_rebought(setup):
    broker, chain = setup
    chain.execute_mode = "timeout_landed"
    f = broker.open("fomo", MEME, "long", 25.0)
    assert f.ok and "wallet balance" in f.tx and f.qty == pytest.approx(25_000)
    assert len(chain.orders) == 1                           # no second order


def test_uncertain_swap_that_did_not_land_reports_failure(setup):
    broker, chain = setup
    chain.execute_mode = "timeout_lost"
    f = broker.open("fomo", MEME, "long", 25.0)
    assert not f.ok and "Check the wallet" in f.error and len(chain.orders) == 1


def test_uncertain_sale_that_landed_is_not_sold_again(setup):
    broker, chain = setup
    chain.meme_raw = 7_000 * 10 ** 6                        # your own 7,000 MEME
    broker.open("fomo", MEME, "long", 25.0)
    chain.execute_mode = "timeout_landed"
    f = broker.close("fomo", MEME)
    assert f.ok and f.qty == pytest.approx(25_000) and MEME not in broker.entries
    chain.execute_mode = "ok"
    assert not broker.close("fomo", MEME).ok                # nothing left that is the bot's
    assert chain.meme_raw == 7_000 * 10 ** 6                # your coins untouched


def test_uncertain_sale_that_did_not_land_keeps_the_position(setup):
    broker, chain = setup
    broker.open("fomo", MEME, "long", 25.0)
    chain.execute_mode = "timeout_lost"
    f = broker.close("fomo", MEME)
    assert not f.ok and broker.entries[MEME]["qty"] == pytest.approx(25_000)


def test_no_sol_needs_gasless_or_explains(setup):
    broker, chain = setup
    chain.sol = 0.0
    f = broker.open("fomo", MEME, "long", 25.0)
    assert not f.ok and broker.address in f.error and "SOL" in f.error
    chain.gasless = True
    assert broker.open("fomo", MEME, "long", 25.0).ok


def test_guards_refuse_bad_swaps(setup, monkeypatch):
    broker, chain = setup
    orig = chain.get
    monkeypatch.setattr(http_mod, "get", lambda *a, **k: {**orig(*a, **k), "priceImpact": -12.5})
    f = broker.open("fomo", MEME, "long", 25.0)
    assert not f.ok and "price impact" in f.error and chain.executes == 0


def test_signing_leaves_other_signers_alone():
    taker, sponsor = Keypair(), Keypair()
    signed = VersionedTransaction.from_bytes(base64.b64decode(fw.sign_transaction(unsigned_tx(sponsor, taker), taker)))
    assert signed.verify_with_results() == [False, True]
    assert signed.signatures[0] == Signature.default()


def test_key_reading():
    kp = Keypair()
    assert fw.load_keypair("  " + base58.b58encode(bytes(kp)).decode() + "\n").pubkey() == kp.pubkey()
    assert fw.load_keypair(base58.b58encode(bytes(kp)[:32]).decode()).pubkey() == kp.pubkey()
    with pytest.raises(ValueError, match="EVM"):
        fw.load_keypair("0x" + "ab" * 32)
    with pytest.raises(ValueError, match="phrase"):
        fw.load_keypair(" ".join(["word"] * 12))
    bad = bytes(kp)[:32] + bytes(Keypair().pubkey())
    with pytest.raises(ValueError, match="halves") as e:
        fw.load_keypair(base58.b58encode(bad).decode())
    assert base58.b58encode(bad).decode() not in str(e.value)
