"""Live trading in your FOMO wallet.

FOMO has no API for bots, but it lets you export the private key of your wallet
(Settings > Account > Export). The bot signs swaps for that same Solana wallet through
Jupiter, the exchange router most Solana apps use, so every trade the bot makes appears in the
FOMO app with your other coins. The key stays in your .env file on your computer and
is only used to sign transactions locally; it is never sent anywhere.
"""
import base64
import json
import time

import base58

from .. import http
from ..config import SOL_MINT, USDC_MINT
from ..data.solana import SolanaData
from ..models import Fill, Position
from .base import Broker

TOKEN_PROGRAMS = ("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PE6qY5sQbqMDwV")


def load_keypair(secret_text: str):
    from solders.keypair import Keypair
    text = secret_text.strip()
    if text.startswith("["):
        return Keypair.from_bytes(bytes(json.loads(text)))
    raw = base58.b58decode(text)
    if len(raw) == 64:
        return Keypair.from_bytes(raw)
    if len(raw) == 32:
        return Keypair.from_seed(raw)
    raise ValueError("FOMO_WALLET_PRIVATE_KEY is not a Solana private key (expected base58 text or a [..] number list)")


def sign_transaction(tx_base64: str, keypair) -> str:
    """Add our signature to the transaction Jupiter built, keeping any signature Jupiter already added."""
    from solders.message import to_bytes_versioned
    from solders.transaction import VersionedTransaction
    tx = VersionedTransaction.from_bytes(base64.b64decode(tx_base64))
    signers = list(tx.message.account_keys)[: tx.message.header.num_required_signatures]
    if keypair.pubkey() not in signers:
        raise ValueError("Jupiter built this swap for a different wallet")
    sigs = list(tx.signatures)
    sigs[signers.index(keypair.pubkey())] = keypair.sign_message(to_bytes_versioned(tx.message))
    return base64.b64encode(bytes(VersionedTransaction.populate(tx.message, sigs))).decode()


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
        self.quote_mint = USDC_MINT if venue_cfg.get("quote", "USDC") == "USDC" else SOL_MINT
        self.entries: dict[str, dict] = (state or {}).get("entries", {})
        self._decimals: dict[str, int] = {USDC_MINT: 6, SOL_MINT: 9}
        self._holdings: tuple[float, dict] = (0, {})
        self._last_error = ""

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

    # ---------- account ----------

    def cash(self) -> float:
        """Spendable quote currency in USD, keeping the SOL fee reserve aside."""
        if self.quote_mint == USDC_MINT:
            return self.holdings().get(USDC_MINT, {}).get("amount", 0.0)
        reserve = self.cfg.get("min_sol_for_fees", 0.02)
        return max(self.sol_balance() - reserve, 0) * self.data.price(SOL_MINT)

    def equity(self) -> float:
        total = self.sol_balance() * self.data.price(SOL_MINT)
        hold = self.holdings()
        total += hold.get(USDC_MINT, {}).get("amount", 0.0)
        mints = [m for m in hold if m not in (USDC_MINT, SOL_MINT)]
        prices = self.data.prices(mints) if mints else {}
        for m in mints:
            total += hold[m]["amount"] * prices.get(m, 0)
        return total

    def positions(self) -> list[Position]:
        hold = self.holdings()
        mints = [m for m in hold if m not in (USDC_MINT, SOL_MINT)]
        prices = self.data.prices(mints) if mints else {}
        out = []
        for m in mints:
            price = prices.get(m)
            if not price or hold[m]["amount"] * price < 1:  # dust and unpriceable tokens are ignored
                continue
            e = self.entries.get(m, {})
            out.append(Position("fomo", m, "long", hold[m]["amount"], e.get("entry_price", price), price,
                                e.get("label", ""), 1.0, e.get("opened_at", 0.0)))
        return out

    # ---------- trading ----------

    def _swap(self, input_mint: str, output_mint: str, amount_raw: int) -> dict:
        params = {"inputMint": input_mint, "outputMint": output_mint, "amount": str(amount_raw), "taker": self.address,
                  "slippageBps": str(int(self.cfg.get("slippage_bps", 300)))}
        try:
            order = http.get(f"{self.jupiter_url}/order", params=params, headers=self.jupiter_headers, timeout=20, retries=1)
        except http.HttpError as e:
            if "slippage" not in str(e).lower():
                raise
            params.pop("slippageBps")
            order = http.get(f"{self.jupiter_url}/order", params=params, headers=self.jupiter_headers, timeout=20, retries=1)
        if not order.get("transaction"):
            raise RuntimeError(order.get("errorMessage") or order.get("error") or "Jupiter could not route this swap")
        signed = sign_transaction(order["transaction"], self.keypair)
        # No retries here: re-sending a swap that might have landed could buy twice.
        result = http.post(f"{self.jupiter_url}/execute", json={"signedTransaction": signed, "requestId": order["requestId"]},
                           headers=self.jupiter_headers, timeout=60, retries=0)
        if result.get("status") != "Success":
            raise RuntimeError(result.get("error") or f"swap failed (code {result.get('code')})")
        self._holdings = (0, {})
        return result

    @staticmethod
    def _amount(result: dict, *keys) -> int:
        for k in keys:
            if result.get(k) not in (None, ""):
                return int(result[k])
        return 0

    def open(self, venue, symbol, side, size_usd, *, leverage=1.0, label="", stop_price=None, take_profit_price=None) -> Fill:
        if side != "long":
            return Fill(False, venue, symbol, error="FOMO tokens can only be bought, not shorted")
        try:
            if self.sol_balance() < self.cfg.get("min_sol_for_fees", 0.02):
                return Fill(False, venue, symbol, error="wallet needs a little SOL to pay network fees")
            if self.cash() < size_usd:
                return Fill(False, venue, symbol, error=f"not enough {self.cfg.get('quote', 'USDC')} in the wallet")
            if self.quote_mint == USDC_MINT:
                amount_in = int(size_usd * 1e6)
            else:
                amount_in = int(size_usd / self.data.price(SOL_MINT) * 1e9)
            result = self._swap(self.quote_mint, symbol, amount_in)
            out_raw = self._amount(result, "outputAmountResult", "totalOutputAmount")
            in_raw = self._amount(result, "inputAmountResult", "totalInputAmount") or amount_in
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
            return Fill(True, venue, symbol, "buy", qty, price, 0.0, tx=result.get("signature", ""), raw=result)
        except Exception as e:
            return Fill(False, venue, symbol, error=str(e))

    def close(self, venue, symbol, fraction=1.0) -> Fill:
        try:
            hold = self.holdings(max_age=0).get(symbol)
            if not hold:
                self.entries.pop(symbol, None)
                return Fill(False, venue, symbol, error="the wallet holds none of this token")
            amount = hold["raw"] if fraction >= 0.999 else int(hold["raw"] * fraction)
            result = self._swap(symbol, self.quote_mint, amount)
            in_raw = self._amount(result, "inputAmountResult", "totalInputAmount") or amount
            out_raw = self._amount(result, "outputAmountResult", "totalOutputAmount")
            qty = in_raw / 10 ** hold["decimals"]
            proceeds = out_raw / 1e6 if self.quote_mint == USDC_MINT else out_raw / 1e9 * self.data.price(SOL_MINT)
            price = proceeds / qty if qty else 0
            e = self.entries.get(symbol, {})
            pnl = (price - e["entry_price"]) * qty if e.get("entry_price") else 0.0
            if fraction >= 0.999:
                self.entries.pop(symbol, None)
            elif e:
                e["qty"] = max(e.get("qty", 0) - qty, 0)
            return Fill(True, venue, symbol, "sell", qty, price, 0.0, pnl, tx=result.get("signature", ""), raw=result)
        except Exception as e:
            return Fill(False, venue, symbol, error=str(e))

    def status(self) -> dict:
        try:
            sol = self.sol_balance()
            return {"name": "fomo", "connected": True, "detail": f"Wallet {self.address[:4]}…{self.address[-4:]}, {sol:.3f} SOL"}
        except Exception as e:
            return {"name": "fomo", "connected": False, "detail": f"Wallet {self.address[:4]}…: {e}"}
