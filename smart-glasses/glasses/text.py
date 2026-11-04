"""Turn hub state into words: spoken status, AI context, offline answers."""

from __future__ import annotations


def direction(x: float) -> str:
    """Horizontal position 0..1 in the camera view -> spoken direction."""
    if x < 0.33:
        return "on the left"
    if x > 0.66:
        return "on the right"
    return "ahead"


def _num(v, fmt: str, unit: str) -> str:
    return "unknown" if v is None else f"{v:{fmt}} {unit}"


def status_sentence(what: str, s: dict) -> str:
    """Short spoken answer for 'distance', 'battery', 'temperature', 'status'."""
    dist = s.get("distance")
    bat = s.get("battery") or {}
    ts = s.get("thermal_stats")
    env = s.get("environment") or {}
    if what == "distance":
        return "Nothing in range." if dist is None else f"{dist:.1f} meters."
    if what == "battery":
        if bat.get("soc") is None:
            return "Battery level unknown."
        runtime = bat.get("runtime_h")
        extra = f", about {runtime:.1f} hours left" if runtime else ""
        return f"Battery {bat['soc']:.0f} percent{extra}."
    if what == "temperature":
        parts = []
        if env.get("temp_c") is not None:
            parts.append(f"Air {env['temp_c']:.0f} degrees")
        elif s.get("ambient_c") is not None:
            parts.append(f"Ambient about {s['ambient_c']:.0f} degrees")
        if ts:
            parts.append(f"centre spot {ts['center']:.0f}, hottest {ts['max']:.0f} "
                         f"{direction(ts['hot_x'])}")
        return (", ".join(parts) + ".") if parts else "No temperature sensor."
    sysm = s.get("system") or {}
    cpu = sysm.get("cpu_c")
    return (f"Mode {s.get('mode', 'normal')}. Battery {_num(bat.get('soc'), '.0f', 'percent')}. "
            f"CPU {_num(cpu, '.0f', 'degrees')}.")


def sensor_context(s: dict) -> str:
    """Compact sensor summary sent to the AI model with each question."""
    lines = [f"view mode: {s.get('mode', 'normal')}, zoom {s.get('zoom', 1.0):.1f}x"]
    if (d := s.get("distance")) is not None:
        lines.append(f"laser distance straight ahead: {d:.2f} m")
    if ts := s.get("thermal_stats"):
        lines.append(f"thermal camera: min {ts['min']:.1f} C, max {ts['max']:.1f} C "
                     f"({direction(ts['hot_x'])}), centre {ts['center']:.1f} C")
    if r := s.get("radar"):
        state = "moving target" if r.get("moving") else "still target" if r.get("presence") else "no target"
        dist = f" at {r['distance_m']:.1f} m" if r.get("distance_m") else ""
        lines.append(f"radar: {state}{dist}")
    if env := s.get("environment"):
        lines.append(f"air: {env['temp_c']} C, {env['humidity']} % RH, {env['pressure_hpa']} hPa")
    if dets := s.get("detections"):
        found = ", ".join(f"{x['label']} {x['score']:.0%} {direction(x['box'][0] + x['box'][2] / 2)}"
                          for x in dets[:6])
        lines.append(f"on-device detector: {found}")
    if (w := s.get("wall")) and not w.get("calibrating"):
        flags = [k for k in ("stud", "metal", "live_ac") if w.get(k)]
        lines.append(f"wall probe flags: {', '.join(flags) or 'none'}")
    if rf := s.get("rf"):
        lines.append(f"radio: {rf.get('wifi_count', '?')} wifi networks, {rf.get('ble_count', '?')} BLE devices")
    return "\n".join(lines)


def local_answer(s: dict) -> str:
    """Offline description built from on-device sensors only."""
    parts = []
    dets = s.get("detections") or []
    if dets:
        seen = [f"a {d['label']} {direction(d['box'][0] + d['box'][2] / 2)}" for d in dets[:3]]
        parts.append("I see " + ", ".join(seen))
    if (dist := s.get("distance")) is not None:
        parts.append(f"nearest obstacle {dist:.1f} meters")
    if ts := s.get("thermal_stats"):
        parts.append(f"hottest spot {ts['max']:.0f} degrees {direction(ts['hot_x'])}")
    if not parts:
        return "I can't tell right now."
    return ". ".join(p[0].upper() + p[1:] for p in parts) + "."
