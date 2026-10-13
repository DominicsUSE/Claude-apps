"""A public address for TradingView alerts.

TradingView only sends alerts to an internet address on port 80 or 443, while the bot listens on
your computer. Cloudflare's free quick tunnel (the cloudflared program) bridges that: it gives an
https://<random>.trycloudflare.com address that forwards to the bot's alert port only, never to
the dashboard. The address changes every time the tunnel starts, so update your TradingView alerts
after a restart, or set webhook.public_url if you run a tunnel with a fixed address yourself.
"""
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from .config import secret

URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
INSTALL_HINT = {
    "win32": "install it with: winget install --id Cloudflare.cloudflared",
    "darwin": "install it with: brew install cloudflared",
}.get(sys.platform, "download it from developers.cloudflare.com (search: cloudflared downloads)")


def find_cloudflared(extra_dirs=()) -> str | None:
    """cloudflared on the PATH, in the usual install folders, or dropped into one of extra_dirs."""
    found = shutil.which("cloudflared")
    if found:
        return found
    candidates = [Path(d) / name for d in extra_dirs for name in ("cloudflared.exe", "cloudflared")]
    if sys.platform == "win32":
        for env in ("ProgramFiles", "ProgramFiles(x86)"):
            if os.environ.get(env):
                candidates.append(Path(os.environ[env]) / "cloudflared" / "cloudflared.exe")
        if os.environ.get("LOCALAPPDATA"):
            candidates.append(Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "WinGet" / "Links" / "cloudflared.exe")
    else:
        candidates += [Path("/opt/homebrew/bin/cloudflared"), Path("/usr/local/bin/cloudflared")]
    return next((str(p) for p in candidates if p.is_file()), None)


class Tunnel:
    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.url = ""
        self.error = ""

    def start(self, port: int, extra_dirs=()) -> bool:
        exe = find_cloudflared(extra_dirs)
        if not exe:
            self.error = f"cloudflared is not installed: {INSTALL_HINT}, then restart the bot"
            return False
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        try:
            self.proc = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                         text=True, errors="replace", creationflags=flags)
        except OSError as e:
            self.error = f"cloudflared could not start: {e}"
            return False
        threading.Thread(target=self._read, daemon=True).start()
        return True

    def _read(self) -> None:
        for line in self.proc.stdout:
            m = URL_RE.search(line)
            if m and not self.url:
                self.url = m.group(0)
            elif " ERR " in line and not self.url:
                self.error = line.strip()[-200:]
        code = self.proc.wait()
        self.url = ""
        self.error = self.error or f"the tunnel stopped (cloudflared exit code {code}): restart the bot"

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def status(self) -> dict:
        return {"running": bool(self.proc and self.proc.poll() is None), "url": self.url, "error": self.error,
                "install": INSTALL_HINT}


def wanted(cfg: dict) -> bool:
    """Open a tunnel only when TradingView alerts are on, an alert password is set, and you have not
    given your own public address."""
    w = cfg["webhook"]
    return (w["enabled"] and w.get("tunnel", "auto") == "auto" and not w.get("public_url")
            and cfg["strategies"]["tradingview"]["enabled"] and bool(secret("TV_WEBHOOK_SECRET")))
