"""Training: the bot studies recent memecoin charts and keeps only what works.

1. Collect charts: every token the bot has watched (so losers count too, not just the coins that
   pumped), plus today's trending list. 5-minute candles, about 3.5 days each.
2. Walk-forward, as in the video: for each token the first 60% of its chart is for choosing
   settings, the last 40% is "unseen" and only used to grade the choice.
3. Try a small grid of settings on the training part of every chart, pick the one with the
   most reliable edge (t-statistic of the average trade, not the single best run).
4. Grade it on the unseen part. Setups that lose there are switched off.
5. Learn from real (paper or live) trades too: a setup that keeps losing in the journal is
   switched off as well, until a retrain on fresh charts says it works again.

Results go to data/learned.json and the meme strategy picks them up.
"""
import itertools
import json
import math
import threading
import time
from pathlib import Path

from .chart import MEME_DEFAULTS, SETUPS, features, invert, simulate

GRID = {
    "rvol_min": [1.5, 2.0, 3.0],
    "range_max_pct": [10.0, 15.0, 25.0],
    "max_stop_pct": [10.0, 15.0],
    "trail": ["swing", "ema9"],
    "exit_on_structure": [True, False],
}
TRAIN_SHARE = 0.6
MIN_TRADES = 15
SETUPS_ALL = SETUPS + tuple(f"{s}_short" for s in SETUPS)
PROFILES = ("fomo", "liquid")
# Liquid memecoin perps: about 0.1% cost per side (vs ~1% on DEX swaps) and smaller candles, so
# tighter stops and ranges, and a tighter "don't chase" limit.
PROFILE_BASE = {
    "fomo": {},
    "liquid": {"cost_pct": 0.1, "min_stop_pct": 0.8, "max_stop_pct": 6.0, "range_max_pct": 6.0, "max_ext_vwap_pct": 8.0},
}
PROFILE_GRIDS = {
    "fomo": GRID,
    "liquid": {"rvol_min": [1.5, 2.0, 3.0], "range_max_pct": [3.0, 6.0, 10.0], "max_stop_pct": [3.0, 6.0], "trail": ["swing", "ema9"],
               "exit_on_structure": [True, False], "min_stop_pct": [0.8, 1.5]},
}


def stats(trades: list[dict]) -> dict:
    if not trades:
        return {"trades": 0, "win_rate": 0.0, "avg_pct": 0.0, "avg_r": 0.0, "profit_factor": 0.0, "t_stat": 0.0, "total_pct": 0.0}
    rets = [t["ret_pct"] for t in trades]
    wins = [x for x in rets if x > 0]
    losses = [x for x in rets if x <= 0]
    mean = sum(rets) / len(rets)
    sd = math.sqrt(sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)) if len(rets) > 1 else 0
    return {
        "trades": len(rets),
        "win_rate": round(len(wins) / len(rets) * 100, 1),
        "avg_pct": round(mean, 2),
        "avg_r": round(sum(t["r"] for t in trades) / len(trades), 2),
        "profit_factor": round(sum(wins) / -sum(losses), 2) if losses and sum(losses) < 0 else (99.0 if wins else 0.0),
        "t_stat": round(mean / sd * math.sqrt(len(rets)), 2) if sd > 0 else 0.0,
        "total_pct": round(sum(rets), 1),
    }


def by_setup(trades: list[dict], names=SETUPS_ALL) -> dict:
    return {s: stats([t for t in trades if t["setup"] == s]) for s in names}


def grid(g: dict | None = None) -> list[dict]:
    g = g or GRID
    keys = list(g)
    return [dict(zip(keys, combo)) for combo in itertools.product(*(g[k] for k in keys))]


def _trades(f, fi, p, lo, hi, both_sides, token=None):
    out = simulate(f, p, lo, hi)
    if both_sides and fi is not None:
        for t in simulate(fi, p, lo, hi):
            t["setup"] += "_short"
            out.append(t)
    if token:
        for t in out:
            t["token"] = token
    return out


def train(charts: dict[str, list], base: dict | None = None, progress=None, both_sides: bool = False,
          param_grid: dict | None = None) -> dict:
    """charts: {label: [Candle, ...]}. Settings are chosen on the first 60% of every chart and graded
    on the last 40%. With both_sides, short setups are tested too (on the chart turned upside down)."""
    base = {**MEME_DEFAULTS, **(base or {})}
    param_grid = param_grid or GRID
    feats, inv = {}, {}
    for name, candles in charts.items():
        if len(candles) >= 120:
            feats[name] = features(candles, base["swing_k"])
            inv[name] = features(invert(candles), base["swing_k"]) if both_sides else None
    if not feats:
        return {"error": "not enough chart data (need at least 120 candles per token)"}
    splits = {n: int(len(f.c) * TRAIN_SHARE) for n, f in feats.items()}
    best, best_score, best_train = None, -1e18, None
    combos = grid(param_grid)
    for i, combo in enumerate(combos):
        p = {**base, **combo}
        trades = []
        for n, f in feats.items():
            trades += _trades(f, inv[n], p, 30, splits[n], both_sides)
        s = stats(trades)
        score = s["t_stat"] if s["trades"] >= MIN_TRADES else -1e9 + s["trades"]
        if score > best_score:
            best, best_score, best_train = combo, score, (s, trades)
        if progress:
            progress(i + 1, len(combos))
    p = {**base, **best}
    test_trades = []
    for n, f in feats.items():
        test_trades += _trades(f, inv[n], p, splits[n], len(f.c), both_sides, token=n)
    names = SETUPS_ALL if both_sides else SETUPS
    per_setup_test = by_setup(test_trades, names)
    per_setup_train = by_setup(best_train[1], names)
    # Which setups to keep is decided on the TRAINING part only. Choosing them by their unseen
    # results and then grading on those same results would flatter the verdict (selection bias).
    enabled = [s for s in names if per_setup_train[s]["trades"] < 8 or per_setup_train[s]["avg_pct"] > 0]
    all_test = stats(test_trades)
    test_trades = [t for t in test_trades if t["setup"] in enabled]
    test = stats(test_trades)
    if test["trades"] < 15:
        verdict = "NOT ENOUGH TRADES"
    elif test["trades"] >= 25 and test["avg_pct"] > 0 and test["profit_factor"] >= 1.2 and test["t_stat"] >= 1.5:
        verdict = "WORKS ON UNSEEN CHARTS"
    elif test["avg_pct"] > 0:
        verdict = "SLIGHT EDGE"
    else:
        verdict = "LOSES ON UNSEEN CHARTS"
    test_trades.sort(key=lambda t: t["entry_t"])
    return {
        "trained_at": time.time(), "tokens": len(feats), "candles": sum(len(f.c) for f in feats.values()),
        "params": {k: p[k] for k in param_grid}, "setups": enabled, "both_sides": both_sides,
        "cost_pct": p["cost_pct"], "train": best_train[0], "test": test, "test_all_setups": all_test, "verdict": verdict,
        "per_setup": {"train": per_setup_train, "test": per_setup_test},
        "sample_trades": test_trades[-60:],
    }


def proven(learned: dict) -> bool:
    """Real money only follows settings that made money on charts the optimiser never saw."""
    return bool(learned) and learned.get("verdict") in ("WORKS ON UNSEEN CHARTS", "SLIGHT EDGE")


def journal_feedback(trades: list[dict], min_trades: int = 10) -> dict:
    """Learns from the bot's own closed meme trades, per venue and setup: which to pause."""
    rows = [r for r in trades if r.get("strategy") == "meme_scalper" and r.get("action") == "close" and r.get("pnl_usd") not in ("", None)]
    out = {}
    for venue, names in (("fomo", SETUPS), ("liquid", SETUPS_ALL)):
        for s in names:
            pnl = [float(r["pnl_usd"]) for r in rows if r.get("venue", "fomo") == venue and (r.get("setup") or "") == s]
            if not pnl and venue == "liquid" and s.endswith("_short"):
                continue
            wins = [x for x in pnl if x > 0]
            out[f"{venue}:{s}"] = {"trades": len(pnl), "pnl": round(sum(pnl), 2),
                                   "win_rate": round(len(wins) / len(pnl) * 100, 1) if pnl else 0,
                                   "paused": len(pnl) >= min_trades and sum(pnl) < 0}
    return out


class Trainer:
    """Runs training in the background (so the bot keeps trading) and remembers the results,
    one per profile: "fomo" (Solana DEX charts) and "liquid" (memecoin perps on Liquid)."""

    def __init__(self, data_dir: Path, sol, candles, hl=None, liquid_markets: list[str] | None = None):
        self.data_dir = data_dir
        self.universe_path = data_dir / "universe.json"
        self.sol = sol
        self.candles = candles
        self.hl = hl
        self.liquid_markets = liquid_markets or []
        self.lock = threading.Lock()
        self.status = {"running": False, "progress": "", "error": "", "profile": ""}
        self.learned = {p: self._load(p) for p in PROFILES}

    def _path(self, profile: str) -> Path:
        return self.data_dir / ("learned.json" if profile == "fomo" else f"learned_{profile}.json")

    def _load(self, profile: str) -> dict:
        path = self._path(profile)
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                return {}
        return {}

    def get(self, profile: str) -> dict:
        return self.learned.get(profile) or {}

    def universe(self) -> dict:
        if self.universe_path.exists():
            try:
                return json.loads(self.universe_path.read_text(encoding="utf-8"))
            except ValueError:
                return {}
        return {}

    def remember(self, tokens: list[dict]) -> None:
        """Adds watched tokens (mint, pool, symbol) to the training universe."""
        u = self.universe()
        now = time.time()
        for tk in tokens:
            row = u.setdefault(tk["mint"], {"first_seen": now})
            row.update(pool=tk["pool"], symbol=tk.get("symbol", ""), last_seen=now)
        # keep the 400 most recent
        if len(u) > 400:
            u = dict(sorted(u.items(), key=lambda kv: kv[1].get("last_seen", 0))[-400:])
        self.universe_path.write_text(json.dumps(u), encoding="utf-8")

    def due(self, hours: float, profile: str = "fomo") -> bool:
        return not self.status["running"] and time.time() - self.get(profile).get("trained_at", 0) > hours * 3600

    def start(self, profile: str = "fomo", max_tokens: int = 60, interval: str = "5m") -> bool:
        if not self.lock.acquire(blocking=False):
            return False
        self.status = {"running": True, "progress": "collecting charts", "error": "", "profile": profile}
        threading.Thread(target=self._run, args=(profile, max_tokens, interval), daemon=True).start()
        return True

    def _run(self, profile: str, max_tokens: int, interval: str) -> None:
        try:
            result = self.run(profile, max_tokens, interval)
            if "error" in result:
                self.status["error"] = result["error"]
            else:
                self.save(profile, result)
        except Exception as e:  # report, never crash the bot
            self.status["error"] = str(e)
        finally:
            self.status["running"] = False
            self.status["progress"] = ""
            self.lock.release()

    def save(self, profile: str, result: dict) -> None:
        self.learned[profile] = result
        self._path(profile).write_text(json.dumps(result), encoding="utf-8")

    def run(self, profile: str = "fomo", max_tokens: int = 60, interval: str = "5m") -> dict:
        def prog(done, total):
            self.status["progress"] = f"testing settings {done}/{total}"
        charts = self.collect(profile, max_tokens, interval)
        result = train(charts, {"interval": interval, **PROFILE_BASE[profile]}, prog,
                       both_sides=profile == "liquid", param_grid=PROFILE_GRIDS[profile])
        if "error" not in result:
            result["interval"] = interval
            result["profile"] = profile
        return result

    def collect(self, profile: str, max_tokens: int, interval: str) -> dict:
        charts = {}
        if profile == "liquid":
            markets = [m for m in self.liquid_markets if self.hl and self.hl.has_market(m)]
            for i, sym in enumerate(markets):
                self.status["progress"] = f"downloading {sym} ({i + 1}/{len(markets)})"
                try:
                    candles = self.hl.candles(sym, interval, 4000)
                    charts[sym] = candles[:-1]  # drop the candle still forming
                except Exception:
                    continue
            return charts
        u = self.universe()
        try:  # add today's trending tokens
            mints = self.sol.candidate_mints()
            pairs = self.sol.pairs(mints)
            fresh = [{"mint": m, "pool": pr.get("pairAddress"), "symbol": (pr.get("baseToken") or {}).get("symbol", "")}
                     for m, pr in pairs.items() if pr.get("pairAddress")]
            if fresh:
                self.remember(fresh)
                u = self.universe()
        except Exception:
            pass
        chosen = sorted(u.items(), key=lambda kv: kv[1].get("last_seen", 0), reverse=True)[:max_tokens]
        for i, (mint, row) in enumerate(chosen):
            self.status["progress"] = f"downloading chart {i + 1}/{len(chosen)}"
            try:
                charts[f"{row.get('symbol') or mint[:6]}:{mint[:6]}"] = self.candles.history(row["pool"], interval, 1000)
            except Exception:
                continue
        return charts
