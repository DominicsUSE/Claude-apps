"""Alert policy: sensor snapshot -> prioritised warnings for the HUD and voice.

Each alert is (key, hud_text, level): level 1 = info, 2 = warning (inverted
ticker), 3 = critical (blinking). Thresholds live in [alerts] in the config.
"""

from __future__ import annotations

Alert = tuple[str, str, int]


def evaluate(s: dict, cfg: dict, cpu_limit: float) -> list[Alert]:
    out: list[Alert] = []
    if (w := s.get("wall")) and w.get("live_ac"):
        out.append(("live_ac", "LIVE AC NEARBY", 3))
    dist = s.get("distance")
    if dist is not None and dist < cfg["obstacle_m"]:
        out.append(("obstacle", f"OBSTACLE {dist:.1f}m", 2))
    if (ts := s.get("thermal_stats")) and ts["max"] >= cfg["hot_c"]:
        out.append(("hot", f"HOT SURFACE {ts['max']:.0f}C", 2))
    sysm = s.get("system") or {}
    if sysm.get("undervolt"):
        out.append(("undervolt", "LOW SUPPLY VOLTAGE", 2))
    r = s.get("radar") or {}
    if r.get("moving") and r.get("distance_m") is not None and r["distance_m"] < cfg["motion_m"]:
        out.append(("motion", f"MOTION {r['distance_m']:.1f}m", 1))
    soc = (s.get("battery") or {}).get("soc")
    if soc is not None and soc <= cfg["battery_low_pct"]:
        out.append(("battery", f"BATTERY {soc:.0f}%", 1))
    if (sysm.get("cpu_c") or 0) >= cpu_limit:
        out.append(("cpu", f"CPU HOT {sysm['cpu_c']:.0f}C", 1))
    return sorted(out, key=lambda a: -a[2])


SPOKEN = {"live_ac": "Warning, live wire detected.", "obstacle": "Obstacle ahead.",
          "hot": "Hot surface.", "undervolt": "Power supply too weak.",
          "battery": "Battery low.", "motion": "Movement nearby."}
