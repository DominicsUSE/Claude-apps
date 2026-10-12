"""Settings.

config.json holds every knob (risk limits, strategies, venues) and is safe to share.
.env holds keys and passwords; it is never committed and never shown on the dashboard.
Anything missing from config.json falls back to DEFAULTS below.
"""
import copy
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CONFIG_PATH = ROOT / "config.json"
ENV_PATH = ROOT / ".env"

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
SOL_MINT = "So11111111111111111111111111111111111111112"

DEFAULTS = {
    # "paper" simulates every trade with live prices. "live" sends real orders.
    "mode": "paper",
    # Live mode also needs this set to true, so a typo in "mode" can never risk real money.
    "live_trading_acknowledged": False,
    "loop_seconds": 20,
    "dashboard": {"host": "127.0.0.1", "port": 8787},
    # TradingView alerts arrive here. Keep it on its own port so a public tunnel never exposes the dashboard.
    "webhook": {"enabled": True, "host": "127.0.0.1", "port": 8788},
    "paper": {"starting_balance_usd": 1000.0, "fee_pct": 0.1, "slippage_pct": 0.3},
    "risk": {
        "risk_per_trade_pct": 1.0,        # at most this % of equity is lost if a stop is hit
        "max_position_usd": 100.0,        # hard cap per position
        "min_position_usd": 10.0,         # exchanges reject smaller orders
        "max_open_positions": 5,
        "max_positions_per_strategy": 3,
        "max_total_exposure_pct": 150.0,  # sum of all position sizes vs equity
        "max_leverage": 3,
        "daily_loss_limit_pct": 5.0,      # stop opening trades for the rest of the UTC day
        "max_drawdown_pct": 20.0,         # stop opening trades until you press Resume
        "default_stop_loss_pct": 5.0,     # used when a signal has no stop
        "max_stop_loss_pct": 30.0,        # wider stops are rejected
        "cooldown_minutes": 60,           # no re-entry into a market right after a losing exit
        "max_consecutive_errors": 5,      # pause after this many failed orders in a row
        "allowed_symbols": [],            # empty = any; otherwise only these
        "blocked_symbols": [],
    },
    "venues": {
        "fomo": {
            "enabled": True,
            "quote": "USDC",              # USDC or SOL: what the bot spends and receives
            "slippage_bps": 300,          # 3%: memecoins move fast
            "min_sol_for_fees": 0.02,     # keep this much SOL so swaps can always pay fees
            "jupiter_url": "https://api.jup.ag/swap/v2",
            "rpc_url": "https://api.mainnet-beta.solana.com",
        },
        "liquid": {
            "enabled": True,
            "api_url": "https://api.hyperliquid.xyz",
            "slippage_pct": 1.0,
        },
    },
    "strategies": {
        "meme_scalper": {
            "enabled": True,
            "venue": "fomo",
            "every_seconds": 60,
            "position_usd": 25.0,
            "watch_count": 12,                # how many trending tokens to chart at once
            "min_liquidity_usd": 50000,
            "min_volume_h24_usd": 250000,
            "min_age_hours": 1,               # skip brand-new launches (sniper and rug territory)
            "max_age_hours": 0,               # 0 = no upper limit: established memecoins like BONK and WIF count too
            "min_market_cap_usd": 200000,
            "max_market_cap_usd": 200000000,
            "max_top10_holders_pct": 35,
            "max_rugcheck_score": 500,
            "require_safety_check": True,
            "max_new_per_hour": 3,
            "max_pool_share_pct": 0.5,        # never buy more than this % of the pool's liquidity (keeps slippage small)
            "liquidity_drop_exit_pct": 30,    # sell at once if the pool loses this much liquidity after we buy (rug pull)
            "use_learned": True,              # use the settings training found
            "train_every_hours": 24,          # retrain on fresh charts once a day
            "trade_unproven_live": False,     # live money only follows settings that made money on unseen charts
            "chart": {},                      # override chart settings, e.g. {"interval": "1m", "rvol_min": 3}
            "fomo_enabled": True,             # Solana memecoins in your FOMO wallet
            "liquid_enabled": True,           # memecoin perps on Liquid (long and short, much lower fees)
            "liquid_markets": ["kPEPE", "WIF", "FARTCOIN", "kBONK", "POPCAT", "PENGU", "MEME", "TRUMP", "MOODENG",
                               "PNUT", "kSHIB", "DOGE", "kFLOKI", "SPX", "GOAT", "BRETT", "MEW", "TURBO", "CHILLGUY"],
            "liquid_position_usd": 25.0,
            "liquid_leverage": 2,
            "liquid_shorts": True,
            "liquid_max_new_per_hour": 4,
            "liquid_chart": {},               # override chart settings for Liquid only
        },
        "fomo_momentum": {
            "enabled": False,                 # the older screen-only version; meme_scalper reads the chart too
            "venue": "fomo",
            "every_seconds": 120,
            "position_usd": 25.0,
            "min_liquidity_usd": 75000,
            "min_volume_h1_usd": 50000,
            "min_volume_h24_usd": 400000,
            "min_age_hours": 2,
            "max_age_hours": 24 * 21,
            "min_market_cap_usd": 300000,
            "max_market_cap_usd": 150000000,
            "min_change_h1_pct": 3,
            "max_change_h1_pct": 60,          # do not chase vertical candles
            "min_change_m5_pct": 0,
            "min_buy_sell_ratio_h1": 1.15,
            "max_top10_holders_pct": 35,
            "max_rugcheck_score": 500,        # rugcheck "score_normalised"; lower is safer
            "require_safety_check": True,     # skip a token if the safety check cannot be done
            "stop_loss_pct": 15,
            "take_profit": [[30, 0.5], [80, 0.25]],  # sell 50% at +30%, 25% more at +80%
            "trailing_stop_pct": 18,
            "max_hold_hours": 12,
            "max_new_per_hour": 2,
        },
        "trend": {
            "enabled": False,             # failed a walk-forward test on ETH 4h: test it yourself before turning it on
            "venue": "liquid",
            "every_seconds": 300,
            "symbols": ["BTC", "ETH", "SOL"],
            "interval": "4h",
            "fast": 20,
            "slow": 50,
            "trend_filter": 200,
            "rsi_period": 14,
            "atr_period": 14,
            "atr_stop": 2.0,
            "reward_risk": 2.5,
            "allow_shorts": True,
            "leverage": 2,
        },
        "btc_regime": {
            "enabled": False,
            "venue": "liquid",
            "every_seconds": 900,
            "symbol": "BTC",
            "interval": "1d",
            "fast": 21,                   # EMAs of the typical price (high + low + close) / 3
            "slow": 55,
            "std_period": 50,
            "std_smooth": 10,
            "mult": 1.0,                  # band width in smoothed standard deviations
            "slope_ma": 0,                # e.g. 140 (about 20 weeks): only enter while this average rises
            "atr_period": 14,
            "atr_stop": 3.0,              # disaster stop 3 ATR below entry
            "leverage": 1,
        },
        "eth_btc_pair": {
            "enabled": False,
            "venue": "liquid",
            "every_seconds": 900,
            "symbol_a": "BTC",            # ratio = BTC / ETH, as in the video
            "symbol_b": "ETH",
            "interval": "1d",
            "lookback": 30,               # 30-day mean and standard deviation
            "upper_k": 2.0,               # exit above mean + 2 std
            "lower_k": 1.0,               # enter below mean - 1 std
            "both_sides": False,          # also short the ratio above the upper band
            "stop_k": 0,                  # optional ratio stop, in std below the mean (0 = off)
            "leg_usd": 50.0,
            "leg_stop_pct": 20,           # disaster stop on each leg
            "max_hold_bars": 60,
            "leverage": 1,
        },
        "congress": {
            "enabled": False,
            "venue": "liquid",
            "every_seconds": 3600,
            "lookback_days": 10,
            "min_trade_usd": 15001,
            "min_buyers": 1,
            "position_usd": 40.0,
            "stop_loss_pct": 10,
            "take_profit_pct": 25,
            "max_hold_days": 30,
            "max_new_per_day": 2,
        },
        "tradingview": {
            "enabled": True,
            "default_size_usd": 25.0,
            "default_stop_loss_pct": 4,
            "default_venue": "liquid",
        },
    },
    "research": {
        "enabled": False,
        "provider": "perplexity",          # perplexity or grok
        "perplexity_model": "sonar",
        "grok_model": "grok-4",
        "veto_score": 0.5,                 # block a long when news sentiment <= -0.5 (and the reverse for shorts)
        "cache_minutes": 30,
    },
}

SECRET_NAMES = [
    "FOMO_WALLET_PRIVATE_KEY",
    "JUPITER_API_KEY",
    "SOLANA_RPC_URL",
    "HL_ACCOUNT_ADDRESS",
    "HL_API_PRIVATE_KEY",
    "TV_WEBHOOK_SECRET",
    "QUIVER_API_TOKEN",
    "PERPLEXITY_API_KEY",
    "XAI_API_KEY",
]


def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def load_env(path: Path | None = None) -> None:
    """Read KEY=VALUE lines from .env into the environment (real environment variables win)."""
    path = path or ENV_PATH
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def secret(name: str):
    value = os.environ.get(name, "").strip()
    return value or None


def load_config(path: Path | None = None) -> dict:
    path = path or CONFIG_PATH
    user = {}
    if path.exists():
        user = json.loads(path.read_text(encoding="utf-8"))
    cfg = deep_merge(DEFAULTS, user)
    validate(cfg)
    return cfg


def save_config(cfg: dict, path: Path | None = None) -> None:
    path = path or CONFIG_PATH
    validate(cfg)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    tmp.replace(path)


def validate(cfg: dict) -> None:
    if cfg["mode"] not in ("paper", "live"):
        raise ValueError('"mode" must be "paper" or "live"')
    r = cfg["risk"]
    for key in ("risk_per_trade_pct", "max_position_usd", "daily_loss_limit_pct", "max_drawdown_pct", "default_stop_loss_pct"):
        if not isinstance(r[key], (int, float)) or r[key] <= 0:
            raise ValueError(f'risk "{key}" must be a positive number')
    if r["risk_per_trade_pct"] > 10:
        raise ValueError("risk_per_trade_pct above 10% is not allowed: a short losing streak would wipe the account")
    if r["max_leverage"] < 1 or r["max_leverage"] > 20:
        raise ValueError("max_leverage must be between 1 and 20")
    if cfg["venues"]["fomo"]["quote"] not in ("USDC", "SOL"):
        raise ValueError('fomo "quote" must be "USDC" or "SOL"')


def is_live(cfg: dict) -> bool:
    return cfg["mode"] == "live" and cfg.get("live_trading_acknowledged") is True
