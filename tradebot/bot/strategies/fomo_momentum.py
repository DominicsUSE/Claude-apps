"""FOMO momentum: buys Solana memecoins that are gaining real traction, after safety checks.

Memecoins can go to zero in minutes, so this strategy is strict on purpose:
* only tokens with real liquidity and volume, older than a couple of hours (no launch sniping)
* rising, but not after a vertical candle (no buying the top of a pump)
* more buyers than sellers in the last hour
* creator cannot mint more or freeze your tokens, holders not too concentrated, RugCheck clean
* small fixed size, a hard stop, profit taken in steps, a trailing stop and a time limit
"""
import time

from ..models import Signal
from .base import Context, Strategy


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def screen_pair(pair: dict, p: dict, now_ms: int) -> tuple[bool, str, float]:
    """(passes?, why not / summary, score). Pure function so it can be tested."""
    liq = _f((pair.get("liquidity") or {}).get("usd"))
    vol = pair.get("volume") or {}
    chg = pair.get("priceChange") or {}
    tx_h1 = (pair.get("txns") or {}).get("h1") or {}
    mcap = _f(pair.get("marketCap") or pair.get("fdv"))
    created = _f(pair.get("pairCreatedAt"))
    age_h = (now_ms - created) / 3_600_000 if created else 0
    buys, sells = _f(tx_h1.get("buys")), _f(tx_h1.get("sells"))
    ratio = buys / sells if sells else (buys if buys else 0)
    h1, m5 = _f(chg.get("h1")), _f(chg.get("m5"))
    checks = [
        (liq >= p["min_liquidity_usd"], f"liquidity ${liq:,.0f}"),
        (_f(vol.get("h1")) >= p["min_volume_h1_usd"], f"1h volume ${_f(vol.get('h1')):,.0f}"),
        (_f(vol.get("h24")) >= p["min_volume_h24_usd"], f"24h volume ${_f(vol.get('h24')):,.0f}"),
        (age_h >= p["min_age_hours"], f"only {age_h:.1f}h old"),
        (age_h <= p["max_age_hours"], f"{age_h / 24:.0f} days old"),
        (p["min_market_cap_usd"] <= mcap <= p["max_market_cap_usd"], f"market cap ${mcap:,.0f}"),
        (h1 >= p["min_change_h1_pct"], f"1h change {h1:+.1f}%"),
        (h1 <= p["max_change_h1_pct"], f"already up {h1:.0f}% in 1h"),
        (m5 >= p["min_change_m5_pct"], f"5m change {m5:+.1f}%"),
        (ratio >= p["min_buy_sell_ratio_h1"], f"buy/sell ratio {ratio:.2f}"),
    ]
    for ok, why in checks:
        if not ok:
            return False, why, 0.0
    # Rank: steady momentum with lots of buyers relative to liquidity.
    score = min(h1, 40) + min(ratio, 3) * 10 + min(_f(vol.get("h1")) / max(liq, 1), 2) * 10
    return True, f"+{h1:.0f}% 1h, {ratio:.1f}x buyers, ${liq / 1000:,.0f}k liquidity", score


class FomoMomentum(Strategy):
    """Buys trending Solana memecoins in your FOMO wallet, with rug checks and tight exits."""
    name = "fomo_momentum"
    venue = "fomo"

    def scan(self, ctx: Context) -> list[Signal]:
        p = self.cfg
        held = {pos.symbol for pos in ctx.positions if pos.venue == "fomo"}
        recent = [t for t in self.state.get("buys", []) if ctx.now - t < 3600]
        self.state["buys"] = recent
        if len(recent) >= p["max_new_per_hour"]:
            self.last_note = "hourly buy limit reached"
            return []
        mints = ctx.sol.candidate_mints()
        pairs = ctx.sol.pairs(mints)
        now_ms = int(ctx.now * 1000)
        ranked = []
        for mint, pair in pairs.items():
            if mint in held or self.state.get("tried", {}).get(mint, 0) > ctx.now - 6 * 3600:
                continue
            ok, why, score = screen_pair(pair, p, now_ms)
            if ok:
                ranked.append((score, mint, pair, why))
        ranked.sort(reverse=True)
        out = []
        tried = self.state.setdefault("tried", {})
        for score, mint, pair, why in ranked[:5]:
            tried[mint] = ctx.now  # whatever happens, do not re-check this token for 6 hours
            safety = ctx.sol.safety(mint, p["max_top10_holders_pct"], p["max_rugcheck_score"])
            if not safety["ok"] and (safety["checked"] or p.get("require_safety_check", True)):
                continue
            label = (pair.get("baseToken") or {}).get("symbol", mint[:6])
            out.append(Signal("fomo", mint, "buy", self.name, label=label, size_usd=p["position_usd"],
                              stop_pct=p["stop_loss_pct"], take_profit_ladder=p.get("take_profit"),
                              trailing_stop_pct=p.get("trailing_stop_pct"), max_hold_hours=p.get("max_hold_hours"),
                              reason=why))
            self.state["buys"].append(time.time())
            if len(self.state["buys"]) >= p["max_new_per_hour"]:
                break
        # forget old entries so state does not grow forever
        self.state["tried"] = {m: t for m, t in tried.items() if ctx.now - t < 6 * 3600}
        self.last_note = f"{len(pairs)} tokens checked, {len(ranked)} passed filters, {len(out)} to buy"
        return out
