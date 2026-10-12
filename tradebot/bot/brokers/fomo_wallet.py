"""Live trading in your FOMO wallet.

FOMO has no API for bots (its terms forbid bots on its own servers), but it lets you export your
wallet's Solana private key (Settings > Account > Export; Face ID if you turned it on under
Settings > Security). The key is a base58 text of about 88 characters, not the 0x one (that is
FOMO's EVM key). The bot signs swaps for that same Solana wallet through Jupiter's Swap API v2.

The coins the bot buys sit in your FOMO wallet next to your own; FOMO's trade history and PnL
may not list them, because FOMO itself routes most of its trades through DFlow. The bot only
ever sells what it bought, never coins you bought yourself in the app.

The key stays in the .env file on your computer and is only used to sign transactions locally.
"""
import base64
import json
import re
import time

import base58

from .. import http
from ..config import SOL_MINT, USDC_MINT
from ..data.solana import SolanaData
from ..models import Fill, Position
from .base import Broker

TOKEN_PROGRAMS = ("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PE6qY5sQbqMDwV")
# /execute codes that mean "this transaction never landed", so a fresh order is safe
NOT_LANDED = {-1, -2, -3, -1002, -1003, -1004, -2002, -2003, -2004}


def load_keypair(secret_text: str):
    """Reads an exported Solana key: base58 (64-byte secret or 32-byte seed) or a [..] byte list.
    Error messages never include the key itself."""
    from solders.keypair import Keypair
    text = re.sub(r"\s+", "", secret_text or "").strip("\"'")
    if not text:
        raise ValueError("the key is empty")
    if text.startswith("0x") or re.fullmatch(r"[0-9a-fA-F]{64}", text):
        raise ValueError("this looks like FOMO's EVM (0x...) key: paste the Solana key instead")
    if len((secret_text or "").split()) in (12, 24):
        raise ValueError("FOMO exports a Solana private key, not a word phrase")
    try:
        if text.startswith("["):
            raw = bytes(json.loads(text))
        else:
            raw = base58.b58decode(text)
    except Exception:
        raise ValueError("the key is not valid base58 text or a [..] number list") from None
    if len(raw) == 32:
        return Keypair.from_seed(raw)
    if len(raw) != 64:
        raise ValueError(f"a Solana key has 64 bytes (about 88 characters); this one has {len(raw)} bytes")
    try:
        kp = Keypair.from_bytes(raw)
    except Exception:
        raise ValueError("the key's two halves do not match: copy the whole key again") from None
    if bytes(Keypair.from_seed(raw[:32]).pubkey()) != raw[32:]:
        raise ValueError("the key's two halves do not match: copy the whole key again")
    return kp


def sign_transaction(tx_base64: str, keypair) -> str:
    """Add our signature to the transaction Jupiter built, keeping every other signature slot as it is
    (Jupiter's gas sponsor or a market maker may sign too)."""
    from solders.message import to_bytes_versioned
    from solders.transaction import VersionedTransaction
    tx = VersionedTransaction.from_bytes(base64.b64decode(tx_base64))
    signers = list(tx.message.account_keys)[: tx.message.header.num_required_signatures]
    if keypair.pubkey() not in signers:
        raise ValueError("Jupiter built this swap for a different wallet")
    sigs = list(tx.signatures)
    sigs[signers.index(keypair.pubkey())] = keypair.sign_message(to_bytes_versioned(tx.message))
    return base64.b64encode(bytes(VersionedTransaction.populate(tx.message, sigs))).decode()


class SwapUncertain(RuntimeError):
    """The swap may or may not have landed; the caller must check the wallet, not re-buy."""


class FomoWalletBroker(Broker):
    name = "fomo"
    venues = ("fomo",)
    supports_short = False

    def __init__(self, venue_cfg: dict, data: SolanaData, private_key: str, rpc_url: str | None = None,
                 jupiter_key: str | None = None, state: dict | None = None):
        self.cfg = venue_cfg
        self.data = data
        self.keypair = load_keypair(private_key)
        self.address = str(self.keypair.pubkey())
        self.rpc_url = rpc_url or venue_cfg["rpc_url"]
        self.jupiter_url = venue_cfg["jupiter_url"].rstrip("/")
        self.jupiter_headers = {"x-api-key": jupiter_key} if jupiter_key else {}
        # Jupiter allows 0.5 requests/second without a key, 1/second on a free key
        http.MIN_INTERVAL["api.jup.ag"] = 1.05 if jupiter_key else 2.1
        self.quote_mint = USDC_MINT if venue_cfg.get("quote", "USDC") == "USDC" else SOL_MINT
        self.entries: dict[str, dict] = (state or {}).get("entries", {})
        self._decimals: dict[str, int] = {USDC_MINT: 6, SOL_MINT: 9}
        self._holdings: tuple[float, dict] = (0, {})

    def to_state(self) -> dict:
        return {"entries": self.entries}

    # ---------- Solana RPC ----------

    def _rpc(self, method: str, params: list):
        raw = http.post(self.rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=20)
        if raw.get("error"):
            raise http.HttpError(f"Solana RPC {method}: {raw['error']}")
        return raw["result"]

    def sol_balance(self) -> float:
        return self._rpc("getBalance", [self.address, {"commitment": "confirmed"}])["value"] / 1e9

    def holdings(self, max_age: float = 5.0) -> dict[str, dict]:
        """mint -> {"raw": int, "decimals": int, "amount": float} for every token in the wallet."""
        if time.time() - self._holdings[0] < max_age:
            return self._holdings[1]
        out = {}
        for program in TOKEN_PROGRAMS:
            res = self._rpc("getTokenAccountsByOwner", [self.address, {"programId": program}, {"encoding": "jsonParsed", "commitment": "confirmed"}])
            for acct in res.get("value", []):
                info = acct["account"]["data"]["parsed"]["info"]
                amt = info["tokenAmount"]
                raw = int(amt["amount"])
                if raw <= 0:
                    continue
                mint = info["mint"]
                row = out.setdefault(mint, {"raw": 0, "decimals": int(amt["decimals"]), "amount": 0.0})
                row["raw"] += raw
                row["amount"] = row["raw"] / 10 ** row["decimals"]
                self._decimals[mint] = row["decimals"]
        self._holdings = (time.time(), out)
        return out

    def decimals(self, mint: str) -> int:
        if mint not in self._decimals:
            self._decimals[mint] = int(self._rpc("getTokenSupply", [mint])["value"]["decimals"])
        return self._decimals[mint]

    def _bot_qty(self, mint: str, wallet_amount: float) -> float:
        """How much of a token is the bot's: what it bought, never more than the wallet holds."""
        e = self.entries.get(mint)
        if not e or not e.get("qty"):
            return 0.0
        return min(wallet_amount, e["qty"])

    # ---------- account ----------

    def cash(self) -> float:
        """Spendable quote currency in USD, keeping the SOL fee reserve aside."""
        if self.quote_mint == USDC_MINT:
            return self.holdings().get(USDC_MINT, {}).get("amount", 0.0)
        reserve = self.cfg.get("min_sol_for_fees", 0.02)
        return max(self.sol_balance() - reserve, 0) * self.data.price(SOL_MINT)

    def equity(self) -> float:
        """SOL + USDC + the bot's own positions. Coins you bought yourself in FOMO are left out, so
        your own trading never trips the bot's loss limits."""
        total = self.sol_balance() * self.data.price(SOL_MINT)
        hold = self.holdings()
        total += hold.get(USDC_MINT, {}).get("amount", 0.0)
        mine = [m for m in self.entries if m in hold]
        prices = self.data.prices(mine) if mine else {}
        for m in mine:
            total += self._bot_qty(m, hold[m]["amount"]) * prices.get(m, 0)
        return total

    def positions(self) -> list[Position]:
        """Only the bot's own positions (your other FOMO coins are not the bot's business)."""
        hold = self.holdings()
        mints = [m for m in self.entries if m in hold]
        prices = self.data.prices(mints) if mints else {}
        out = []
        for m in mints:
            price = prices.get(m)
            qty = self._bot_qty(m, hold[m]["amount"])
            if not price or qty * price < 0.5:  # dust and unpriceable tokens are ignored
                continue
            e = self.entries[m]
            out.append(Position("fomo", m, "long", qty, e.get("entry_price", price), price,
                                e.get("label", ""), 1.0, e.get("opened_at", 0.0)))
        return out

    # ---------- trading ----------

    def _order(self, input_mint: str, output_mint: str, amount_raw: int) -> dict:
        params = {"inputMint": input_mint, "outputMint": output_mint, "amount": str(amount_raw), "taker": self.address}
        if self.cfg.get("slippage_bps") is not None:
            params["slippageBps"] = str(int(self.cfg["slippage_bps"]))   # otherwise Jupiter estimates slippage itself
        order = http.get(f"{self.jupiter_url}/order", params=params, headers=self.jupiter_headers, timeout=20, retries=1)
        if not order.get("transaction"):
            code = order.get("errorCode")
            why = {1: "not enough balance for this swap", 2: "not enough SOL to pay the network fee: send about 0.05 SOL to "
                   f"{self.address}", 3: "swap too small for Jupiter to pay the gas: send about 0.05 SOL to " + self.address}.get(code)
            raise RuntimeError(why or order.get("errorMessage") or order.get("error") or "Jupiter could not route this swap")
        # guards before we sign anything
        if int(order.get("transactionVersion") or 0) != 0:
            raise RuntimeError("Jupiter returned an unexpected transaction version; not signing")
        impact = float(order.get("priceImpact") or 0)
        if impact < -abs(self.cfg.get("max_price_impact_pct", 3.0)):
            raise RuntimeError(f"price impact {impact:.2f}% is too high for this pool; not trading")
        if order.get("prioritizationFeePayer") in (None, self.address):
            fee = int(order.get("prioritizationFeeLamports") or 0)
            if fee > self.cfg.get("max_priority_fee_lamports", 2_000_000):
                raise RuntimeError(f"network priority fee {fee / 1e9:.4f} SOL is unusually high; not trading")
        return order

    def _network_fee_usd(self, order: dict) -> float:
        lamports = 0
        for k in ("signatureFee", "prioritizationFee", "rentFee"):
            if order.get(f"{k}Payer") in (None, self.address):
                lamports += int(order.get(f"{k}Lamports") or 0)
        try:
            return lamports / 1e9 * self.data.price(SOL_MINT)
        except Exception:
            return 0.0

    def _execute(self, order: dict) -> dict:
        """Sends the signed swap. Re-sending the SAME signed transaction can never execute twice, so
        network errors are retried with it for up to ~110 s; a 4xx answer is final."""
        body = {"signedTransaction": sign_transaction(order["transaction"], self.keypair), "requestId": order["requestId"]}
        deadline = time.time() + self.cfg.get("execute_retry_seconds", 110)
        last = None
        while time.time() < deadline:
            try:
                result = http.post(f"{self.jupiter_url}/execute", json=body, headers=self.jupiter_headers, timeout=60, retries=0)
            except http.HttpError as e:
                if "could not be reached" not in str(e):
                    raise RuntimeError(f"Jupiter refused the swap: {e}") from None
                last = e
                time.sleep(3)
                continue
            if result.get("status") == "Success":
                return result
            code = result.get("code")
            msg = f"swap failed (code {code}{', tx ' + result['signature'] if result.get('signature') else ''}): {result.get('error') or ''}"
            if code in NOT_LANDED:
                raise RuntimeError(msg)
            raise SwapUncertain(msg)
        raise SwapUncertain(f"no answer from Jupiter: {last}")

    @staticmethod
    def _amount(result: dict, *keys) -> int:
        for k in keys:
            if result.get(k) not in (None, ""):
                return int(result[k])
        return 0

    def _reconcile_buy(self, symbol: str, before: int | None, label: str, spent_usd: float) -> Fill | None:
        """After an uncertain buy: if the wallet holds more of the token than before, it landed."""
        time.sleep(5)
        now = self.holdings(max_age=0).get(symbol, {})
        got = now.get("raw", 0) - (before or 0)
        if got <= 0:
            return None
        qty = got / 10 ** now["decimals"]
        price = spent_usd / qty
        self.entries[symbol] = {"entry_price": price, "qty": qty + self.entries.get(symbol, {}).get("qty", 0),
                                "label": label, "opened_at": time.time()}
        return Fill(True, "fomo", symbol, "buy", qty, price, 0.0, tx="(confirmed from the wallet balance)")

    def _reconcile_sell(self, symbol: str, before_raw: int, amount: int, decimals: int, fraction: float) -> Fill | None:
        """After an uncertain sale: if the wallet holds less of the token than before, it landed. Without
        this, the next loop would sell the same amount again and could eat into coins you bought yourself."""
        time.sleep(5)
        now_raw = self.holdings(max_age=0).get(symbol, {}).get("raw", 0)
        sold = before_raw - now_raw
        if sold < amount * 0.9:
            return None
        e = self.entries.get(symbol, {})
        qty = min(sold, amount) / 10 ** decimals
        try:
            price = self.data.price(symbol)
        except Exception:
            price = e.get("entry_price", 0.0)
        pnl = (price - e["entry_price"]) * qty if e.get("entry_price") else 0.0
        if fraction >= 0.999:
            self.entries.pop(symbol, None)
        elif e:
            e["qty"] = max(e.get("qty", 0) - qty, 0)
        return Fill(True, "fomo", symbol, "sell", qty, price, 0.0, pnl, tx="(confirmed from the wallet balance; price estimated)")

    def open(self, venue, symbol, side, size_usd, *, leverage=1.0, label="", stop_price=None, take_profit_price=None) -> Fill:
        if side != "long":
            return Fill(False, venue, symbol, error="FOMO tokens can only be bought, not shorted")
        before = None
        try:
            if self.cash() < size_usd:
                return Fill(False, venue, symbol, error=f"not enough {self.cfg.get('quote', 'USDC')} in the wallet")
            if self.quote_mint == USDC_MINT:
                amount_in = int(size_usd * 1e6)
            else:
                amount_in = int(size_usd / self.data.price(SOL_MINT) * 1e9)
            sol = self.sol_balance()
            order_check = None
            if sol < self.cfg.get("min_sol_for_fees", 0.02):
                # FOMO pays gas inside its own app, so its wallets often hold no SOL. Jupiter can sponsor
                # gas on swaps of about $10+; otherwise the wallet needs a little SOL.
                order_check = self._order(self.quote_mint, symbol, amount_in)
                if not order_check.get("gasless"):
                    return Fill(False, venue, symbol, error=f"the wallet needs about 0.05 SOL for network fees: send it to {self.address}")
            before = self.holdings(max_age=0).get(symbol, {}).get("raw", 0)
            order = order_check or self._order(self.quote_mint, symbol, amount_in)
            result = self._execute(order)
            self._holdings = (0, {})
            out_raw = self._amount(result, "totalOutputAmount", "outputAmountResult")
            in_raw = self._amount(result, "totalInputAmount", "inputAmountResult") or amount_in
            qty = out_raw / 10 ** self.decimals(symbol)
            spent = in_raw / 1e6 if self.quote_mint == USDC_MINT else in_raw / 1e9 * self.data.price(SOL_MINT)
            if qty <= 0:
                return Fill(False, venue, symbol, error="swap reported no tokens received", tx=result.get("signature", ""))
            price = spent / qty
            e = self.entries.get(symbol)
            if e:
                total = e["qty"] + qty
                e.update(entry_price=(e["entry_price"] * e["qty"] + price * qty) / total, qty=total)
            else:
                self.entries[symbol] = {"entry_price": price, "qty": qty, "label": label, "opened_at": time.time()}
            return Fill(True, venue, symbol, "buy", qty, price, self._network_fee_usd(order), tx=result.get("signature", ""), raw=result)
        except SwapUncertain as e:
            fill = None
            try:
                fill = self._reconcile_buy(symbol, before, label, size_usd)
            except Exception:
                pass
            return fill or Fill(False, venue, symbol, error=f"{e}. Check the wallet in FOMO before trading this token again.")
        except Exception as e:
            return Fill(False, venue, symbol, error=str(e))

    def close(self, venue, symbol, fraction=1.0) -> Fill:
        try:
            hold = self.holdings(max_age=0).get(symbol)
            e = self.entries.get(symbol, {})
            if not hold or not e:
                self.entries.pop(symbol, None)
                return Fill(False, venue, symbol, error="the wallet holds none of this token")
            mine_raw = min(hold["raw"], int(round(e.get("qty", 0) * 10 ** hold["decimals"])))
            amount = mine_raw if fraction >= 0.999 else int(mine_raw * fraction)
            if amount <= 0:
                self.entries.pop(symbol, None)
                return Fill(False, venue, symbol, error="no tokens left to sell")
            order = self._order(symbol, self.quote_mint, amount)
            result = self._execute(order)
            self._holdings = (0, {})
            in_raw = self._amount(result, "totalInputAmount", "inputAmountResult") or amount
            out_raw = self._amount(result, "totalOutputAmount", "outputAmountResult")
            qty = in_raw / 10 ** hold["decimals"]
            proceeds = out_raw / 1e6 if self.quote_mint == USDC_MINT else out_raw / 1e9 * self.data.price(SOL_MINT)
            price = proceeds / qty if qty else 0
            fee = self._network_fee_usd(order)
            pnl = (price - e["entry_price"]) * qty - fee if e.get("entry_price") else 0.0
            if fraction >= 0.999:
                self.entries.pop(symbol, None)
            else:
                e["qty"] = max(e.get("qty", 0) - qty, 0)
            return Fill(True, venue, symbol, "sell", qty, price, fee, pnl, tx=result.get("signature", ""), raw=result)
        except SwapUncertain as e:
            fill = None
            try:
                fill = self._reconcile_sell(symbol, hold["raw"], amount, hold["decimals"], fraction)
            except Exception:
                pass
            return fill or Fill(False, venue, symbol, error=f"{e}. The sale did not show up in the wallet; the bot tries again next loop.")
        except Exception as e:
            return Fill(False, venue, symbol, error=str(e))

    def status(self) -> dict:
        try:
            sol = self.sol_balance()
            return {"name": "fomo", "connected": True, "detail": f"Wallet {self.address[:4]}…{self.address[-4:]}, {sol:.3f} SOL"}
        except Exception as e:
            return {"name": "fomo", "connected": False, "detail": f"Wallet {self.address[:4]}…: {e}"}
