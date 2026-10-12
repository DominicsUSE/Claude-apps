"""Optional news check before a trade, using Perplexity or Grok (xAI).

Asks the model for a sentiment score from -1 (very bad news) to +1 (very good news) and a
one-line reason. A long is blocked when the score is at or below -veto_score; a short when it
is at or above +veto_score. If the service fails, the trade is not blocked (the risk limits
still apply) and the failure is logged.
"""
import json
import re
import time

from . import http
from .config import secret

ENDPOINTS = {
    "perplexity": ("https://api.perplexity.ai/chat/completions", "PERPLEXITY_API_KEY", "perplexity_model"),
    "grok": ("https://api.x.ai/v1/chat/completions", "XAI_API_KEY", "grok_model"),
}

PROMPT = (
    "You are checking recent news and social sentiment for a trader. Asset: {name}. "
    "Look at news and posts from the last 48 hours only. Reply with JSON only, no other text: "
    '{{"score": <number from -1 to 1>, "reason": "<one sentence>"}}. '
    "-1 means clearly bad news (hack, rug pull, lawsuit, delisting, crash), +1 clearly good news, 0 nothing notable."
)


class Research:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._cache: dict[str, tuple[float, dict]] = {}

    def available(self) -> bool:
        provider = self.cfg.get("provider", "perplexity")
        return provider in ENDPOINTS and bool(secret(ENDPOINTS[provider][1]))

    def sentiment(self, name: str) -> dict:
        cached = self._cache.get(name)
        if cached and time.time() - cached[0] < self.cfg.get("cache_minutes", 30) * 60:
            return cached[1]
        provider = self.cfg.get("provider", "perplexity")
        url, key_name, model_key = ENDPOINTS[provider]
        body = {
            "model": self.cfg.get(model_key),
            "messages": [{"role": "user", "content": PROMPT.format(name=name)}],
            "temperature": 0,
        }
        raw = http.post(url, json=body, headers={"Authorization": f"Bearer {secret(key_name)}"}, timeout=60, retries=1)
        text = raw["choices"][0]["message"]["content"]
        result = parse_reply(text)
        result["provider"] = provider
        self._cache[name] = (time.time(), result)
        return result

    def veto(self, name: str, side: str) -> tuple[bool, str]:
        """(blocked?, explanation)."""
        if not self.cfg.get("enabled") or not self.available():
            return False, ""
        try:
            s = self.sentiment(name)
        except Exception as e:  # never let a news lookup crash trading
            return False, f"news check failed: {e}"
        limit = float(self.cfg.get("veto_score", 0.5))
        note = f"news {s['score']:+.2f}: {s['reason']}"
        if side == "buy" and s["score"] <= -limit:
            return True, note
        if side == "sell" and s["score"] >= limit:
            return True, note
        return False, note


def parse_reply(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"no JSON in reply: {text[:120]}")
    data = json.loads(match.group(0))
    score = max(-1.0, min(1.0, float(data.get("score", 0))))
    return {"score": score, "reason": str(data.get("reason", ""))[:300]}
