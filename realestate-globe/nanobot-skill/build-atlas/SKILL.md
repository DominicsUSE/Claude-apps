---
name: build-atlas
description: Find the best places to start or build a real-estate company - cheap places with the most growth potential, prices per m², country and city risks - from the Build Atlas scores for ~7,300 cities and every country.
metadata: {"nanobot":{"emoji":"🏗️","requires":{"bins":["python3"]}}}
---

# Build Atlas

Use this skill when someone asks where to build, buy land, invest in property or
start a real-estate company; which places are cheap, have growth potential or are
good value; or why a city or country scores well or badly.

Run the script that sits next to this file (installed at `~/.nanobot/workspace/skills/build-atlas/`; adjust the path if your workspace is elsewhere):

```bash
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py top --sort value --limit 8              # cheap + most growth (best value)
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py top --sort value --region europe        # also: asia, africa, middle east,
                                                                   # north america, latin america, oceania
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py top --sort price --min-pop 1000000      # cheapest big cities
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py top --sort potential --country Mexico   # most growth in one country
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py top --sort value --max-price 1500       # under $1,500 per m²
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py top --sort overall --worst              # riskiest places
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py place "Lisbon" --country Portugal       # one city, with reasons
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py country "Russia"                        # one country, with reasons
```

What the numbers mean (all 0-100; green 65+, yellow 50-64, red under 50):

- `value`: cheap to buy and build AND strong growth, marked down in unstable countries.
  Use it for "cheap with the most potential", "bargains" and "best places".
- `price`: higher means cheaper, from an estimated typical apartment price in USD per m².
- `potential` (growth): population growth, economy and local momentum.
- `overall`: best all-round place to start and build.

`top` leaves out war zones and very unstable countries unless you pass
`--include-unstable`. Use `--min-pop 20000` to include small towns.

How to answer:

- Always run the script; never invent places, prices or scores.
- Keep it short: one sentence, then up to 6 bullets of
  "City, Country: value 72%, about $1.6k/m², growth 66%. One short reason."
- Name the main risk when there is one (from the `Problem:` lines).
- Say once that these are indicative model estimates, not financial advice.
