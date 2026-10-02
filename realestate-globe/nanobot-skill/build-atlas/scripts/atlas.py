#!/usr/bin/env python3
"""Query Build Atlas real-estate scores.

  atlas.py top [--sort value|price|potential|overall] [--region R] [--country C ...]
               [--min-pop N] [--max-price USD] [--min-potential N] [--worst]
               [--include-unstable] [--limit N]
  atlas.py place NAME [--country C]
  atlas.py country NAME
  atlas.py property [--safest] [--region R] [--limit N]

property_safety (country level): how likely the government is to seize, nationalise or
block your property, and limits on foreign owners (70+ safe, 45-69 some risk, <45 high).

Scores are 0-100 (green 65+, yellow 50-64, red under 50). price: higher = cheaper.
value = cheap AND high growth potential, marked down in unstable countries.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "assets", "atlas-data.json"), encoding="utf-8") as fh:
    DATA = json.load(fh)
C = DATA["countries"]
COLS = DATA["place_columns"]
PLACES = [dict(zip(COLS, r)) for r in DATA["places"]]
STABLE = 35
SAFE_MIN = 35  # property safety floor for rankings unless --include-unstable

REGIONS = {
    "europe": "ALB AND AUT BEL BIH BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN ISL IRL ITA KOS LVA LIE LTU LUX MLT MDA MCO MNE NLD MKD NOR POL PRT ROU SMR SRB SVK SVN ESP SWE CHE UKR GBR BLR",
    "asia": "AFG ARM AZE BGD BTN BRN KHM CHN GEO HKG IND IDN JPN KAZ KGZ LAO MAC MYS MDV MNG MMR NPL PRK PAK PHL SGP KOR LKA TWN TJK THA TLS TKM UZB VNM",
    "middle east": "ARE BHR EGY IRN IRQ ISR JOR KWT LBN OMN PSX QAT SAU SYR TUR YEM",
    "africa": "DZA AGO BEN BWA BFA BDI CMR CPV CAF TCD COM COD COG CIV DJI EGY GNQ ERI SWZ ETH GAB GMB GHA GIN GNB KEN LSO LBR LBY MDG MWI MLI MRT MUS MAR MOZ NAM NER NGA RWA STP SEN SYC SLE SOM ZAF SSD SDN TZA TGO TUN UGA ZMB ZWE SOL SAH",
    "north america": "USA CAN MEX",
    "latin america": "MEX GTM BLZ SLV HND NIC CRI PAN CUB JAM HTI DOM PRI BHS TTO BRB COL VEN ECU PER BOL BRA PRY URY ARG CHL GUY SUR",
    "oceania": "AUS NZL PNG FJI SLB VUT NCL PYF WSM TON",
}
ALIASES = {"usa": "USA", "us": "USA", "united states": "USA", "america": "USA", "uk": "GBR",
           "united kingdom": "GBR", "britain": "GBR", "england": "GBR", "uae": "ARE",
           "emirates": "ARE", "russia": "RUS", "korea": "KOR", "south korea": "KOR",
           "czech republic": "CZE", "holland": "NLD", "turkey": "TUR", "vietnam": "VNM"}


def find_country(name):
    n = (name or "").strip().lower()
    if not n:
        return None
    if n in ALIASES:
        return ALIASES[n]
    if n.upper() in C:
        return n.upper()
    for k, c in C.items():
        if c["name"].lower() == n:
            return k
    for k, c in C.items():
        if c["name"].lower().startswith(n):
            return k
    return None


def usd(v):
    # same rounding as the map (half up)
    if v >= 1000:
        k = int(v / 100 + 0.5) / 10
        return f"${k:g}k" if v < 10000 else f"${int(v / 1000 + 0.5)}k"
    return f"${int(v / 10 + 0.5) * 10}"


def line(p, i=None):
    cc = C[p["country_code"]]
    head = f"{i}. " if i else ""
    ps = cc["factors"]["property_safety"]
    warn = " WARNING: government may seize property or block real ownership" if ps < 45 else ""
    return (f"{head}{p['name']}, {cc['name']}: value {p['value']}%, about {usd(p['price_usd_m2'])}/m2, "
            f"growth {p['potential']}%, overall {p['overall']}%, property safety {ps}%, pop {p['population']:,}{warn}")


def top(a):
    sort = {"cheap": "price", "growth": "potential"}.get(a.sort, a.sort)
    cks = {find_country(x) for x in a.country or []} - {None}
    region = set(REGIONS.get((a.region or "").lower(), "").split())
    out = []
    for p in PLACES:
        ck = p["country_code"]
        if cks and ck not in cks:
            continue
        if region and ck not in region:
            continue
        if p["population"] < a.min_pop or p["price_usd_m2"] > a.max_price or p["potential"] < a.min_potential:
            continue
        fac = C[ck]["factors"]
        if not a.include_unstable and not a.worst and (fac["stability"] < STABLE or fac["property_safety"] < SAFE_MIN):
            continue
        if fac["property_safety"] < a.min_property:
            continue
        out.append(p)
    out.sort(key=lambda p: (p[sort], -p["population"]) if a.worst else (-p[sort], -p["population"]))
    if not out:
        print("No places match. Try a bigger area, a higher price limit or a lower population.")
        return
    print(f"Top {min(a.limit, len(out))} by {sort}{' (worst first)' if a.worst else ''}"
          f"{'' if a.include_unstable or a.worst else ' (war zones and countries where the government may take property left out)'}:")
    for i, p in enumerate(out[:a.limit], 1):
        print(line(p, i))


def place(a):
    ck = find_country(a.country) if a.country else None
    n = a.name.strip().lower()
    hits = [p for p in PLACES if p["name"].lower() == n and (not ck or p["country_code"] == ck)]
    if not hits:
        hits = [p for p in PLACES if p["name"].lower().startswith(n) and (not ck or p["country_code"] == ck)]
    if not hits:
        print(f"No place called {a.name} in the dataset.")
        return
    p = max(hits, key=lambda p: p["population"])
    c = C[p["country_code"]]
    same = sorted((q for q in PLACES if q["country_code"] == p["country_code"]), key=lambda q: -q["value"])
    print(line(p))
    print(f"Region: {p['region'] or '-'}; rank by value in {c['name']}: {same.index(p) + 1} of {len(same)}")
    if p["local_momentum"]:
        print(f"Local momentum: {'+' if p['local_momentum'] > 0 else ''}{p['local_momentum']} "
              f"({'people and jobs moving in' if p['local_momentum'] > 0 else 'overheated or losing residents'})")
    country_block(c)


def country_block(c):
    f = c["factors"]
    print(f"{c['name']} baseline: overall {c['overall']}%, value {c['value']}%, growth {c['potential']}%, "
          f"price score {c['price']}% (typical {usd(c['price_usd_m2'])}/m2)")
    print("Factors 0-100: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in f.items()))
    ps = f["property_safety"]
    verdict = "property is safe" if ps >= 70 else "some risk or limits on foreigners" if ps >= 45 else "HIGH risk: the government may seize property, or you cannot really own it"
    print(f"Can the government take your property? {ps}/100, {verdict}" + (f": {c['property_note']}" if c["property_note"] else ""))
    for kind, text in c["notes"]:
        print(("Problem: " if kind == "-" else "Strength: ") + text)


def country(a):
    ck = find_country(a.name)
    if not ck:
        print(f"No country called {a.name}.")
        return
    c = C[ck]
    country_block(c)
    best = sorted((p for p in PLACES if p["country_code"] == ck), key=lambda p: -p["value"])[:5]
    if best:
        print("Best value places:")
        for i, p in enumerate(best, 1):
            print(line(p, i))


def prop(a):
    region = set(REGIONS.get((a.region or "").lower(), "").split())
    rows = [c for k, c in C.items() if (not region or k in region)]
    rows.sort(key=lambda c: -c["factors"]["property_safety"] if a.safest else c["factors"]["property_safety"])
    print(("Safest" if a.safest else "Riskiest") + " countries for property (0-100, higher = safer):")
    for i, c in enumerate(rows[:a.limit], 1):
        ps = c["factors"]["property_safety"]
        note = c["property_note"] or ("strong property rights" if ps >= 85 else "conflict and weak courts" if ps < 25 else "")
        print(f"{i}. {c['name']}: {c['factors']['property_safety']}%" + (f" - {note}" if note else ""))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("top")
    t.add_argument("--sort", default="value", choices=["value", "price", "cheap", "potential", "growth", "overall"])
    t.add_argument("--region", choices=sorted(REGIONS))
    t.add_argument("--country", action="append")
    t.add_argument("--min-pop", type=int, default=100000)
    t.add_argument("--max-price", type=float, default=float("inf"))
    t.add_argument("--min-potential", type=int, default=0)
    t.add_argument("--min-property", type=int, default=0, help="minimum property safety 0-100")
    t.add_argument("--worst", action="store_true")
    t.add_argument("--include-unstable", action="store_true")
    t.add_argument("--limit", type=int, default=8)
    p = sub.add_parser("place")
    p.add_argument("name")
    p.add_argument("--country")
    c = sub.add_parser("country")
    c.add_argument("name")
    pr = sub.add_parser("property")
    pr.add_argument("--safest", action="store_true")
    pr.add_argument("--region", choices=sorted(REGIONS))
    pr.add_argument("--limit", type=int, default=10)
    a = ap.parse_args(argv)
    a.limit = max(1, min(25, getattr(a, "limit", 8)))
    {"top": top, "place": place, "country": country, "property": prop}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
