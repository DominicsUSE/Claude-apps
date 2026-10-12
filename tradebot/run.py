"""Start the bot:            python run.py
Backtest from the terminal: python run.py backtest --strategy btc_regime --symbol BTC --source coinbase --days 3650
Walk-forward test:          python run.py walkforward --strategy trend --symbol ETH --interval 4h --days 730
Compare all strategies:     python run.py compare --symbol BTC --interval 1d
Check connections:          python run.py check
Train the meme scalper:     python run.py train --tokens 60          (Solana memecoins in the FOMO wallet)
                            python run.py train --profile liquid     (memecoin perps on Liquid)
"""
import argparse
import json
import logging
import logging.handlers
import sys
import time
import webbrowser

from bot import __version__
from bot import config as config_mod


def setup_logging() -> None:
    config_mod.DATA_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fh = logging.handlers.RotatingFileHandler(config_mod.DATA_DIR / "bot.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    root.addHandler(fh)
    root.addHandler(sh)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def ensure_config() -> dict:
    if not config_mod.CONFIG_PATH.exists():
        config_mod.ROOT.mkdir(parents=True, exist_ok=True)
        example = config_mod.BUNDLE / "config.example.json"
        config_mod.CONFIG_PATH.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        print("Created config.json with safe defaults (paper mode).")
    return config_mod.load_config()


def cmd_run(args) -> None:
    cfg = ensure_config()
    if config_mod.FROZEN:
        print(f"Your settings, keys and trade journal are kept in {config_mod.ROOT}")
    if args.paper:
        cfg["mode"] = "paper"
    from bot.engine import Engine
    from bot.server import serve
    engine = Engine(cfg)
    if cfg["mode"] == "live" and not config_mod.is_live(cfg):
        engine.event("blocked", 'config.json says "live" but live_trading_acknowledged is not true, so the bot is running in PAPER mode')
    serve(engine)
    url = f"http://{'localhost' if cfg['dashboard']['host'] in ('127.0.0.1', '0.0.0.0') else cfg['dashboard']['host']}:{cfg['dashboard']['port']}"
    print(f"\nTradebot {__version__} is running in {'LIVE' if engine.live else 'PAPER'} mode.")
    print(f"Dashboard: {url}")
    if cfg["webhook"]["enabled"]:
        print(f"TradingView webhook: http://127.0.0.1:{cfg['webhook']['port']}/webhook (see README to make it public)")
    print("Press Ctrl+C to stop. Open positions keep their exchange-side stops on Liquid.\n")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        engine.run_forever()
    except KeyboardInterrupt:
        engine.stop()
        engine.save_state()
        print("Stopped.")


def lab_opts(args) -> dict:
    opts = {k: v for k, v in vars(args).items() if v is not None and k not in ("func",)}
    if args.strategy == "eth_btc_pair" and "/" in args.symbol:
        opts["symbol_a"], opts["symbol_b"] = [s.strip() for s in args.symbol.split("/")]
    if args.params:
        opts["params"] = json.loads(args.params)
    return opts


def print_metrics(m: dict) -> None:
    for k, v in m.items():
        print(f"  {k:22} {v}")


def cmd_backtest(args) -> None:
    from bot import lab
    r = lab.run_backtest(lab_opts(args))
    if "error" in r:
        sys.exit(r["error"])
    print(f"\n{args.strategy} on {args.symbol} {args.interval}, {r['candles']} candles, settings {r['params']}")
    print_metrics(r["metrics"])
    print("\nMonte Carlo:", json.dumps(r["monte_carlo"], indent=1))


def cmd_walkforward(args) -> None:
    from bot import lab
    r = lab.run_walk_forward(lab_opts(args))
    if "error" in r:
        sys.exit(r["error"])
    print(f"\nWalk-forward {args.strategy} on {args.symbol} {args.interval}: {r['verdict']}  "
          f"(efficiency {r['walk_forward_efficiency']}, profitable windows {r['profitable_folds']})")
    for f in r["folds"]:
        print(f"  {time.strftime('%Y-%m-%d', time.gmtime(f['test_from'] / 1000))} -> {time.strftime('%Y-%m-%d', time.gmtime(f['test_to'] / 1000))}"
              f"  picked {f['params']}  in-sample {f['in_sample']['total_return_pct']:+.1f}%  out-of-sample {f['out_of_sample']['total_return_pct']:+.1f}%")
    print("\nOut-of-sample only:")
    print_metrics(r["out_of_sample"])


def cmd_compare(args) -> None:
    from bot import lab
    r = lab.compare(lab_opts(args))
    print(f"\n{args.symbol} {args.interval}, {r['candles']} candles")
    print(f"  {'strategy':34} {'return':>9} {'buy&hold':>9} {'max dd':>8} {'sharpe':>7} {'trades':>6}")
    for x in r["rows"]:
        print(f"  {x['label']:34} {x['total_return_pct']:>8.1f}% {x['buy_and_hold_pct']:>8.1f}% {x['max_drawdown_pct']:>7.1f}% {x['sharpe']:>7} {x['trades']:>6}")


def cmd_train(args) -> None:
    from bot.data.dex_candles import DexCandles
    from bot.data.hyperliquid import HyperliquidData
    from bot.data.solana import SolanaData
    from bot.training import Trainer
    cfg = ensure_config()
    config_mod.DATA_DIR.mkdir(parents=True, exist_ok=True)
    trainer = Trainer(config_mod.DATA_DIR, SolanaData(), DexCandles(config_mod.DATA_DIR / "candles"),
                      HyperliquidData(cfg["venues"]["liquid"]["api_url"]), cfg["strategies"]["meme_scalper"]["liquid_markets"])
    what = "Liquid memecoin perps" if args.profile == "liquid" else f"up to {args.tokens} Solana memecoin charts"
    print(f"Collecting {what} ({args.interval}) and training...")
    r = trainer.run(args.profile, args.tokens, args.interval)
    if "error" in r:
        sys.exit(r["error"])
    trainer.save(args.profile, r)
    print(f"\n{r['tokens']} charts, {r['candles']} candles. Verdict: {r['verdict']}")
    print(f"Chosen settings: {r['params']}; setups in use: {', '.join(r['setups']) or 'none'}")
    for part in ("train", "test"):
        st = r[part]
        print(f"  {'practice' if part == 'train' else 'UNSEEN':8} trades {st['trades']:4}  win {st['win_rate']:5}%  avg {st['avg_pct']:+6.2f}%  "
              f"avg R {st['avg_r']:+5.2f}  PF {st['profit_factor']}  t {st['t_stat']}")
    for s, st in r["per_setup"]["test"].items():
        print(f"    unseen {s:13} trades {st['trades']:4}  win {st['win_rate']:5}%  avg {st['avg_pct']:+6.2f}%")
    from collections import Counter
    print("  exits on unseen charts:", dict(Counter(t["exit_reason"] for t in r["sample_trades"])))


def cmd_check(args) -> None:
    cfg = ensure_config()
    from bot.data.hyperliquid import HyperliquidData
    from bot.data.solana import SolanaData
    from bot.config import secret
    ok = True

    def line(name, fn):
        nonlocal ok
        try:
            print(f"  OK   {name}: {fn()}")
        except Exception as e:
            ok = False
            print(f"  FAIL {name}: {e}")

    hl, sol = HyperliquidData(cfg["venues"]["liquid"]["api_url"]), SolanaData()
    print("Market data")
    line("Liquid / Hyperliquid prices", lambda: f"BTC ${hl.price('BTC'):,.0f}")
    line("Liquid stock markets", lambda: f"{len(hl.markets('xyz'))} markets, e.g. NVDA listed: {hl.has_market('xyz:NVDA')}")
    def tokens():
        mints = sol.candidate_mints()
        if not mints:
            raise RuntimeError("no trending tokens returned (DexScreener and Jupiter unreachable?)")
        return f"{len(mints)} trending tokens found"
    line("DexScreener + Jupiter (FOMO tokens)", tokens)

    def meme_chart():
        from bot.data.dex_candles import DexCandles
        pairs = sol.pairs(sol.candidate_mints()[:30])
        mint, pr = max(pairs.items(), key=lambda kv: float((kv[1].get("liquidity") or {}).get("usd") or 0))
        candles = DexCandles().closed(pr["pairAddress"], "5m", 100)
        if not candles:
            raise RuntimeError("no candles returned")
        return f"{(pr.get('baseToken') or {}).get('symbol')}: {len(candles)} five-minute candles"
    line("GeckoTerminal memecoin charts", meme_chart)
    print("Your accounts")
    from bot.connections import test_fomo, test_liquid
    for title, rows in (("FOMO", test_fomo(cfg["venues"]["fomo"])), ("Liquid", test_liquid(cfg["venues"]["liquid"]))):
        for r in rows:
            mark = {True: "OK  ", False: "FAIL", None: "--  "}[r["ok"]]
            ok = ok and r["ok"] is not False
            print(f"  {mark} {title} {r['name']}: {r['detail']}")
    print("Optional services")
    if secret("QUIVER_API_TOKEN"):
        from bot.data import quiver
        line("Quiver congress data", lambda: f"{len(quiver.fetch())} recent filings")
    else:
        print("  --   Quiver: QUIVER_API_TOKEN not set (needed for the congress strategy)")
    if cfg["research"]["enabled"]:
        from bot.research import Research
        line("News check", lambda: Research(cfg["research"]).sentiment("Bitcoin"))
    print("TradingView alerts:", "password set" if secret("TV_WEBHOOK_SECRET") else "TV_WEBHOOK_SECRET not set (alerts will be refused)")
    sys.exit(0 if ok else 1)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # token names with emoji must not crash a Windows console
        except (AttributeError, ValueError):
            pass
    config_mod.load_env()
    p = argparse.ArgumentParser(description="Tradebot: FOMO, Liquid and TradingView trading bot")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="start the bot and dashboard (default)")
    r.add_argument("--paper", action="store_true", help="force paper mode")
    r.add_argument("--no-browser", action="store_true")
    for name, fn in (("backtest", cmd_backtest), ("walkforward", cmd_walkforward), ("compare", cmd_compare)):
        b = sub.add_parser(name)
        b.add_argument("--strategy", default="trend")
        b.add_argument("--symbol", default="BTC", help='e.g. BTC, ETH, xyz:NVDA, or "BTC/ETH" for the pair strategy')
        b.add_argument("--interval", default="1d")
        b.add_argument("--days", type=int, default=1095)
        b.add_argument("--source", default="liquid", choices=["liquid", "coinbase"])
        b.add_argument("--capital", type=float)
        b.add_argument("--position-pct", dest="position_pct", type=float)
        b.add_argument("--leverage", type=float)
        b.add_argument("--fee-pct", dest="fee_pct", type=float)
        b.add_argument("--slippage-pct", dest="slippage_pct", type=float)
        b.add_argument("--objective", choices=["sharpe", "return", "return_over_drawdown", "profit_factor"])
        b.add_argument("--params", help='JSON, e.g. \'{"fast": 10}\'')
        b.set_defaults(func=fn)
    sub.add_parser("check", help="test every connection").set_defaults(func=cmd_check)
    t = sub.add_parser("train", help="study recent memecoin charts and pick the meme scalper's settings")
    t.add_argument("--tokens", type=int, default=60)
    t.add_argument("--interval", default="5m", choices=["1m", "5m", "15m"])
    t.add_argument("--profile", default="fomo", choices=["fomo", "liquid"], help="fomo = Solana tokens, liquid = memecoin perps")
    t.set_defaults(func=cmd_train)
    argv = sys.argv[1:]
    commands = {"run", "backtest", "walkforward", "compare", "check", "train"}
    if not argv or (argv[0] not in commands and argv[0] not in ("-h", "--help", "--version")):
        argv = ["run"] + argv          # "Tradebot --paper" means "Tradebot run --paper"
    args = p.parse_args(argv)
    if args.cmd == "run":
        setup_logging()
        return cmd_run(args)
    args.func(args)


if __name__ == "__main__":
    main()
