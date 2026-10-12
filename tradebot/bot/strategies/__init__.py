from .candles import CandleStrategy
from .congress import CongressStrategy
from .fomo_momentum import FomoMomentum
from .meme import MemeScalper
from .pair import PairStrategy

CANDLE_NAMES = ("trend", "btc_regime", "breakout", "mean_reversion", "supertrend", "macd", "heikin_ashi")


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
