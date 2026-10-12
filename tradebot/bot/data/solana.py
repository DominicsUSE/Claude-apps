"""Solana token data for the FOMO side: prices and activity from DexScreener and Jupiter,
and rug-pull checks from Jupiter's token audit and RugCheck. All free; Jupiter can take a key."""
import re
import time

from .. import http
from ..config import SOL_MINT, USDC_MINT, secret

DEX = "https://api.dexscreener.com"
RUGCHECK = "https://api.rugcheck.xyz/v1"
QUOTE_MINTS = {SOL_MINT, USDC_MINT, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}  # SOL, USDC, USDT


def _f(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def is_stock_token(pair: dict) -> bool:
    """Tokenized shares (xStocks such as NVDAx, "NVIDIA xStock") trade on Solana DEXes too. They move
    like the stock, not like a memecoin, so the meme scalper neither trades nor trains on them."""
    base = pair.get("baseToken") or {}
    name, symbol = str(base.get("name", "")), str(base.get("symbol", ""))
    return "xstock" in name.lower() or bool(re.fullmatch(r"[A-Z]{2,6}x", symbol))


def jupiter_base(kind: str) -> tuple[str, dict]:
    """Jupiter answers without a key at 0.5 requests/second; a free key (developers.jup.ag/portal)
    doubles that. lite-api.jup.ag is being retired, so api.jup.ag is always used."""
    key = secret("JUPITER_API_KEY")
    return f"https://api.jup.ag/{kind}", ({"x-api-key": key} if key else {})


class SolanaData:
    def __init__(self):
        self._price_cache: dict[str, tuple[float, float]] = {}
        self._safety_cache: dict[str, tuple[float, dict]] = {}

    # ---------- discovery ----------

    def candidate_mints(self) -> list[str]:
        """Tokens people are paying attention to right now: DexScreener boosts and new profiles,
        plus Jupiter's trending list. Order is kept, duplicates dropped."""
        mints: list[str] = []
        for path in ("/token-boosts/top/v1", "/token-boosts/latest/v1", "/token-profiles/latest/v1"):
            try:
                for item in http.get(DEX + path) or []:
                    if item.get("chainId") == "solana" and item.get("tokenAddress"):
                        mints.append(item["tokenAddress"])
            except http.HttpError:
                pass
        for item in self.jupiter_trending():
            mints.append(item.get("id", ""))
        seen, out = set(), []
        for m in mints:
            if m and m not in seen and m not in QUOTE_MINTS:
                seen.add(m)
                out.append(m)
        return out

    def jupiter_trending(self, window: str = "1h", limit: int = 50) -> list[dict]:
        base, headers = jupiter_base("tokens/v2")
        try:
            return http.get(f"{base}/toptrending/{window}", params={"limit": limit}, headers=headers) or []
        except http.HttpError:
            return []

    def pairs(self, mints: list[str]) -> dict[str, dict]:
        """mint -> its most liquid trading pair, in DexScreener's format."""
        best: dict[str, dict] = {}
        for i in range(0, len(mints), 30):
            batch = mints[i:i + 30]
            try:
                rows = http.get(f"{DEX}/tokens/v1/solana/{','.join(batch)}") or []
            except http.HttpError:
                continue
            for pair in rows:
                mint = (pair.get("baseToken") or {}).get("address")
                if mint not in batch:
                    continue
                liq = _f((pair.get("liquidity") or {}).get("usd"))
                if mint not in best or liq > _f((best[mint].get("liquidity") or {}).get("usd")):
                    best[mint] = pair
        now = time.time()
        for mint, pair in best.items():
            price = _f(pair.get("priceUsd"))
            if price > 0:
                self._price_cache[mint] = (now, price)
        return best

    # ---------- prices ----------

    def prices(self, mints: list[str], max_age: float = 10.0) -> dict[str, float]:
        now = time.time()
        stale = [m for m in mints if m not in self._price_cache or now - self._price_cache[m][0] > max_age]
        if stale:
            self.pairs(stale)
            missing = [m for m in stale if m not in self._price_cache or now - self._price_cache[m][0] > max_age]
            if missing:
                self._jupiter_prices(missing)
        return {m: self._price_cache[m][1] for m in mints if m in self._price_cache}

    def price(self, mint: str) -> float:
        if mint == USDC_MINT:
            return 1.0
        p = self.prices([mint]).get(mint)
        if not p:
            raise KeyError(f"No price for token {mint}")
        return p

    def _jupiter_prices(self, mints: list[str]) -> None:
        base, headers = jupiter_base("price/v3")
        for i in range(0, len(mints), 50):
            try:
                raw = http.get(base, params={"ids": ",".join(mints[i:i + 50])}, headers=headers) or {}
            except http.HttpError:
                continue
            now = time.time()
            for mint, row in raw.items():
                price = _f((row or {}).get("usdPrice"))
                if price > 0:
                    self._price_cache[mint] = (now, price)

    # ---------- safety ----------

    def token_info(self, mint: str) -> dict:
        base, headers = jupiter_base("tokens/v2")
        rows = http.get(f"{base}/search", params={"query": mint}, headers=headers) or []
        for row in rows:
            if row.get("id") == mint:
                return row
        return {}

    def rugcheck(self, mint: str) -> dict:
        return http.get(f"{RUGCHECK}/tokens/{mint}/report/summary") or {}

    def safety(self, mint: str, max_top10_pct: float, max_rug_score: float) -> dict:
        """{"ok": bool, "checked": bool, "reasons": [...]} -- cached for 15 minutes.
        "checked" is False when no safety source answered."""
        cached = self._safety_cache.get(mint)
        if cached and time.time() - cached[0] < 900:
            return cached[1]
        reasons, sources = [], 0
        try:
            info = self.token_info(mint)
            if info:
                sources += 1
                audit = info.get("audit") or {}
                if "isSus" in audit:
                    reasons.append("Jupiter flags this token as suspicious")
                if audit.get("mintAuthorityDisabled") is False or info.get("mintAuthority"):
                    reasons.append("the creator can still print more tokens (mint authority on)")
                if audit.get("freezeAuthorityDisabled") is False or info.get("freezeAuthority"):
                    reasons.append("the creator can freeze your tokens (freeze authority on)")
                top = audit.get("topHoldersPercentage")
                if top is not None and _f(top) > max_top10_pct:
                    reasons.append(f"top holders own {_f(top):.0f}% of supply")
        except http.HttpError:
            pass
        try:
            rc = self.rugcheck(mint)
            if rc:
                sources += 1
                score = _f(rc.get("score_normalised", rc.get("score")), 0)
                if score > max_rug_score:
                    reasons.append(f"RugCheck risk score {score:.0f}")
                for risk in rc.get("risks") or []:
                    if str(risk.get("level", "")).lower() == "danger":
                        reasons.append(f"RugCheck: {risk.get('name', 'danger')}")
        except http.HttpError:
            pass
        result = {"ok": sources > 0 and not reasons, "checked": sources > 0, "reasons": reasons}
        self._safety_cache[mint] = (time.time(), result)
        return result
