"""Checks Jupiter's live Swap API v2 still answers the way the FOMO broker expects.

Read-only: it asks for quotes for a brand-new, empty throwaway wallet, so nothing can be signed or
spent. Run on GitHub (`python tests/jupiter_contract.py`); a change in Jupiter's answers shows up
here before it can affect a real swap.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from solders.keypair import Keypair  # noqa: E402

from bot import http  # noqa: E402
from bot.brokers.fomo_wallet import FomoWalletBroker  # noqa: E402
from bot.config import DEFAULTS, SOL_MINT, USDC_MINT  # noqa: E402

BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
URL = DEFAULTS["venues"]["fomo"]["jupiter_url"]
http.MIN_INTERVAL["api.jup.ag"] = 2.1


def main() -> int:
    problems = []
    for name, out_mint in (("USDC -> SOL", SOL_MINT), ("USDC -> BONK", BONK)):
        q = http.get(f"{URL}/order", params={"inputMint": USDC_MINT, "outputMint": out_mint, "amount": "20000000"}, timeout=20)
        print(f"{name}: outAmount={q.get('outAmount')} priceImpact={q.get('priceImpact')} "
              f"priceImpactPct={q.get('priceImpactPct')} router={q.get('router')} gasless={q.get('gasless')}")
        if not int(q.get("outAmount") or 0) > 0:
            problems.append(f"{name}: no outAmount in {sorted(q)}")
    # an empty wallet: Jupiter should refuse with a reason, and the broker must turn that into a clear error
    kp = Keypair()
    broker = FomoWalletBroker(DEFAULTS["venues"]["fomo"], None, str(kp))
    try:
        order = broker._order(USDC_MINT, BONK, 20_000_000)
        print(f"empty wallet: Jupiter still built a swap (keys {sorted(order)})")
        if order.get("transaction") and int(order.get("transactionVersion") or 0) != 0:
            problems.append("transactionVersion is no longer 0")
    except RuntimeError as e:
        print(f"empty wallet: refused as expected: {e}")
    for p in problems:
        print("PROBLEM:", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
