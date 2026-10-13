"""Meme scalper: short-term memecoin trades decided by reading the chart.

Two places to trade:
* Solana wallet, Phantom or FOMO (Solana tokens, buy only): each minute take the tokens people are trading right
  now (DexScreener boosts, Jupiter trending), keep the ones with real liquidity and volume, and
  read each one's 5-minute chart (GeckoTerminal) once per candle.
* Liquid (memecoin perps such as kPEPE, WIF, FARTCOIN, kBONK, POPCAT, PENGU): long AND short,
  far cheaper to trade (about 0.1% per side vs about 1% on a DEX swap), 5-minute charts from
  Hyperliquid. Short setups are the long setups read on the chart turned upside down.

Buy (or short) only when a setup appears (breakout, pullback, VWAP reclaim) and, for Solana tokens,
the rug checks pass. Then manage the trade from the chart: take part at +1R and +2R, trail the stop
under each new higher low (above each lower high for shorts), and get out when the chart turns.

In live mode a venue only trades with settings that made money on unseen charts in training
(bot/training.py); in paper mode it always trades, so it keeps learning.
"""
from .. import config as config_mod
from ..chart import MEME_DEFAULTS, SETUPS, entry_signal, exit_signal, features, invert, read
from ..data.dex_candles import step_seconds
from ..data.solana import is_stock_token
from ..models import Signal
from ..training import PROFILE_BASE, proven
from .base import Context, Strategy
from .fomo_momentum import _f

MIRROR = [
    ("Breakout: closed above", "Breakdown: closed below"), ("above VWAP", "below VWAP"),
    ("Pullback in an uptrend (higher highs and lows)", "Bounce in a downtrend (lower highs and lows)"),
    ("bounced with", "rejected with"), ("hammer", "shooting star"), ("bullish engulfing", "bearish engulfing"),
    ("a green reversal candle", "a red reversal candle"),
    ("Reclaimed VWAP after trading under it", "Lost VWAP after trading above it"),
]


def mirror_text(text: str) -> str:
    """Describes a setup found on the upside-down chart in terms of the real chart."""
    for a, b in MIRROR:
        text = text.replace(a, b)
    return text


def watch_filter(pair: dict, p: dict, now_ms: int) -> bool:
    liq = _f((pair.get("liquidity") or {}).get("usd"))
    vol = _f((pair.get("volume") or {}).get("h24"))
    mcap = _f(pair.get("marketCap") or pair.get("fdv"))
    created = _f(pair.get("pairCreatedAt"))
    age_h = (now_ms - created) / 3_600_000 if created else 0
    too_old = p.get("max_age_hours") and age_h > p["max_age_hours"]
    if is_stock_token(pair):
        return False
    return (liq >= p["min_liquidity_usd"] and vol >= p["min_volume_h24_usd"] and age_h >= p["min_age_hours"] and not too_old
            and p["min_market_cap_usd"] <= mcap <= p["max_market_cap_usd"] and bool(pair.get("pairAddress")))


def unproven_warning(learned: dict) -> str:
    """Plain-language warning for the approval card when training has not shown an edge."""
    if proven(learned):
        return ""
    if not learned:
        return "Not trained yet: nobody knows whether this setup makes money."
    t = learned.get("test") or {}
    stats = f" ({t['trades']} trades on unseen charts, {t['avg_pct']:+.2f}% per trade)" if t.get("trades") else ""
    return f"Unproven: training says {str(learned.get('verdict', '')).lower()}{stats}."


class MemeScalper(Strategy):
    """Reads memecoin charts and trades breakouts, pullbacks and VWAP reclaims (Solana wallet and Liquid perps)."""
    name = "meme_scalper"
    venue = "fomo"
    venues = ("fomo", "liquid")

    def __init__(self, cfg: dict, state: dict | None = None, trainer=None, candles=None):
        super().__init__(cfg, state)
        self.trainer = trainer
        self.candles = candles
        self.watch: dict[str, dict] = {}
        self.paused_setups: set[str] = set()   # "venue:setup" keys paused by the journal
        self.notes: dict[str, str] = {}

    # ---------- settings ----------

    def params(self, venue: str = "fomo") -> dict:
        """Chart settings for a venue: defaults, then your overrides, then what training learned.
        p["setups"] = long setups allowed, p["short_setups"] = short setups allowed (Liquid only)."""
        p = {**MEME_DEFAULTS, **PROFILE_BASE[venue], **(self.cfg.get("chart" if venue == "fomo" else "liquid_chart") or {})}
        learned = self.trainer.get(venue) if self.trainer else {}
        allowed_long, allowed_short = list(p["setups"]), list(p["setups"])
        if self.cfg.get("use_learned", True) and learned.get("params"):
            p.update(learned["params"])
            ok = set(learned.get("setups") or [])
            allowed_long = [s for s in allowed_long if s in ok]
            allowed_short = [s for s in allowed_short if f"{s}_short" in ok]
        p["setups"] = [s for s in allowed_long if f"{venue}:{s}" not in self.paused_setups]
        p["short_setups"] = [s for s in allowed_short if f"{venue}:{s}_short" not in self.paused_setups] \
            if venue == "liquid" and self.cfg.get("liquid_shorts", True) else []
        p["learned"] = learned
        return p

    def live_blocked(self, ctx: Context, venue: str, p: dict) -> str:
        """In live mode, refuse new entries until training shows an edge on unseen charts, unless you
        approve every trade yourself (then the proposals carry a warning instead)."""
        if not config_mod.is_live(ctx.cfg) or self.cfg.get("trade_unproven_live", False):
            return ""
        if config_mod.asks_approval(ctx.cfg) and ctx.cfg.get("approvals", {}).get("propose_unproven", True):
            return ""
        if not proven(p["learned"]):
            v = p["learned"].get("verdict", "not trained yet")
            return f"{venue}: live entries paused, training says {v.lower()} (paper mode keeps learning)"
        return ""

    def _candles(self, ctx: Context, venue: str, ident: str, interval: str):
        if venue == "liquid":
            return ctx.hl.closed_candles(ident, interval, 400)
        return self.candles.closed(ident, interval, 300)

    # ---------- finding entries ----------

    def scan(self, ctx: Context) -> list[Signal]:
        out = []
        self.notes = {}
        if self.cfg.get("fomo_enabled", True) and "fomo" in ctx.venues:
            out += self._scan_fomo(ctx)
        if self.cfg.get("liquid_enabled", True) and "liquid" in ctx.venues:
            out += self._scan_liquid(ctx)
        for sig in out:
            if sig.action in ("buy", "sell"):
                sig.warning = unproven_warning(self.params(sig.venue)["learned"])
        self.watch = {m: w for m, w in self.watch.items() if ctx.now - w["time"] < 3600}
        self.last_note = " | ".join(self.notes.values())
        return out

    def _ladder(self, stop_pct: float, p: dict) -> list:
        return [[round(rr * stop_pct, 2), frac] for rr, frac in p["tp_r"]]

    def _scan_fomo(self, ctx: Context) -> list[Signal]:
        p = {**self.cfg, **self.params("fomo")}
        blocked = self.live_blocked(ctx, "FOMO", p)
        now_ms = int(ctx.now * 1000)
        held = {pos.symbol for pos in ctx.positions if pos.venue == "fomo"}
        pools = self.state.setdefault("pools", {})
        recent = [t for t in self.state.get("buys", []) if ctx.now - t < 3600]
        self.state["buys"] = recent
        pairs = ctx.sol.pairs(ctx.sol.candidate_mints())
        watch = [(m, pr) for m, pr in pairs.items() if watch_filter(pr, p, now_ms)]
        watch.sort(key=lambda kv: _f((kv[1].get("volume") or {}).get("h1")), reverse=True)
        watch = watch[: p["watch_count"]]
        if self.trainer:
            self.trainer.remember([{"mint": m, "pool": pr["pairAddress"], "symbol": (pr.get("baseToken") or {}).get("symbol", "")} for m, pr in watch])
        seen = self.state.setdefault("last_bar", {})
        out = []
        for mint, pair in watch:
            pool = pair["pairAddress"]
            pools[mint] = pool
            symbol = (pair.get("baseToken") or {}).get("symbol", mint[:6])
            try:
                candles = self._candles(ctx, "fomo", pool, p["interval"])
            except Exception as e:
                self.watch[mint] = {"venue": "fomo", "symbol": symbol, "pool": pool, "text": f"chart unavailable: {e}", "time": ctx.now}
                continue
            if len(candles) < 60:
                continue
            f = features(candles, p["swing_k"])
            t = len(f.c) - 1
            bar_t = f.candles[t].t
            r = read(f, t)
            self.watch[mint] = {"venue": "fomo", "symbol": symbol, "pool": pool, "text": r["text"], "structure": r["structure"],
                                "price": f.c[t], "time": ctx.now, "setup": ""}
            if mint in held or seen.get(mint) == bar_t or len(recent) >= p["max_new_per_hour"] or not p["setups"] or blocked:
                seen[mint] = bar_t
                continue
            seen[mint] = bar_t
            sig = entry_signal(f, t, p)
            if not sig:
                continue
            self.watch[mint]["setup"] = sig["setup"]
            # order flow: on breakouts and reclaims, buyers must outnumber sellers right now
            tx5 = (pair.get("txns") or {}).get("m5") or {}
            buys5, sells5 = _f(tx5.get("buys")), _f(tx5.get("sells"))
            if sig["setup"] in ("breakout", "vwap_reclaim") and buys5 + sells5 >= 10 and buys5 < sells5:
                self.watch[mint]["text"] += f" Skipped: more sellers than buyers in the last 5 minutes ({buys5:.0f} vs {sells5:.0f})."
                continue
            safety = ctx.sol.safety(mint, p["max_top10_holders_pct"], p["max_rugcheck_score"])
            if not safety["ok"] and (safety["checked"] or p.get("require_safety_check", True)):
                self.watch[mint]["text"] += " Skipped: " + ("; ".join(safety["reasons"]) or "safety check unavailable") + "."
                continue
            price = f.c[t]
            stop_pct = (price - sig["stop"]) / price * 100
            liquidity = _f((pair.get("liquidity") or {}).get("usd"))
            size = min(p["position_usd"], liquidity * p.get("max_pool_share_pct", 0.5) / 100)
            self.state.setdefault("entry_liq", {})[mint] = liquidity
            out.append(Signal("fomo", mint, "buy", self.name, label=symbol, size_usd=size,
                              stop_pct=stop_pct, take_profit_ladder=self._ladder(stop_pct, p),
                              max_hold_hours=p["max_hold_bars"] * step_seconds(p["interval"]) / 3600,
                              setup=sig["setup"],
                              reason=f"{sig['reason']} Chart: {r['text']}"))
            recent.append(ctx.now)
        self.state["last_bar"] = {m: v for m, v in seen.items() if m in pairs or m in held or ":" in m}
        if blocked:
            self.notes["fomo"] = blocked
        elif not p["setups"]:
            self.notes["fomo"] = "FOMO: every setup is paused by training or by your results"
        else:
            self.notes["fomo"] = f"FOMO: watching {len(watch)} tokens on {p['interval']} charts ({', '.join(p['setups'])})"
        return out

    def _scan_liquid(self, ctx: Context) -> list[Signal]:
        p = {**self.cfg, **self.params("liquid")}
        blocked = self.live_blocked(ctx, "Liquid", p)
        held = {pos.symbol for pos in ctx.positions if pos.venue == "liquid"}
        seen = self.state.setdefault("last_bar", {})
        recent = [t for t in self.state.get("liquid_entries", []) if ctx.now - t < 3600]
        self.state["liquid_entries"] = recent
        out, watched = [], 0
        cap = p.get("max_funding_pct")   # skip the side paying more funding than this, % per hour
        try:
            rates = ctx.hl.funding_rates()
        except Exception:
            rates = {}                   # unknown funding never blocks a trade
        for sym in self.cfg.get("liquid_markets", []):
            try:
                if not ctx.hl.has_market(sym):
                    continue
                candles = self._candles(ctx, "liquid", sym, p["interval"])
            except Exception as e:
                self.watch[f"liquid:{sym}"] = {"venue": "liquid", "symbol": sym, "text": f"chart unavailable: {e}", "time": ctx.now}
                continue
            if len(candles) < 60:
                continue
            watched += 1
            f = features(candles, p["swing_k"])
            t = len(f.c) - 1
            r = read(f, t)
            key = f"liquid:{sym}"
            self.watch[key] = {"venue": "liquid", "symbol": sym, "text": r["text"], "structure": r["structure"],
                               "price": f.c[t], "time": ctx.now, "setup": ""}
            bar_t = f.candles[t].t
            if sym in held or seen.get(key) == bar_t or blocked or len(recent) >= p.get("liquid_max_new_per_hour", 4):
                seen[key] = bar_t
                continue
            seen[key] = bar_t
            price = f.c[t]
            rate = rates.get(sym)
            long_ok = cap is None or rate is None or rate * 100 <= cap
            short_ok = cap is None or rate is None or -rate * 100 <= cap
            side, sig = None, entry_signal(f, t, {**p, "setups": p["setups"]}) if p["setups"] and long_ok else None
            if sig:
                side, stop, reason, setup = "buy", sig["stop"], sig["reason"], sig["setup"]
            elif p["short_setups"] and short_ok:
                fi = features(invert(candles), p["swing_k"])
                s2 = entry_signal(fi, t, {**p, "setups": p["short_setups"]})
                if s2:
                    side, stop, reason, setup = "sell", 1 / s2["stop"], mirror_text(s2["reason"]), f"{s2['setup']}_short"
            if not side:
                continue
            if rate is not None:
                reason += f" Funding {rate * 100:+.4f}%/h ({'longs pay' if rate > 0 else 'shorts pay' if rate < 0 else 'none'})."
            self.watch[key]["setup"] = setup
            stop_pct = abs(price - stop) / price * 100
            out.append(Signal("liquid", sym, side, self.name, label=sym, size_usd=p.get("liquid_position_usd", 25),
                              stop_price=stop, take_profit_ladder=self._ladder(stop_pct, p),
                              leverage=p.get("liquid_leverage", 2),
                              max_hold_hours=p["max_hold_bars"] * step_seconds(p["interval"]) / 3600,
                              setup=setup, reason=f"{reason} Chart: {r['text']}"))
            recent.append(ctx.now)
        if blocked:
            self.notes["liquid"] = blocked
        else:
            longs = ", ".join(p["setups"]) or "none"
            shorts = ", ".join(p["short_setups"]) or "none"
            self.notes["liquid"] = f"Liquid: watching {watched} memecoin perps (long: {longs}; short: {shorts})"
        return out

    # ---------- managing open trades ----------

    def manage(self, ctx: Context) -> list[Signal]:
        """Every loop: rug-pull guard for Solana tokens; on each new candle, read the chart of every
        open trade and decide hold / tighten stop / sell."""
        out = []
        mine = ctx.mine(self.name)
        pools = self.state.get("pools", {})
        done = self.state.setdefault("managed_bar", {})
        fomo_mine = {k: pos for k, pos in mine.items() if pos.venue == "fomo"}
        entry_liq = self.state.setdefault("entry_liq", {})
        try:
            live_pairs = ctx.sol.pairs([pos.symbol for pos in fomo_mine.values()]) if fomo_mine else {}
        except Exception:
            live_pairs = {}
        pulled = set()
        for key, pos in fomo_mine.items():
            before = entry_liq.get(pos.symbol)
            now_liq = _f(((live_pairs.get(pos.symbol) or {}).get("liquidity") or {}).get("usd"), -1)
            if before and now_liq >= 0 and now_liq < before * (1 - self.cfg.get("liquidity_drop_exit_pct", 30) / 100):
                pulled.add(key)
                out.append(Signal("fomo", pos.symbol, "close", self.name, label=pos.label,
                                  reason=f"liquidity pulled: ${before / 1000:,.0f}k at entry, ${now_liq / 1000:,.0f}k now"))
        self.state["entry_liq"] = {m: v for m, v in entry_liq.items() if any(pos.symbol == m for pos in mine.values()) or m in self.watch}
        for key, pos in mine.items():
            if key in pulled:
                continue
            venue = pos.venue
            p = self.params(venue)
            ident = pools.get(pos.symbol) if venue == "fomo" else pos.symbol
            o = ctx.owners.get(key, {})
            if not ident:
                continue
            try:
                candles = self._candles(ctx, venue, ident, p["interval"])
            except Exception:
                continue
            if len(candles) < 60:
                continue
            t = len(candles) - 1
            if done.get(key) == candles[t].t:
                continue
            done[key] = candles[t].t
            short = pos.side == "short"
            f = features(invert(candles) if short else candles, p["swing_k"])
            conv = (lambda x: 1 / x if x else 0) if short else (lambda x: x)
            opened_ms = o.get("opened_at", ctx.now) * 1000
            entry_i = next((i for i, cd in enumerate(f.candles) if cd.t + step_seconds(p["interval"]) * 1000 > opened_ms), t)
            entry = conv(o.get("entry_price", pos.entry_price))
            stop = conv(o.get("stop") or 0)
            init_stop = conv(o.get("init_stop") or o.get("stop") or 0)
            if not entry or not init_stop or init_stop >= entry:
                continue
            state = {"entry": entry, "stop": stop, "init_stop": init_stop, "entry_i": entry_i,
                     "bars": t - entry_i, "peak": max(f.h[entry_i:t + 1] or [entry])}
            action, why, new_stop = exit_signal(f, t, state, p)
            if action == "sell":
                if short:
                    why = why.replace("higher low", "lower high").replace("below the 21 EMA", "above the 21 EMA") \
                             .replace("sellers showed up at the highs", "buyers showed up at the lows") \
                             .replace("shooting star", "hammer").replace("bearish engulfing", "bullish engulfing") \
                             .replace("bearish RSI divergence at the high", "bullish RSI divergence at the low")
                out.append(Signal(venue, pos.symbol, "close", self.name, label=pos.label, reason=f"chart exit: {why}"))
            elif new_stop:
                out.append(Signal(venue, pos.symbol, "stop", self.name, label=pos.label, stop_price=conv(new_stop),
                                  reason=("stop moved above the new lower high" if short else "stop raised under the new higher low")
                                  if p["trail"] == "swing" else "stop moved to the 9 EMA"))
        self.state["managed_bar"] = {k: v for k, v in done.items() if k in ctx.owners}
        return out

    def chart_payload(self, venue: str, ident: str, interval: str | None = None, hl=None, bars: int = 200) -> dict:
        """Candles, indicator lines, swing points and the written read, for the dashboard."""
        p = self.params(venue)
        interval = interval or p["interval"]
        candles = hl.closed_candles(ident, interval, 400) if venue == "liquid" else self.candles.closed(ident, interval, 300)
        if len(candles) < 30:
            return {"error": "not enough candles yet"}
        f = features(candles, MEME_DEFAULTS["swing_k"])
        start = max(0, len(candles) - bars)
        t_last = len(candles) - 1
        sig = entry_signal(f, t_last, p) if p["setups"] else None
        if not sig and venue == "liquid" and p["short_setups"] and len(candles) >= 60:
            s2 = entry_signal(features(invert(candles), MEME_DEFAULTS["swing_k"]), t_last, {**p, "setups": p["short_setups"]})
            if s2:
                sig = {"setup": f"{s2['setup']}_short", "stop": 1 / s2["stop"], "reason": mirror_text(s2["reason"])}
        return {
            "interval": interval, "venue": venue,
            "candles": [[c.t, c.o, c.h, c.l, c.c, c.v] for c in candles[start:]],
            "vwap": f.vwap[start:], "ema9": f.ema9[start:], "ema21": f.ema21[start:],
            "swings": [[f.candles[i].t, price, "high"] for conf, i, price in f.swing_highs if i >= start and conf <= t_last] +
                      [[f.candles[i].t, price, "low"] for conf, i, price in f.swing_lows if i >= start and conf <= t_last],
            "read": read(f, t_last), "signal": sig,
        }


__all__ = ["MemeScalper", "watch_filter", "SETUPS", "mirror_text"]
