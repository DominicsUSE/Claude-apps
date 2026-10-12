"""Small HTTP helper: one session, timeouts, a couple of retries and a per-host speed limit."""
import threading
import time
from urllib.parse import urlparse

import requests

_session = requests.Session()
_session.headers.update({"User-Agent": "tradebot/1.0", "Accept": "application/json"})
_lock = threading.Lock()
_last_call: dict[str, float] = {}

# Minimum seconds between calls to the same host, to stay under free-tier rate limits.
MIN_INTERVAL = {
    "api.dexscreener.com": 0.25,
    "api.rugcheck.xyz": 0.5,
    "api.quiverquant.com": 1.0,
}


class HttpError(Exception):
    pass


def _wait_turn(host: str) -> None:
    gap = MIN_INTERVAL.get(host, 0)
    if not gap:
        return
    with _lock:
        now = time.monotonic()
        wait = _last_call.get(host, 0) + gap - now
        _last_call[host] = max(now, _last_call.get(host, 0) + gap)
    if wait > 0:
        time.sleep(wait)


def request(method: str, url: str, *, json=None, params=None, headers=None, timeout: float = 15, retries: int = 2):
    host = urlparse(url).hostname or ""
    last_error = None
    for attempt in range(retries + 1):
        _wait_turn(host)
        try:
            r = _session.request(method, url, json=json, params=params, headers=headers, timeout=timeout)
        except requests.RequestException as e:
            last_error = e
        else:
            if r.status_code == 429:
                last_error = HttpError(f"{host} answered 429 (too many requests)")
                if attempt < retries:
                    try:
                        wait = float(r.headers.get("Retry-After") or 0)
                    except ValueError:
                        wait = 0
                    time.sleep(min(wait or 12.0 * (attempt + 1), 60))
                    continue
            elif r.status_code >= 500:
                last_error = HttpError(f"{host} answered {r.status_code}")
            elif r.status_code >= 400:
                raise HttpError(f"{host} answered {r.status_code}: {r.text[:300]}")
            else:
                try:
                    return r.json()
                except ValueError:
                    raise HttpError(f"{host} sent something that is not JSON: {r.text[:200]}")
        if attempt < retries:
            time.sleep(1.5 * (attempt + 1))
    raise HttpError(f"{host} could not be reached: {last_error}")


def get(url: str, **kw):
    return request("GET", url, **kw)


def post(url: str, **kw):
    return request("POST", url, **kw)
