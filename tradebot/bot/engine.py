"""The engine: every few seconds it values the account, enforces the risk limits, manages exits,
runs the strategies and executes what they (and TradingView, and you) ask for."""
import csv
import json
import logging
import queue
import threading
import time
from collections import deque
from datetime import datetime, timezone

from . import config as config_mod
from .brokers.paper import PaperBroker
from .data.dex_candles import DexCandles
from .data.hyperliquid import HyperliquidData
from .data.solana import SolanaData
from .models import Fill, Position, Signal
from .research import Research
from .risk import RiskManager
from .strategies import build as build_strategy
from .training import Trainer, journal_feedback

log = logging.getLogger("tradebot")

TRADE_FIELDS = ["time", "mode", "venue", "symbol", "label", "strategy", "action", "side", "qty", "price", "usd",
                "fee_usd", "pnl_usd", "reason", "tx", "setup"]


class Engine:
    def __init__(self, cfg: dict, data_dir=None, hl=None, sol=None, brokers=None, dex=None):
        self.cfg = cfg
        self.data_dir = data_dir or config_mod.DATA_DIR
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.data_dir / "state.json"
        self.trades_path = self.data_dir / "trades.csv"
        self.equity_path = self.data_dir / "equity.csv"
        self.lock = threading.RLock()
        self.inbox: "queue.Queue[Signal]" = queue.Queue()
        self.events: deque = deque(maxlen=400)
        self.hl = hl or HyperliquidData(cfg["venues"]["liquid"]["api_url"])
        self.sol = sol or SolanaData()
        self.dex = dex or DexCandles(self.data_dir / "candles")
        self.trainer = Trainer(self.data_dir, self.sol, self.dex)
        self.state = self._load_state()
        self.live = config_mod.is_live(cfg)
        self.broker_notes: dict[str, str] = {}
        self.brokers = brokers if brokers is not None else self._make_brokers()
        self.risk = RiskManager(cfg["risk"])
        self.research = Research(cfg["research"])
        self.strategies = {}
        self._build_strategies()
        self.equity_history: deque = deque(self._load_equity(), maxlen=20000)
        self.last_equity = 0.0
        self.last_positions: list[Position] = []
        self.last_tick = 0.0
        self.last_error = ""
        self._stop = threading.Event()

    # ---------- setup ----------

    def _load_state(self) -> dict:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text(encoding="utf-8"))
            except ValueError:
                self.state_path.rename(self.state_path.with_suffix(".broken.json"))
        return {}

    def save_state(self) -> None:
        with self.lock:
            for venue, broker in self.unique_brokers():
                if hasattr(broker, "to_state"):
                    self.state.setdefault("brokers", {})[broker.name] = broker.to_state()
            self.state["strategies"] = {n: s.state for n, s in self.strategies.items()}
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.state, indent=1, default=str), encoding="utf-8")
            tmp.replace(self.state_path)

    def price(self, venue: str, symbol: str) -> float:
        if venue == "fomo":
            return self.sol.price(symbol)
        return self.hl.price(symbol)

    def _make_brokers(self) -> dict:
        saved = self.state.get("brokers", {})
        if not self.live:
            p = self.cfg["paper"]
            paper = PaperBroker(self.price, p["starting_balance_usd"], p["fee_pct"], p["slippage_pct"], saved.get("paper"))
            return {v: paper for v in ("fomo", "liquid") if self.cfg["venues"][v]["enabled"]}
        brokers = {}
        fomo_cfg, liq_cfg = self.cfg["venues"]["fomo"], self.cfg["venues"]["liquid"]
        if fomo_cfg["enabled"]:
            key = config_mod.secret("FOMO_WALLET_PRIVATE_KEY")
            if key and not config_mod.secret("JUPITER_API_KEY") and "api.jup.ag" in fomo_cfg["jupiter_url"]:
                self.broker_notes["fomo"] = "Add a free JUPITER_API_KEY (portal.jup.ag): Jupiter needs it to make swaps"
            elif key:
                from .brokers.fomo_wallet import FomoWalletBroker
                try:
                    brokers["fomo"] = FomoWalletBroker(fomo_cfg, self.sol, key, config_mod.secret("SOLANA_RPC_URL"),
                                                       config_mod.secret("JUPITER_API_KEY"), saved.get("fomo"))
                except Exception as e:
                    self.broker_notes["fomo"] = f"FOMO wallet key could not be read: {e}"
            else:
                self.broker_notes["fomo"] = "Add FOMO_WALLET_PRIVATE_KEY to .env to trade your FOMO wallet"
        if liq_cfg["enabled"]:
            addr, key = config_mod.secret("HL_ACCOUNT_ADDRESS"), config_mod.secret("HL_API_PRIVATE_KEY")
            if addr and key:
                from .brokers.hyperliquid_live import HyperliquidBroker
                try:
                    brokers["liquid"] = HyperliquidBroker(liq_cfg, self.hl, addr, key, self._liquid_dexes(), state=saved.get("liquid"))
                except Exception as e:
                    self.broker_notes["liquid"] = f"Liquid connection failed: {e}"
            else:
                self.broker_notes["liquid"] = "Add HL_ACCOUNT_ADDRESS and HL_API_PRIVATE_KEY to .env to trade on Liquid"
        return brokers

    def _liquid_dexes(self) -> list[str]:
        dexes = [""]
        if self.cfg["strategies"].get("congress", {}).get("enabled") or self.cfg["strategies"]["tradingview"]["enabled"]:
            dexes.append("xyz")
        for s in self.cfg["strategies"].values():
            for sym in s.get("symbols", []) + [s.get("symbol", "")]:
                if ":" in str(sym) and sym.split(":")[0] not in dexes:
                    dexes.append(sym.split(":")[0])
        return dexes

    def _build_strategies(self) -> None:
        saved = self.state.get("strategies", {})
        self.strategies = {}
        for name, scfg in self.cfg["strategies"].items():
            if name == "tradingview":
                continue
            strat = build_strategy(name, scfg, saved.get(name, {}), trainer=self.trainer, candles=self.dex)
            if strat:
                self.strategies[name] = strat

    def unique_brokers(self):
        seen = set()
        for venue, b in self.brokers.items():
            if id(b) not in seen:
                seen.add(id(b))
                yield venue, b

    # ---------- events and journal ----------

    def event(self, kind: str, text: str, **extra) -> None:
        row = {"time": time.time(), "kind": kind, "text": text, **extra}
        self.events.appendleft(row)
        getattr(log, "warning" if kind in ("error", "blocked") else "info")(f"[{kind}] {text}")

    def journal(self, sig: Signal, fill: Fill, action: str, reason: str) -> None:
        new = not self.trades_path.exists()
        with self.trades_path.open("a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=TRADE_FIELDS)
            if new:
                w.writeheader()
            w.writerow({
                "time": datetime.now(timezone.utc).isoformat(timespec="seconds"), "mode": "live" if self.live else "paper",
                "venue": sig.venue, "symbol": sig.symbol, "label": sig.label, "strategy": sig.strategy, "action": action,
                "side": fill.side, "qty": f"{fill.qty:.8g}", "price": f"{fill.price:.8g}", "usd": f"{fill.notional:.2f}",
                "fee_usd": f"{fill.fee_usd:.4f}", "pnl_usd": f"{fill.realized_pnl:.4f}" if action != "open" else "",
                "reason": reason, "tx": fill.tx, "setup": sig.setup,
            })

    def trades(self, limit: int = 300) -> list[dict]:
        if not self.trades_path.exists():
            return []
        with self.trades_path.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        return rows[-limit:][::-1]

    def _load_equity(self) -> list:
        if not self.equity_path.exists():
            return []
        out = []
        for line in self.equity_path.read_text(encoding="utf-8").splitlines()[-20000:]:
            try:
                t, v = line.split(",")[:2]
                out.append((float(t), float(v)))
            except ValueError:
                continue
        return out

    def _record_equity(self, equity: float) -> None:
        now = time.time()
        if self.equity_history and now - self.equity_history[-1][0] < 60:
            return
        self.equity_history.append((now, equity))
        with self.equity_path.open("a", encoding="utf-8") as f:
            f.write(f"{now:.0f},{equity:.2f},{'live' if self.live else 'paper'}\n")

    # ---------- main loop ----------

    def run_forever(self) -> None:
        self.event("info", f"Bot started in {'LIVE' if self.live else 'PAPER'} mode")
        while not self._stop.is_set():
            started = time.time()
            try:
                self.tick()
            except Exception as e:  # keep running; one bad cycle must not stop the bot
                self.last_error = str(e)
                self.event("error", f"Cycle failed: {e}")
                log.exception("cycle failed")
            self._drain_inbox()
            self._stop.wait(max(1.0, self.cfg["loop_seconds"] - (time.time() - started)))

    def stop(self) -> None:
        self._stop.set()

    def snapshot(self) -> tuple[float, list[Position]]:
        positions, equity = [], 0.0
        for venue, broker in self.unique_brokers():
            try:
                equity += broker.equity()
                positions += [p for p in broker.positions() if p.venue in self.brokers]
            except Exception as e:
                self.event("error", f"{broker.name}: could not read the account: {e}")
                raise
        return equity, positions

    def tick(self) -> None:
        with self.lock:
            if not self.brokers:
                self.last_tick = time.time()
                return
            equity, positions = self.snapshot()
            self.last_equity, self.last_positions = equity, positions
            self._record_equity(equity)
            self._update_day(equity)
            reason = self.risk.check_account(equity, self.state["day"]["start_equity"], self.state.get("peak_equity", equity))
            if reason and not self.state.get("halted"):
                self.state["halted"] = reason
                self.event("blocked", reason)
            self._reconcile(positions)
            self._manage_exits(positions)
            self.last_tick = time.time()
        self._run_strategies()
        self.save_state()

    def _update_day(self, equity: float) -> None:
        today = datetime.now(timezone.utc).date().isoformat()
        day = self.state.get("day")
        if not day or day.get("date") != today:
            self.state["day"] = {"date": today, "start_equity": equity}
            halted = self.state.get("halted") or ""
            if halted.startswith("Daily loss"):
                self.state["halted"] = ""
                self.event("info", "New day: daily loss limit reset")
        self.state["peak_equity"] = max(self.state.get("peak_equity", 0.0), equity)

    def _reconcile(self, positions: list[Position]) -> None:
        """Forget positions that closed outside the bot (exchange stop, or you sold in the app)."""
        owners = self.state.setdefault("owners", {})
        open_keys = {p.key for p in positions}
        for key in list(owners):
            if key not in open_keys and key.split(":")[0] in self.brokers:
                if time.time() - owners[key].get("opened_at", 0) < 180:
                    continue  # a fresh Solana buy can take a moment to show up in the wallet
                o = owners.pop(key)
                self.event("info", f"{o.get('label') or key} is no longer open (closed on the exchange or in the app)")

    def _manage_exits(self, positions: list[Position]) -> None:
        owners = self.state.setdefault("owners", {})
        open_keys = {p.key for p in positions}
        for pos in positions:
            o = owners.get(pos.key)
            if not o:
                continue  # not opened by the bot: never touched
            px, long = pos.mark_price, pos.side == "long"
            o["peak"] = max(o.get("peak", px), px) if long else min(o.get("peak", px), px)
            gain = pos.pnl_pct
            exit_reason, fraction = "", 1.0
            stop = o.get("stop")
            if stop and ((long and px <= stop) or (not long and px >= stop)):
                exit_reason = "stop-loss"
            elif o.get("take_profit") and ((long and px >= o["take_profit"]) or (not long and px <= o["take_profit"])):
                exit_reason = "take-profit"
            elif o.get("max_hold_hours") and time.time() - o.get("opened_at", time.time()) > o["max_hold_hours"] * 3600:
                exit_reason = "time limit"
            elif o.get("group"):
                siblings = [k for k, v in owners.items() if v.get("group") == o["group"] and k != pos.key]
                if any(k not in open_keys for k in siblings) or not siblings:
                    exit_reason = "other leg of the pair closed"
            if not exit_reason:
                ladder = o.get("ladder") or []
                done = o.get("ladder_done", 0)
                if done < len(ladder) and gain >= ladder[done][0]:
                    orig = o.get("orig_qty") or pos.qty
                    fraction = min(1.0, ladder[done][1] * orig / pos.qty) if pos.qty else 1.0
                    exit_reason = f"take-profit step {done + 1} (+{ladder[done][0]}%)"
                    o["ladder_done"] = done + 1
                    if o.get("entry_price") and (not stop or (long and stop < o["entry_price"]) or (not long and stop > o["entry_price"])):
                        o["stop"] = o["entry_price"]  # after the first profit, the rest can no longer lose
                        self._push_stop(pos, o["stop"])
            if not exit_reason and o.get("trail_pct"):
                trail = o["peak"] * (1 - o["trail_pct"] / 100) if long else o["peak"] * (1 + o["trail_pct"] / 100)
                in_profit = (long and trail > o.get("entry_price", 0)) or (not long and trail < o.get("entry_price", 1e30))
                if in_profit and ((long and px <= trail) or (not long and px >= trail)):
                    exit_reason = f"trailing stop ({o['trail_pct']}% from the best price)"
                elif in_profit and stop and ((long and trail > stop * 1.005) or (not long and trail < stop * 0.995)):
                    o["stop"] = trail
                    self._push_stop(pos, trail)
            if exit_reason:
                sig = Signal(pos.venue, pos.symbol, "close", o.get("strategy", "bot"), label=o.get("label", ""),
                             close_fraction=fraction, reason=exit_reason, group=o.get("group", "") if fraction >= 0.999 else "")
                self._close(sig, pos)

    def _push_stop(self, pos: Position, stop: float) -> None:
        broker = self.brokers.get(pos.venue)
        if broker and self.live:
            try:
                broker.update_stop(pos.venue, pos.symbol, stop)
            except Exception as e:
                self.event("error", f"Could not move the exchange stop for {pos.label or pos.symbol}: {e}")

    def _run_strategies(self) -> None:
        from .strategies.base import Context
        now = time.time()
        # 1) open trades are always managed, even while paused: exits must never stop
        for name, strat in self.strategies.items():
            if not hasattr(strat, "manage"):
                continue
            with self.lock:
                owners = dict(self.state.get("owners", {}))
                if not any(o.get("strategy") == name for o in owners.values()):
                    continue
                ctx = Context(self.cfg, self.hl, self.sol, list(self.last_positions), owners, now)
            try:
                for sig in strat.manage(ctx):
                    self.inbox.put(sig)
            except Exception as e:
                self.event("error", f"{name} could not check its open trades: {e}")
        # 2) learning: retrain on fresh charts, and pause setups that keep losing in the journal
        meme = self.strategies.get("meme_scalper")
        if meme and self.cfg["strategies"]["meme_scalper"].get("enabled"):
            fb = journal_feedback(self.trades(100000))
            meme.paused_setups = {s for s, v in fb.items() if v["paused"]}
            if self.trainer.due(self.cfg["strategies"]["meme_scalper"].get("train_every_hours", 24)):
                if self.trainer.start():
                    self.event("info", "Training started: studying recent memecoin charts in the background")
        if self.state.get("paused") or self.state.get("halted"):
            return
        for name, strat in self.strategies.items():
            if not self.cfg["strategies"][name].get("enabled") or not strat.due(now):
                continue
            if strat.venue not in self.brokers:
                strat.last_note = f"{strat.venue} is not connected"
                continue
            strat.last_run = now
            with self.lock:
                ctx = Context(self.cfg, self.hl, self.sol, list(self.last_positions), dict(self.state.get("owners", {})), now)
            try:
                signals = strat.scan(ctx)
            except Exception as e:
                strat.last_note = f"error: {e}"
                self.event("error", f"{name}: {e}")
                continue
            for sig in signals:
                self.inbox.put(sig)

    def _drain_inbox(self) -> None:
        batch: list[Signal] = []
        while True:
            try:
                batch.append(self.inbox.get_nowait())
            except queue.Empty:
                break
        groups: dict[str, list[Signal]] = {}
        for sig in batch:
            if sig.group and sig.action != "close":
                groups.setdefault(sig.group, []).append(sig)
            else:
                self.execute(sig)
        for legs in groups.values():
            self.execute_group(legs)

    # ---------- executing ----------

    def submit(self, sig: Signal) -> None:
        """Thread-safe: used by the webhook and the dashboard."""
        self.inbox.put(sig)

    def _owner_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for o in self.state.get("owners", {}).values():
            counts[o.get("strategy", "")] = counts.get(o.get("strategy", ""), 0) + 1
        return counts

    def _blocked(self, sig: Signal) -> str:
        if sig.action == "close":
            return ""
        if self.state.get("paused"):
            return "the bot is paused"
        if self.state.get("halted"):
            return self.state["halted"]
        if sig.venue not in self.brokers:
            return self.broker_notes.get(sig.venue) or f"{sig.venue} is not enabled"
        return ""

    def execute(self, sig: Signal) -> Fill | None:
        with self.lock:
            if sig.action == "stop":
                return self._tighten_stop(sig)
            why = self._blocked(sig)
            if why:
                self.event("blocked", f"{sig.label or sig.symbol} {sig.action} ({sig.strategy}) not taken: {why}")
                return None
            pos = next((p for p in self.last_positions if p.key == sig.key), None)
            owner = self.state.get("owners", {}).get(sig.key, {}).get("strategy")
            if pos and owner and owner != sig.strategy and sig.strategy not in ("manual", "tradingview"):
                self.event("blocked", f"{sig.label or sig.symbol} {sig.action} ({sig.strategy}) skipped: the position belongs to {owner}")
                return None
            if pos and not owner and sig.strategy not in ("manual", "tradingview"):
                self.event("blocked", f"{sig.label or sig.symbol} {sig.action} ({sig.strategy}) skipped: you hold it outside the bot")
                return None
            if sig.action == "close":
                if not pos:
                    pos = next((p for p in self._fresh_positions(sig.venue) if p.key == sig.key), None)
                if not pos:
                    self.event("info", f"{sig.label or sig.symbol}: nothing to close")
                    return None
                return self._close(sig, pos)
            want = "long" if sig.action == "buy" else "short"
            if pos:
                if pos.side == want:
                    self.event("info", f"{sig.label or sig.symbol}: already {want}, signal from {sig.strategy} ignored")
                    return None
                flip = Signal(sig.venue, sig.symbol, "close", sig.strategy, label=sig.label, reason="reversing position")
                if not self._close(flip, pos):
                    return None
            decision = self._decide(sig)
            if not decision:
                return None
            return self._open(sig, decision)

    def execute_group(self, legs: list[Signal]) -> None:
        """Pair trades: every leg must pass the risk checks, all legs get the same size,
        and if a later leg fails the earlier ones are closed again."""
        with self.lock:
            for sig in legs:
                why = self._blocked(sig)
                if why:
                    self.event("blocked", f"{legs[0].group} not opened: {why}")
                    return
            decisions = []
            for sig in legs:
                d = self._decide(sig)
                if not d:
                    self.event("blocked", f"{legs[0].group} not opened: {sig.label} failed the risk checks")
                    return
                decisions.append(d)
            size = min(d.size_usd for d in decisions)
            opened = []
            for sig, d in zip(legs, decisions):
                d.size_usd = size
                fill = self._open(sig, d)
                if not fill:
                    for done in opened:
                        pos = next((p for p in self._fresh_positions(done.venue) if p.key == done.key), None)
                        if pos:
                            self._close(Signal(done.venue, done.symbol, "close", done.strategy, label=done.label,
                                               reason="other leg failed"), pos)
                    return
                opened.append(sig)

    def _tighten_stop(self, sig: Signal) -> None:
        """Stops only ever move in the trade's favour."""
        o = self.state.get("owners", {}).get(sig.key)
        if not o or not sig.stop_price:
            return None
        long = o.get("side") == "long"
        cur = o.get("stop")
        if cur is None or (long and sig.stop_price > cur) or (not long and sig.stop_price < cur):
            o["stop"] = sig.stop_price
            pos = next((p for p in self.last_positions if p.key == sig.key), None)
            if pos:
                self._push_stop(pos, sig.stop_price)
            self.event("info", f"{sig.label or o.get('label') or sig.symbol}: stop moved to {sig.stop_price:.6g} ({sig.reason})")
        return None

    def _fresh_positions(self, venue: str) -> list[Position]:
        broker = self.brokers.get(venue)
        try:
            return [p for p in broker.positions() if p.venue == venue] if broker else []
        except Exception:
            return []

    def _decide(self, sig: Signal):
        try:
            price = self.price(sig.venue, sig.symbol)
        except Exception as e:
            self.event("blocked", f"{sig.label or sig.symbol}: no price ({e})")
            return None
        broker = self.brokers[sig.venue]
        max_lev = None
        if sig.venue == "liquid":
            try:
                max_lev = self.hl.market(sig.symbol)["maxLeverage"]
            except Exception as e:
                self.event("blocked", f"{sig.label or sig.symbol}: not a Liquid market ({e})")
                return None
        equity = self.last_equity or self.snapshot()[0]
        d = self.risk.evaluate(sig, price, equity, self.last_positions, self._owner_counts(),
                               self.state.get("cooldowns", {}), broker.supports_short and sig.venue != "fomo", max_lev)
        if not d.ok:
            self.event("blocked", f"{sig.label or sig.symbol} {sig.action} ({sig.strategy}) not taken: {d.reason}")
            return None
        vetoed, note = self.research.veto(sig.label or sig.symbol, sig.action)
        if vetoed:
            self.event("blocked", f"{sig.label or sig.symbol} {sig.action} blocked by the news check: {note}")
            return None
        if note:
            sig.reason = f"{sig.reason}; {note}" if sig.reason else note
        return d

    def _open(self, sig: Signal, d) -> Fill | None:
        broker = self.brokers[sig.venue]
        side = "long" if sig.action == "buy" else "short"
        fill = broker.open(sig.venue, sig.symbol, side, d.size_usd, leverage=d.leverage, label=sig.label,
                           stop_price=d.stop_price, take_profit_price=d.take_profit_price)
        if not fill.ok:
            self._order_failed(f"{sig.label or sig.symbol} {sig.action} failed: {fill.error}")
            return None
        self.state["errors"] = 0
        owners = self.state.setdefault("owners", {})
        owners[sig.key] = {
            "strategy": sig.strategy, "label": sig.label, "side": side, "opened_at": time.time(),
            "entry_price": fill.price, "orig_qty": fill.qty, "stop": d.stop_price, "take_profit": d.take_profit_price,
            "ladder": sig.take_profit_ladder or [], "ladder_done": 0, "trail_pct": sig.trailing_stop_pct,
            "max_hold_hours": sig.max_hold_hours, "group": sig.group, "peak": fill.price, "reason": sig.reason,
            "setup": sig.setup, "init_stop": d.stop_price,
        }
        self.journal(sig, fill, "open", sig.reason)
        self.event("trade", f"Opened {side} {sig.label or sig.symbol} ${fill.notional:,.2f} at {fill.price:.6g} "
                            f"({sig.strategy}{'; ' + sig.reason if sig.reason else ''})", venue=sig.venue)
        self.last_positions = [p for p in self.last_positions if p.key != sig.key] + [
            Position(sig.venue, sig.symbol, side, fill.qty, fill.price, fill.price, sig.label, d.leverage, time.time())]
        return fill

    def _close(self, sig: Signal, pos: Position) -> Fill | None:
        broker = self.brokers.get(sig.venue)
        if not broker:
            return None
        fill = broker.close(sig.venue, sig.symbol, sig.close_fraction)
        owners = self.state.setdefault("owners", {})
        o = owners.get(sig.key, {})
        if not fill.ok:
            if "no open position" in fill.error or "holds none" in fill.error:
                owners.pop(sig.key, None)  # the exchange's own stop or target got there first
                self.last_positions = [p for p in self.last_positions if p.key != sig.key]
                self.event("info", f"{sig.label or pos.label or sig.symbol} was already closed")
                return None
            self._order_failed(f"Closing {sig.label or pos.label or sig.symbol} failed: {fill.error}")
            return None
        self.state["errors"] = 0
        full = sig.close_fraction >= 0.999
        if not fill.realized_pnl and o.get("entry_price"):
            diff = fill.price - o["entry_price"]
            fill.realized_pnl = (diff if pos.side == "long" else -diff) * fill.qty - fill.fee_usd
        sig.strategy = o.get("strategy", sig.strategy)
        sig.label = sig.label or o.get("label") or pos.label
        sig.setup = sig.setup or o.get("setup", "")
        self.journal(sig, fill, "close" if full else "partial close", sig.reason)
        self.event("trade", f"{'Closed' if full else 'Took profit on part of'} {sig.label or sig.symbol}: "
                            f"{'+' if fill.realized_pnl >= 0 else '-'}${abs(fill.realized_pnl):,.2f} ({sig.reason})", venue=sig.venue)
        if not full:
            for p in self.last_positions:
                if p.key == sig.key:
                    p.qty = max(p.qty - fill.qty, 0.0)
        if full:
            owners.pop(sig.key, None)
            self.last_positions = [p for p in self.last_positions if p.key != sig.key]
            if fill.realized_pnl < 0:
                cd = self.state.setdefault("cooldowns", {})
                cd[sig.key] = time.time() + self.cfg["risk"]["cooldown_minutes"] * 60
                self.state["cooldowns"] = {k: v for k, v in cd.items() if v > time.time()}
            if o.get("group"):
                for key, other in list(owners.items()):
                    if other.get("group") == o["group"]:
                        sib = next((p for p in self.last_positions if p.key == key), None)
                        if sib:
                            self._close(Signal(sib.venue, sib.symbol, "close", other.get("strategy", ""), label=other.get("label", ""),
                                               reason="closing the other leg of the pair"), sib)
        return fill

    def _order_failed(self, text: str) -> None:
        self.state["errors"] = self.state.get("errors", 0) + 1
        self.event("error", text)
        if self.state["errors"] >= self.cfg["risk"]["max_consecutive_errors"]:
            self.state["paused"] = True
            self.event("blocked", f"Paused after {self.state['errors']} failed orders in a row. Check the connection, then press Resume.")

    # ---------- controls (dashboard) ----------

    def pause(self) -> None:
        with self.lock:
            self.state["paused"] = True
            self.event("info", "Paused: no new trades. Open positions keep their stops and targets.")
            self.save_state()

    def resume(self) -> None:
        with self.lock:
            self.state["paused"] = False
            self.state["halted"] = ""
            self.state["errors"] = 0
            if self.last_equity:
                self.state["peak_equity"] = self.last_equity  # restart drawdown tracking from here
            self.event("info", "Resumed")
            self.save_state()

    def close_all(self) -> None:
        with self.lock:
            for pos in list(self.last_positions):
                if pos.key in self.state.get("owners", {}) or not self.live:
                    self._close(Signal(pos.venue, pos.symbol, "close", "manual", label=pos.label, reason="Close all button"), pos)
            self.save_state()

    def reload_config(self, cfg: dict) -> None:
        with self.lock:
            live_before = self.live
            self.cfg = cfg
            self.risk = RiskManager(cfg["risk"])
            self.research = Research(cfg["research"])
            self.state["strategies"] = {n: s.state for n, s in self.strategies.items()}
            self._build_strategies()
            if config_mod.is_live(cfg) != live_before:
                self.event("info", "Mode changed: restart the bot to switch between paper and live")

    def reset_paper(self, balance: float) -> None:
        with self.lock:
            if self.live:
                raise RuntimeError("Not in paper mode")
            for _, b in self.unique_brokers():
                if isinstance(b, PaperBroker):
                    b.reset(balance)
            self.state["owners"] = {}
            self.state["peak_equity"] = balance
            self.state["day"] = {"date": datetime.now(timezone.utc).date().isoformat(), "start_equity": balance}
            self.state["halted"] = ""
            self.equity_history.clear()
            if self.equity_path.exists():
                self.equity_path.unlink()
            self.event("info", f"Practice account reset to ${balance:,.2f}")
            self.save_state()

    # ---------- reporting ----------

    def stats(self) -> dict:
        """Closed-trade statistics, overall and per strategy, for the dashboard and the risk-of-ruin check."""
        rows = [r for r in self.trades(100000) if r["action"] in ("close", "partial close") and r["pnl_usd"] != ""]
        def summarize(rs):
            pnl = [float(r["pnl_usd"]) for r in rs]
            wins = [x for x in pnl if x > 0]
            losses = [x for x in pnl if x <= 0]
            return {"trades": len(pnl), "pnl": round(sum(pnl), 2),
                    "win_rate": round(len(wins) / len(pnl) * 100, 1) if pnl else 0,
                    "avg_win": round(sum(wins) / len(wins), 2) if wins else 0,
                    "avg_loss": round(sum(losses) / len(losses), 2) if losses else 0,
                    "profit_factor": round(sum(wins) / -sum(losses), 2) if losses and sum(losses) < 0 else None}
        by = {}
        for r in rows:
            by.setdefault(r["strategy"], []).append(r)
        return {"all": summarize(rows), "by_strategy": {k: summarize(v) for k, v in by.items()}}

    def status(self) -> dict:
        with self.lock:
            owners = self.state.get("owners", {})
            positions = []
            for p in self.last_positions:
                d = p.to_dict()
                o = owners.get(p.key, {})
                d.update(strategy=o.get("strategy", "outside the bot"), stop=o.get("stop"), take_profit=o.get("take_profit"),
                         managed=p.key in owners, label=p.label or o.get("label") or p.symbol[:8], reason=o.get("reason", ""))
                positions.append(d)
            connections = {}
            for venue in ("fomo", "liquid"):
                b = self.brokers.get(venue)
                if b is not None:
                    st = b.status() if self.live else {"name": venue, "connected": True, "detail": "Practice mode (live prices)"}
                else:
                    st = {"name": venue, "connected": False, "detail": self.broker_notes.get(venue) or "Turned off in settings"}
                connections[venue] = st
            day_start = self.state.get("day", {}).get("start_equity") or self.last_equity
            return {
                "mode": "live" if self.live else "paper",
                "equity": round(self.last_equity, 2),
                "day_pnl": round(self.last_equity - day_start, 2) if day_start else 0,
                "peak_equity": round(self.state.get("peak_equity", 0), 2),
                "paused": bool(self.state.get("paused")),
                "halted": self.state.get("halted", ""),
                "positions": positions,
                "events": list(self.events)[:150],
                "strategies": {n: {"enabled": bool(self.cfg["strategies"][n].get("enabled")), "note": s.last_note,
                                   "last_run": s.last_run, "venue": s.venue} for n, s in self.strategies.items()},
                "tradingview_enabled": bool(self.cfg["strategies"]["tradingview"].get("enabled")),
                "connections": connections,
                "last_tick": self.last_tick,
                "last_error": self.last_error,
                "equity_history": [(int(t), v) for t, v in list(self.equity_history)[-2000:]],
                "watch": self.watchlist(),
                "training": {"running": self.trainer.status["running"], "progress": self.trainer.status["progress"]},
            }

    def watchlist(self) -> list[dict]:
        meme = self.strategies.get("meme_scalper")
        if not meme:
            return []
        rows = [{"mint": m, **w} for m, w in meme.watch.items()]
        return sorted(rows, key=lambda r: (not r.get("setup"), r.get("symbol", "")))

    def training_report(self) -> dict:
        learned = {k: v for k, v in (self.trainer.learned or {}).items()}
        return {"status": self.trainer.status, "learned": learned, "journal": journal_feedback(self.trades(100000)),
                "paused_setups": sorted(getattr(self.strategies.get("meme_scalper"), "paused_setups", set()))}
