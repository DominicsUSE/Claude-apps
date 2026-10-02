"""Score every place the same way the page does and write the nanobot skill's data file.

Mirrors the scoring in app.html (overall, price, potential, value). If you change a
formula there, change it here too.
"""
import json
import math
import os

from scores import WEIGHTS

HERE = os.path.dirname(os.path.abspath(__file__))
LMAX, LMIN = math.log(25000), math.log(400)


def jsround(v):
    return math.floor(v + 0.5)


def clamp(v):
    return max(3, min(97, jsround(v)))


def price_score(p):
    return clamp(100 * (LMAX - math.log(p)) / (LMAX - LMIN))


def value_of(price, potential, stability):
    return clamp(0.45 * price + 0.45 * potential + 0.10 * stability - (15 if stability < 30 else 0))


def size_mod(pop):
    for limit, mod in ((1e7, 5), (5e6, 4), (1e6, 3), (3e5, 1), (1e5, 0), (3e4, -2)):
        if pop >= limit:
            return mod
    return -4


def size_price(pop):
    for limit, mult in ((1e7, 1.6), (5e6, 1.45), (1e6, 1.25), (3e5, 1.05), (1e5, 0.9), (3e4, 0.75)):
        if pop >= limit:
            return mult
    return 0.6


def export(countries, places, out_path):
    cs = {}
    for k, c in countries.items():
        d, e, a, s, f = c["f"]
        overall = d * WEIGHTS["D"] + e * WEIGHTS["E"] + a * WEIGHTS["A"] + s * WEIGHTS["S"] + f * WEIGHTS["F"]
        potential = d * 0.45 + e * 0.40 + s * 0.15
        price = price_score(c["p"])
        cs[k] = {
            "name": c["n"], "price_usd_m2": c["p"],
            "overall": jsround(overall), "price": price, "potential": jsround(potential),
            "value": value_of(price, potential, s),
            "factors": {"demand": d, "economy": e, "affordability": a, "stability": s, "business_finance": f},
            "notes": c.get("notes", []),
            "_raw": (overall, potential, a, s),
        }
    rows = []
    for name, lon, lat, pop, _mz, ck, adm1, cap, hot, cp in places:
        c = cs[ck]
        overall_c, potential_c, a, s = c["_raw"]
        sm = size_mod(pop)
        ppm = cp or jsround(countries[ck]["p"] * size_price(pop) * (1.15 if cap else 1) * (1 + abs(hot) * 0.03) / 50) * 50
        price = price_score(ppm)
        potential = clamp(potential_c + sm * 0.6 + (1 if cap else 0) + hot * 1.3 + (a - 50) * 0.1)
        rows.append([name, ck, adm1, pop, ppm,
                     clamp(overall_c + sm + (2 if cap else 0) + hot), price, potential,
                     value_of(price, potential, s), hot, lat, lon])
    for c in cs.values():
        del c["_raw"]
    data = {
        "about": "Build Atlas scores (0-100, green 65+, yellow 50-64, red <50). Indicative estimates, not financial advice.",
        "place_columns": ["name", "country_code", "region", "population", "price_usd_m2",
                          "overall", "price", "potential", "value", "local_momentum", "lat", "lon"],
        "countries": cs, "places": rows,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"), ensure_ascii=False)
