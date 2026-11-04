"""Byte-level parsers and text parsing - no hardware needed."""

import struct

from glasses.ai.voice import apply_gain, parse_command
from glasses.sensors.radar import parse_ld2410, parse_ld2450
from glasses.sensors.rf import parse_nmcli, parse_rtl_power


def ld2410_frame(state, move_cm, still_cm, detect_cm):
    body = bytes([0x02, 0xAA, state]) + struct.pack("<HBHBH", move_cm, 40, still_cm, 30, detect_cm) + b"\x55\x00"
    return b"\xF4\xF3\xF2\xF1" + struct.pack("<H", len(body)) + body + b"\xF8\xF7\xF6\xF5"


def test_ld2410_parses_latest_frame_and_skips_garbage():
    buf = bytearray(b"\x00\x13" + ld2410_frame(1, 150, 0, 150) + b"\xFF" + ld2410_frame(2, 0, 220, 220))
    report, rest = parse_ld2410(buf)
    assert report["presence"] and report["still"] and not report["moving"]
    assert report["distance_m"] == 2.2
    assert len(rest) <= 3


def test_ld2410_keeps_partial_frame_for_next_read():
    frame = ld2410_frame(1, 90, 0, 90)
    report, rest = parse_ld2410(bytearray(frame[:10]))
    assert report is None
    report, _ = parse_ld2410(rest + frame[10:])
    assert report["moving"] and report["distance_m"] == 0.9


def test_ld2410_no_target_has_no_distance():
    report, _ = parse_ld2410(bytearray(ld2410_frame(0, 0, 0, 0)))
    assert report["presence"] is False and report["distance_m"] is None


def ld2450_frame(targets):
    def enc(v):  # sign-magnitude, MSB set = positive
        return (0x8000 | v) if v >= 0 else (-v & 0x7FFF)
    payload = b""
    for x, y, speed in targets:
        payload += struct.pack("<HHHH", enc(x), enc(y), enc(speed), 320)
    payload += b"\x00" * 8 * (3 - len(targets))
    return b"\xAA\xFF\x03\x00" + payload + b"\x55\xCC"


def test_ld2450_decodes_signed_coordinates():
    report, _ = parse_ld2450(bytearray(ld2450_frame([(-300, 1200, 25), (500, 2500, 0)])))
    first, second = report["targets"]
    assert (first["x_m"], first["y_m"], first["speed_mps"]) == (-0.3, 1.2, 0.25)
    assert second["x_m"] == 0.5
    assert report["moving"] and report["distance_m"] == round((0.3**2 + 1.2**2) ** 0.5, 2)


def test_ld2450_empty_frame_means_no_presence():
    report, _ = parse_ld2450(bytearray(ld2450_frame([])))
    assert report == {"presence": False, "moving": False, "still": False, "distance_m": None, "targets": []}


def test_rtl_power_peak():
    csv = ("2026-11-04, 10:00:00, 433000000, 434000000, 250000.00, 10, -40.0, -12.5, -39.0, -41.0\n"
           "2026-11-04, 10:00:00, 434000000, 435000000, 250000.00, 10, -42.0, -40.0, nan, -38.0\n")
    r = parse_rtl_power(csv)
    assert r["sdr_peak_mhz"] == 433.25 and r["sdr_peak_db"] == -12.5
    assert parse_rtl_power("") is None


def test_nmcli_counts_networks():
    assert parse_nmcli("72\n40\n\n15\n") == {"wifi_count": 3, "wifi_best_pct": 72}
    assert parse_nmcli("") == {"wifi_count": 0, "wifi_best_pct": None}


def test_voice_commands():
    assert parse_command("Thermal mode please") == ("mode", "thermal")
    assert parse_command("switch to night vision") == ("mode", "night")
    assert parse_command("zoom in") == ("zoom", 1)
    assert parse_command("how far is that") == ("say", "distance")
    assert parse_command("what do you see") == ("describe", None)
    assert parse_command("calibrate the wall probe") == ("wall_calibrate", None)
    assert parse_command("is this mushroom edible") == ("ask", "is this mushroom edible")


def test_gain_clips_instead_of_wrapping():
    loud = struct.pack("<2h", 20000, -20000)
    assert struct.unpack("<2h", apply_gain(loud, 4.0)) == (32767, -32768)
