"""Configuration: defaults from default_config.toml, overridden by the user's file."""

from __future__ import annotations

import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULTS = Path(__file__).with_name("default_config.toml")

# Sections whose hardware driver is replaced by a simulator when --sim is given.
SIM_SECTIONS = (
    "camera", "thermal", "distance", "environment", "radar", "rf",
    "battery", "wallprobe", "detector", "hud", "voice",
)


def merge(base: dict, override: dict) -> dict:
    """Recursively merge ``override`` into a copy of ``base``."""
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = value
    return out


def load(path: str | Path | None = None, sim: bool = False) -> dict:
    """Load defaults, merge the user's TOML file (if given), apply --sim."""
    with DEFAULTS.open("rb") as f:
        cfg = tomllib.load(f)
    if path is not None:
        with Path(path).expanduser().open("rb") as f:
            cfg = merge(cfg, tomllib.load(f))
    if sim:
        for section in SIM_SECTIONS:
            cfg[section]["driver"] = "sim"
        cfg["voice"]["tts"] = "print"
    return cfg


def resolve(path: str) -> Path:
    """Resolve a config path; relative paths are relative to the project root."""
    p = Path(path).expanduser()
    return p if p.is_absolute() else ROOT / p
