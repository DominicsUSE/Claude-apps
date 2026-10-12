"""Read-only checks of your FOMO wallet and Liquid account: never places a trade.

Run from the dashboard (Connections > Test my connections) or `python run.py check`, right after
pasting your keys, so mistakes show up before any money moves.
"""
import re
import time

from . import http
from .config import SOL_MINT, USDC_MINT, secret


def _row(name: str, ok: bool | None, detail: str) -> dict:
    """ok: True = fine, False = must fix, None = warning / not set."""
    return {"name": name, "ok": ok, "detail": detail}


def test_fomo(venue_cfg: dict) -> list[dict]:
    rows = []
    key = secret("FOMO_WALLET_PRIVATE_KEY")
    if not key:
        return [_row("FOMO wallet key", None, "Not set. In FOMO: Settings > Account > Export, copy the Solana key, paste it above.")]
    try:
        from .brokers.fomo_wallet import load_keypair
        address = str(load_keypair(key).pubkey())
        rows.append(_row("FOMO wallet key", True, f"Wallet {address}. Check it matches the Solana address in your FOMO app."))
    except Exception as e:
        return [_row("FOMO wallet key", False, f"Could not read the key: {e}")]
    rpc = secret("SOLANA_RPC_URL") or venue_cfg["rpc_url"]

    def rpc_call(method, params):
        raw = http.post(rpc, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=20)
        if raw.get("error"):
            raise RuntimeError(raw["error"].get("message", raw["error"]))
        return raw["result"]
    try:
        sol = rpc_call("getBalance", [address, {"commitment": "confirmed"}])["value"] / 1e9
        need = venue_cfg.get("min_sol_for_fees", 0.02)
        rows.append(_row("SOL for network fees", sol >= need or None, f"{sol:.4f} SOL" + ("" if sol >= need else
                         f". FOMO pays gas only inside its own app. Jupiter can cover gas on buys of about $10+, "
                         f"but sells and small trades need SOL: send about 0.05 SOL to {address}")))
        usdc = 0.0
        res = rpc_call("getTokenAccountsByOwner", [address, {"mint": USDC_MINT}, {"encoding": "jsonParsed"}])
        for acct in res.get("value", []):
            usdc += float(acct["account"]["data"]["parsed"]["info"]["tokenAmount"].get("uiAmount") or 0)
        quote = venue_cfg.get("quote", "USDC")
        rows.append(_row("Money to trade with", (usdc > 1) if quote == "USDC" else (sol > need + 0.05),
                         f"{usdc:,.2f} USDC" + (" (the bot buys with USDC: deposit some in FOMO)" if quote == "USDC" and usdc <= 1 else "")))
    except Exception as e:
        rows.append(_row("Solana network", False, f"Could not read the wallet: {e}. A private RPC (SOLANA_RPC_URL, e.g. Helius) helps."))
    jkey = secret("JUPITER_API_KEY")
    url = venue_cfg["jupiter_url"].rstrip("/")
    if not jkey:
        rows.append(_row("Jupiter API key", None, "Not set: swaps still work, at most one request every 2 seconds. "
                         "A free key from developers.jup.ag/portal doubles that."))
    try:
        q = http.get(f"{url}/order", params={"inputMint": USDC_MINT, "outputMint": SOL_MINT, "amount": "1000000"},
                     headers={"x-api-key": jkey} if jkey else {}, timeout=20, retries=1)
        out = q.get("outAmount")
        rows.append(_row("Jupiter swaps", bool(out), f"Price check OK: 1 USDC = {int(out) / 1e9:.5f} SOL" if out
                         else f"Unexpected answer: {str(q)[:160]}"))
    except Exception as e:
        rows.append(_row("Jupiter swaps", False, f"{e}"))
    return rows


def test_liquid(venue_cfg: dict, dexes=("", "xyz")) -> list[dict]:
    rows = []
    account = (secret("HL_ACCOUNT_ADDRESS") or "").strip()
    key = secret("HL_API_PRIVATE_KEY")
    if not account and not key:
        return [_row("Liquid account", None, "Not set. See the Connect Liquid steps below.")]
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", account):
        return [_row("Liquid account address", False, "HL_ACCOUNT_ADDRESS must look like 0x followed by 40 letters/numbers (your Liquid address).")]
    info = venue_cfg["api_url"].rstrip("/") + "/info"
    try:
        value = 0.0
        for dex in dexes:
            st = http.post(info, json={"type": "clearinghouseState", "user": account, **({"dex": dex} if dex else {})})
            value += float(st.get("marginSummary", {}).get("accountValue", 0))
        rows.append(_row("Liquid account", True, f"{account[:6]}…{account[-4:]}, account value ${value:,.2f}"
                         + ("" if value > 0 else " (no USDC on Liquid's trading account yet)")))
    except Exception as e:
        rows.append(_row("Liquid account", False, f"Could not read the account: {e}"))
    if not key:
        rows.append(_row("API wallet", None, "HL_API_PRIVATE_KEY not set: create an API wallet at app.hyperliquid.xyz > More > API."))
        return rows
    try:
        from eth_account import Account
        agent = Account.from_key(key).address
    except Exception as e:
        rows.append(_row("API wallet key", False, f"Could not read the key: {e}"))
        return rows
    if agent.lower() == account.lower():
        rows.append(_row("API wallet", None, "This is your main wallet's key. It works, but an API wallet (which cannot withdraw) is safer."))
        return rows
    try:
        role = http.post(info, json={"type": "userRole", "user": agent})
        master = str(((role or {}).get("data") or {}).get("user", "")).lower()
        if (role or {}).get("role") == "agent" and master == account.lower():
            valid = ""
            try:
                agents = http.post(info, json={"type": "extraAgents", "user": account}) or []
                mine = next((a for a in agents if str(a.get("address", "")).lower() == agent.lower()), None)
                if mine and mine.get("validUntil"):
                    days = (mine["validUntil"] / 1000 - time.time()) / 86400
                    valid = f", valid for {days:.0f} more days" if days > 0 else ", EXPIRED: create a new one"
            except Exception:
                pass
            rows.append(_row("API wallet", "EXPIRED" not in valid, f"{agent[:6]}…{agent[-4:]} is approved to trade for your account{valid}"))
        else:
            rows.append(_row("API wallet", False, f"{agent[:6]}…{agent[-4:]} is not an API wallet of {account[:6]}…: approve it at app.hyperliquid.xyz > More > API "
                             f"(Hyperliquid says: {role})"))
    except Exception as e:
        rows.append(_row("API wallet", False, f"Could not check: {e}"))
    return rows
