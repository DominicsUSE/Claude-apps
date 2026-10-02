"""Bundle map data + scores into a single self-contained HTML page.

Inputs (in this folder):
  countries-50m.json / countries-110m.json  - world-atlas 2.0.2 TopoJSON (Natural Earth)
  places.geojson                            - Natural Earth 10m populated places (simple)
  app.html                                  - page template with a /*__DATA__*/ marker

Outputs:
  ../index.html  - standalone page (open directly in a browser)
  argv[1]        - optional: body-only copy for publishing as a claude.ai Artifact
"""
import json
import os
import sys

from scores import DEFAULT, WEIGHTS, parse_countries, parse_hotspots

HERE = os.path.dirname(os.path.abspath(__file__))
SKIP_CLASSES = {"Scientific station", "Meteorological Station", "Historic place"}


def load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return json.load(fh)


def main():
    table = parse_countries()
    hotspots = parse_hotspots()
    num_to_iso = {v["num"]: k for k, v in table.items() if v["num"] != "000"}

    topo50 = load("countries-50m.json")
    topo110 = load("countries-110m.json")

    countries = {}  # key -> {n: name, f: [D,E,A,S,F]}

    def ensure(key, name):
        if key not in countries:
            f = table[key]["f"] if key in table else DEFAULT
            countries[key] = {"n": name, "f": list(f)}
        return key

    # Tag every map feature with our country key.
    for topo in (topo50, topo110):
        for g in topo["objects"]["countries"]["geometries"]:
            num = g.get("id")
            name = g["properties"]["name"]
            key = num_to_iso.get(num) or ("N" + (num or name))
            g["k"] = ensure(key, name)
            g.pop("properties", None)
            g.pop("id", None)

    feats = load("places.geojson")["features"]
    best = {}  # (iso, lowername) -> index of most populous match, for hotspot lookup
    places = []
    for f in feats:
        p = f["properties"]
        if p["featurecla"] in SKIP_CLASSES or p["adm0_a3"] == "ATA":
            continue
        iso = p["adm0_a3"]
        if iso not in countries:
            ensure(iso, p["adm0name"])
        lon, lat = f["geometry"]["coordinates"]
        cap = 1 if p["featurecla"].startswith("Admin-0 capital") else 0
        row = [
            p["nameascii"] or p["name"],
            round(lon, 3),
            round(lat, 3),
            int(p["pop_max"] or 0),
            round(float(p["min_zoom"] or 7), 1),
            iso,
            p["adm1name"] or "",
            cap,
            0,
        ]
        idx = len(places)
        places.append(row)
        k = (iso, row[0].lower())
        if k in hotspots and (k not in best or places[best[k]][3] < row[3]):
            best[k] = idx

    for k, idx in best.items():
        places[idx][8] = hotspots[k]
    missing = sorted(set(hotspots) - set(best))
    if missing:
        print("hotspots without a matching place:", missing, file=sys.stderr)

    places.sort(key=lambda r: (r[4], -r[3]))
    data = (
        "const WEIGHTS=" + json.dumps(WEIGHTS, separators=(",", ":")) + ";\n"
        "const COUNTRIES=" + json.dumps(countries, separators=(",", ":"), ensure_ascii=False) + ";\n"
        "const PLACES=" + json.dumps(places, separators=(",", ":"), ensure_ascii=False) + ";\n"
        "const TOPO50=" + json.dumps(topo50, separators=(",", ":"), ensure_ascii=False) + ";\n"
        "const TOPO110=" + json.dumps(topo110, separators=(",", ":"), ensure_ascii=False) + ";\n"
    )

    with open(os.path.join(HERE, "app.html"), encoding="utf-8") as fh:
        body = fh.read().replace("/*__DATA__*/", data)

    head = (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        "</head>\n<body>\n"
    )
    with open(os.path.join(HERE, "..", "index.html"), "w", encoding="utf-8") as fh:
        fh.write(head + body + "\n</body>\n</html>\n")
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w", encoding="utf-8") as fh:
            fh.write(body)
    print(f"{len(places)} places, {len(countries)} countries")


if __name__ == "__main__":
    main()
