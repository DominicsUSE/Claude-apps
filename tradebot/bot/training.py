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

from .chart import MEME_DEFAULTS, SETUPS, features, simulate

GRID = {
    "rvol_min": [1.5, 2.0, 3.0],
    "range_max_pct": [10.0, 15.0, 25.0],
    "max_stop_pct": [10.0, 15.0],
    "trail": ["swing", "ema9"],
}
TRAIN_SHARE = 0.6
MIN_TRADES = 15


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


def by_setup(trades: list[dict]) -> dict:
    return {s: stats([t for t in trades if t["setup"] == s]) for s in SETUPS}


def grid() -> list[dict]:
    keys = list(GRID)
    return [dict(zip(keys, combo)) for combo in itertools.product(*(GRID[k] for k in keys))]


def train(charts: dict[str, list], base: dict | None = None, progress=None) -> dict:
    """charts: {label: [Candle, ...]}. Returns the learned result (also used by tests)."""
    base = {**MEME_DEFAULTS, **(base or {})}
    feats = {}
    for name, candles in charts.items():
        if len(candles) >= 120:
            feats[name] = features(candles, base["swing_k"])
    if not feats:
        return {"error": "not enough chart data (need at least 120 candles per token)"}
    splits = {n: int(len(f.c) * TRAIN_SHARE) for n, f in feats.items()}
    best, best_score, best_train = None, -1e18, None
    combos = grid()
    for i, combo in enumerate(combos):
        p = {**base, **combo}
        trades = []
        for n, f in feats.items():
            trades += simulate(f, p, 30, splits[n])
        s = stats(trades)
        score = s["t_stat"] if s["trades"] >= MIN_TRADES else -1e9 + s["trades"]
        if score > best_score:
            best, best_score, best_train = combo, score, (s, trades)
        if progress:
            progress(i + 1, len(combos))
    p = {**base, **best}
    test_trades = []
    for n, f in feats.items():
        for t in simulate(f, p, splits[n], len(f.c)):
            t["token"] = n
            test_trades.append(t)
    test = stats(test_trades)
    per_setup_test = by_setup(test_trades)
    per_setup_train = by_setup(best_train[1])
    enabled = []
    for s in SETUPS:
        st = per_setup_test[s]
        if st["trades"] < 8 or st["avg_pct"] > 0:
            enabled.append(s)  # too few unseen trades to judge, or it made money on unseen charts
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
        "params": {k: p[k] for k in GRID}, "setups": enabled or [],
        "train": best_train[0], "test": test, "verdict": verdict,
        "per_setup": {"train": per_setup_train, "test": per_setup_test},
        "sample_trades": test_trades[-60:],
    }


def journal_feedback(trades: list[dict], min_trades: int = 10) -> dict:
    """Learns from the bot's own closed meme trades: per setup, and which setups to pause."""
    rows = [r for r in trades if r.get("strategy") == "meme_scalper" and r.get("action") == "close" and r.get("pnl_usd") not in ("", None)]
    out = {}
    for s in SETUPS:
        pnl = [float(r["pnl_usd"]) for r in rows if (r.get("setup") or "") == s]
        wins = [x for x in pnl if x > 0]
        out[s] = {"trades": len(pnl), "pnl": round(sum(pnl), 2), "win_rate": round(len(wins) / len(pnl) * 100, 1) if pnl else 0,
                  "paused": len(pnl) >= min_trades and sum(pnl) < 0}
    return out


class Trainer:
    """Runs training in the background (so the bot keeps trading) and remembers the result."""

    def __init__(self, data_dir: Path, sol, candles):
        self.path = data_dir / "learned.json"
        self.universe_path = data_dir / "universe.json"
        self.sol = sol
        self.candles = candles
        self.lock = threading.Lock()
        self.status = {"running": False, "progress": "", "error": ""}
        self.learned = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except ValueError:
                return {}
        return {}

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

    def due(self, hours: float) -> bool:
        return not self.status["running"] and time.time() - self.learned.get("trained_at", 0) > hours * 3600

    def start(self, max_tokens: int = 60, interval: str = "5m") -> bool:
        if not self.lock.acquire(blocking=False):
            return False
        self.status = {"running": True, "progress": "collecting charts", "error": ""}
        threading.Thread(target=self._run, args=(max_tokens, interval), daemon=True).start()
        return True

    def _run(self, max_tokens: int, interval: str) -> None:
        try:
            result = self.run(max_tokens, interval)
            if "error" in result:
                self.status["error"] = result["error"]
            else:
                self.learned = result
                self.path.write_text(json.dumps(result), encoding="utf-8")
        except Exception as e:  # report, never crash the bot
            self.status["error"] = str(e)
        finally:
            self.status["running"] = False
            self.status["progress"] = ""
            self.lock.release()

    def run(self, max_tokens: int = 60, interval: str = "5m") -> dict:
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
        charts = {}
        for i, (mint, row) in enumerate(chosen):
            self.status["progress"] = f"downloading chart {i + 1}/{len(chosen)}"
            try:
                charts[f"{row.get('symbol') or mint[:6]}:{mint[:6]}"] = self.candles.history(row["pool"], interval, 1000)
            except Exception:
                continue

        def prog(done, total):
            self.status["progress"] = f"testing settings {done}/{total}"
        result = train(charts, {"interval": interval}, prog)
        if "error" not in result:
            result["interval"] = interval
        return result
