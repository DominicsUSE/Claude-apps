"""Meme scalper: short-term trades on Solana memecoins in your FOMO wallet, decided by reading the chart.

Each minute: take the tokens people are trading right now (DexScreener boosts, Jupiter trending),
keep the ones with real liquidity and volume, and read each one's 5-minute chart once per candle
(bot/chart.py). Buy only when a setup appears (breakout, pullback, VWAP reclaim) and the token
passes the rug checks. Then manage the trade from the chart: sell part at +1R and +2R, trail the
stop under each new higher low, and sell the rest when the chart turns.
"""
import time

from ..chart import MEME_DEFAULTS, SETUPS, entry_signal, exit_signal, features, read
from ..data.dex_candles import step_seconds
from ..models import Signal
from .base import Context, Strategy
from .fomo_momentum import _f


def watch_filter(pair: dict, p: dict, now_ms: int) -> bool:
    liq = _f((pair.get("liquidity") or {}).get("usd"))
    vol = _f((pair.get("volume") or {}).get("h24"))
    mcap = _f(pair.get("marketCap") or pair.get("fdv"))
    created = _f(pair.get("pairCreatedAt"))
    age_h = (now_ms - created) / 3_600_000 if created else 0
    too_old = p.get("max_age_hours") and age_h > p["max_age_hours"]
    return (liq >= p["min_liquidity_usd"] and vol >= p["min_volume_h24_usd"] and age_h >= p["min_age_hours"] and not too_old
            and p["min_market_cap_usd"] <= mcap <= p["max_market_cap_usd"] and bool(pair.get("pairAddress")))


class MemeScalper(Strategy):
    """Reads memecoin charts and trades breakouts, pullbacks and VWAP reclaims in your FOMO wallet."""
    name = "meme_scalper"
    venue = "fomo"

    def __init__(self, cfg: dict, state: dict | None = None, trainer=None, candles=None):
        super().__init__(cfg, state)
        self.trainer = trainer
        self.candles = candles
        self.watch: dict[str, dict] = {}
        self.paused_setups: set[str] = set()

    def params(self) -> dict:
        p = {**MEME_DEFAULTS, **(self.cfg.get("chart") or {})}
        learned = (self.trainer.learned if self.trainer else {}) or {}
        if self.cfg.get("use_learned", True) and learned.get("params"):
            p.update(learned["params"])
            if learned.get("setups") is not None:
                p["setups"] = [s for s in p["setups"] if s in learned["setups"]]
        p["setups"] = [s for s in p["setups"] if s not in self.paused_setups]
        return p

    def _chart(self, pool: str, interval: str):
        candles = self.candles.closed(pool, interval, 300)
        return features(candles, MEME_DEFAULTS["swing_k"]) if len(candles) >= 60 else None

    # ---------- finding entries ----------

    def scan(self, ctx: Context) -> list[Signal]:
        p = {**self.cfg, **self.params()}
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
        if not p["setups"]:
            self.last_note = "every setup is paused by training or by your results"
        for mint, pair in watch:
            pool = pair["pairAddress"]
            pools[mint] = pool
            symbol = (pair.get("baseToken") or {}).get("symbol", mint[:6])
            try:
                f = self._chart(pool, p["interval"])
            except Exception as e:
                self.watch[mint] = {"symbol": symbol, "pool": pool, "text": f"chart unavailable: {e}", "time": ctx.now}
                continue
            if f is None:
                continue
            t = len(f.c) - 1
            bar_t = f.candles[t].t
            r = read(f, t)
            self.watch[mint] = {"symbol": symbol, "pool": pool, "text": r["text"], "structure": r["structure"],
                                "price": f.c[t], "time": ctx.now, "setup": ""}
            if mint in held or seen.get(mint) == bar_t or len(recent) >= p["max_new_per_hour"] or not p["setups"]:
                seen[mint] = bar_t
                continue
            seen[mint] = bar_t
            sig = entry_signal(f, t, p)
            if not sig:
                continue
            self.watch[mint]["setup"] = sig["setup"]
            safety = ctx.sol.safety(mint, p["max_top10_holders_pct"], p["max_rugcheck_score"])
            if not safety["ok"] and (safety["checked"] or p.get("require_safety_check", True)):
                self.watch[mint]["text"] += " Skipped: " + ("; ".join(safety["reasons"]) or "safety check unavailable") + "."
                continue
            price = f.c[t]
            stop_pct = (price - sig["stop"]) / price * 100
            ladder = [[round(rr * stop_pct, 2), frac] for rr, frac in p["tp_r"]]
            out.append(Signal("fomo", mint, "buy", self.name, label=symbol, size_usd=p["position_usd"],
                              stop_pct=stop_pct, take_profit_ladder=ladder,
                              max_hold_hours=p["max_hold_bars"] * step_seconds(p["interval"]) / 3600,
                              price_hint=price, setup=sig["setup"],
                              reason=f"{sig['reason']} Chart: {r['text']}"))
            recent.append(ctx.now)
        self.state["last_bar"] = {m: v for m, v in seen.items() if m in pairs or m in held}
        self.watch = {m: w for m, w in self.watch.items() if ctx.now - w["time"] < 3600}
        if p["setups"]:
            self.last_note = f"watching {len(watch)} tokens on {p['interval']} charts; setups: {', '.join(p['setups'])}"
        return out

    # ---------- managing open trades ----------

    def manage(self, ctx: Context) -> list[Signal]:
        """Every loop: for each open meme trade, read its chart on each new candle and decide hold / tighten stop / sell."""
        p = self.params()
        out = []
        pools = self.state.get("pools", {})
        done = self.state.setdefault("managed_bar", {})
        for key, pos in ctx.mine(self.name).items():
            pool = pools.get(pos.symbol)
            o = ctx.owners.get(key, {})
            if not pool:
                continue
            try:
                f = self._chart(pool, p["interval"])
            except Exception:
                continue
            if f is None:
                continue
            t = len(f.c) - 1
            if done.get(key) == f.candles[t].t:
                continue
            done[key] = f.candles[t].t
            opened_ms = o.get("opened_at", ctx.now) * 1000
            entry_i = next((i for i, cd in enumerate(f.candles) if cd.t + step_seconds(p["interval"]) * 1000 > opened_ms), t)
            state = {"entry": o.get("entry_price", pos.entry_price), "stop": o.get("stop") or 0,
                     "init_stop": o.get("init_stop") or o.get("stop") or 0, "entry_i": entry_i,
                     "bars": t - entry_i, "peak": max(f.h[entry_i:t + 1] or [pos.mark_price])}
            if state["init_stop"] <= 0 or state["init_stop"] >= state["entry"]:
                continue
            action, why, new_stop = exit_signal(f, t, state, p)
            if action == "sell":
                out.append(Signal("fomo", pos.symbol, "close", self.name, label=pos.label, reason=f"chart exit: {why}"))
            elif new_stop:
                out.append(Signal("fomo", pos.symbol, "stop", self.name, label=pos.label, stop_price=new_stop,
                                  reason="stop raised under the new higher low" if p["trail"] == "swing" else "stop raised to the 9 EMA"))
        self.state["managed_bar"] = {k: v for k, v in done.items() if k in ctx.owners}
        return out

    def chart_payload(self, pool: str, interval: str | None = None, bars: int = 200) -> dict:
        """Candles, indicator lines, swing points and the written read, for the dashboard."""
        p = self.params()
        interval = interval or p["interval"]
        candles = self.candles.closed(pool, interval, 300)
        if len(candles) < 30:
            return {"error": "not enough candles yet"}
        f = features(candles, MEME_DEFAULTS["swing_k"])
        start = max(0, len(candles) - bars)
        t_last = len(candles) - 1
        sig = entry_signal(f, t_last, p)
        return {
            "interval": interval,
            "candles": [[c.t, c.o, c.h, c.l, c.c, c.v] for c in candles[start:]],
            "vwap": f.vwap[start:], "ema9": f.ema9[start:], "ema21": f.ema21[start:],
            "swings": [[f.candles[i].t, price, "high"] for conf, i, price in f.swing_highs if i >= start and conf <= t_last] +
                      [[f.candles[i].t, price, "low"] for conf, i, price in f.swing_lows if i >= start and conf <= t_last],
            "read": read(f, t_last), "signal": sig,
        }


__all__ = ["MemeScalper", "watch_filter", "SETUPS"]
