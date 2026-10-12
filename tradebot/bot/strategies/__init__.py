from .candles import CandleStrategy
from .congress import CongressStrategy
from .fomo_momentum import FomoMomentum
from .meme import MemeScalper
from .pair import PairStrategy

CANDLE_NAMES = ("trend", "btc_regime", "breakout", "mean_reversion", "supertrend", "macd", "heikin_ashi")

DESCRIPTIONS = {
    "meme_scalper": "Reads 5-minute memecoin charts and trades breakouts, pullbacks and VWAP reclaims in your FOMO wallet.",
    "fomo_momentum": "Buys trending Solana memecoins in your FOMO wallet after rug checks; sells in steps with a trailing stop.",
    "trend": "EMA crossover with a 200 EMA trend filter, RSI check and ATR stops on Liquid perps.",
    "btc_regime": "Bitcoin volatility-regime trend following (from your Bitcoin video): long in bull regimes, cash in bear ones.",
    "eth_btc_pair": "BTC/ETH ratio mean reversion (from your pair-trading video): long BTC + short ETH when BTC is cheap vs ETH.",
    "congress": "Follows stock purchases reported by members of Congress (Quiver data), traded as stock perps on Liquid.",
    "tradingview": "Trades the alerts your TradingView charts and Pine strategies send to the bot.",
}


def build(name: str, cfg: dict, state: dict, trainer=None, candles=None):
    if name == "meme_scalper":
        return MemeScalper(cfg, state, trainer, candles)
    if name == "fomo_momentum":
        return FomoMomentum(cfg, state)
    if name == "eth_btc_pair":
        return PairStrategy(cfg, state)
    if name == "congress":
        return CongressStrategy(cfg, state)
    if name in CANDLE_NAMES or cfg.get("kind") in CANDLE_NAMES:
        return CandleStrategy(name, cfg, state)
    return None
