"""Paper-trades for a few minutes against the real APIs (Hyperliquid, DexScreener, Jupiter, RugCheck)
and fails if market data or the strategies break. Needs internet; no keys, no real money.

    python tests/live_smoke.py [minutes]
"""
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bot import config as config_mod  # noqa: E402
from bot.engine import Engine  # noqa: E402
from bot.models import Signal  # noqa: E402


def main(minutes: float) -> int:
    sys.stdout.reconfigure(errors="replace")
    cfg = config_mod.deep_merge(config_mod.DEFAULTS, {})
    cfg["loop_seconds"] = 10
    for name in ("meme_scalper", "fomo_momentum", "trend", "btc_regime", "eth_btc_pair"):
        cfg["strategies"][name]["enabled"] = True
        cfg["strategies"][name]["every_seconds"] = 30
    cfg["strategies"]["trend"]["interval"] = "1h"
    data = Path(tempfile.mkdtemp())
    engine = Engine(cfg, data_dir=data)
    engine.tick()
    print(f"Paper account ${engine.last_equity:,.2f}; BTC ${engine.hl.price('BTC'):,.0f}; "
          f"{len(engine.hl.markets('xyz'))} stock markets on Liquid")
    # one manual trade per venue proves pricing and the paper fills work end to end
    engine.execute(Signal("liquid", "ETH", "buy", "manual", label="ETH", size_usd=20, stop_pct=5))
    mints = engine.sol.candidate_mints()
    print(f"{len(mints)} trending Solana tokens found")
    pairs = engine.sol.pairs(mints[:30])
    if pairs:
        mint, pair = max(pairs.items(), key=lambda kv: float((kv[1].get("liquidity") or {}).get("usd") or 0))
        label = (pair.get("baseToken") or {}).get("symbol", "?")
        print(f"Most liquid: {label} ${float(pair.get('priceUsd') or 0):.6g}; safety: {engine.sol.safety(mint, 35, 500)}")
        engine.execute(Signal("fomo", mint, "buy", "manual", label=label, size_usd=15, stop_pct=20))
    end = time.time() + minutes * 60
    while time.time() < end:
        engine.tick()
        engine._drain_inbox()
        time.sleep(cfg["loop_seconds"])
    st = engine.status()
    print("\nStrategies:")
    for name, s in st["strategies"].items():
        print(f"  {name:15} {s['note']}")
    print("\nActivity:")
    for e in reversed(st["events"]):
        print(f"  [{e['kind']}] {e['text']}")
    print("\nMeme scalper chart reads:")
    for w in st["watch"]:
        print(f"  {w['symbol']:10} {w.get('structure', ''):8} {w.get('setup', ''):12} {w['text'][:150]}")
    print(f"\nPositions: {[(p['label'], p['side'], round(p['notional'], 2)) for p in st['positions']]}")
    if not st["watch"]:
        problems_extra = [{"text": "the meme scalper read no charts (GeckoTerminal unreachable?)"}]
    else:
        problems_extra = []
    problems = [e for e in st["events"] if e["kind"] == "error"] + problems_extra
    if not any(p["symbol"] == "ETH" for p in st["positions"]) and not engine.trades():
        problems.append({"text": "the ETH paper trade did not happen"})
    if problems:
        print("\nFAILED:", [p["text"] for p in problems])
        return 1
    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main(float(sys.argv[1]) if len(sys.argv) > 1 else 3))
