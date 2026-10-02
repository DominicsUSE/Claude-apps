# Build Atlas

Interactive globe that scores cities, towns and countries for starting a
real-estate development company: green (65–100%), yellow (50–64%), red (0–49%).
Switch between three ratings:
- **Overall**: best all-round places to start and build.
- **Price**: cheapest land and homes (estimated USD per m²; green is cheaper).
- **Potential**: where demand and prices should grow most.
- **Value**: cheap AND high growth potential together (marked down in unstable
  countries). This is the "best cheap places with the most potential" view.
Drag to spin, scroll or pinch to zoom; city and town names appear as you zoom in.
Click a place or country for its score breakdown, its growth potential and
plain-language reasons why it scores well or badly. Map labels carry a
small arrow for growth potential (up = high, sideways = some, down = low).

Open `index.html` in a browser (it loads d3 from cdnjs; everything else is inline).

Scores are indicative estimates, not financial advice:
- Country baseline = weighted mix of demand growth (22%), economy (22%),
  affordability & yield (13%), stability (15%), business & finance (13%) and
  property safety (15%).
- Property safety = how likely the government is to seize, nationalise or block
  your property (e.g. Venezuela's expropriations, Russia's "temporary management"
  of foreign assets) and how freely foreigners may own it (e.g. no land ownership
  for foreigners in Thailand or the Philippines). Countries under 45% are hatched
  red on the map, and rankings of cheap places leave out anything under 35%.
  Edit `PROPERTY` in `build/scores.py`.
- City score = baseline + market size (−4 to +5) + national capital (+2)
  + local momentum for known hot or overheated markets.
- Price: country typical $/m² × city size, capital and demand multipliers,
  or a known city price; scored on a log scale ($400 = 100%, $25,000 = 0%).
- Potential: demand (45%), economy (40%) and stability (15%), plus size,
  1.3× local momentum and price headroom.

To change scores, edit `build/scores.py`, then run `python3 build/build.py`
to regenerate `index.html`. Country-specific reasons live in `COUNTRY_NOTES`.
Map data: Natural Earth via world-atlas. Satellite imagery: NASA Blue Marble.

## Ask AI chat

The side panel has an **Ask AI** tab. Ask things like "cheap places with the most
growth", "best value in Europe" or "why is Russia rated badly?". Answers link
each place, and the globe flies to them with numbered pins. It runs in one of
three ways:

1. **Opened in Claude (claude.ai artifact):** Claude answers, looking places up in
   the map data with page tools.
2. **Run locally with your own nanobot:** see below.
3. **Anywhere else:** instant answers built from the map data, no AI needed.

## Using nanobot

[nanobot](https://github.com/HKUDS/nanobot) is a self-hosted AI agent. Two parts
connect it to Build Atlas:

- `nanobot-skill/build-atlas/`: a nanobot skill. nanobot can then answer
  Build Atlas questions everywhere it runs (WebUI, terminal, Telegram, Discord ...)
  by running `scripts/atlas.py` on the scored data in `assets/atlas-data.json`.
- `serve.py`: serves the map and forwards its Ask AI tab to nanobot's
  OpenAI-compatible API. nanobot's API sends no CORS headers, so the browser has
  to reach it through the same server.

```bash
# 1. install the skill into your nanobot workspace
cp -r realestate-globe/nanobot-skill/build-atlas ~/.nanobot/workspace/skills/

# 2. start nanobot's API (default http://127.0.0.1:8900)
nanobot plugins enable api
nanobot serve

# 3. serve the map, then open http://127.0.0.1:8000 and use the Ask AI tab
python3 realestate-globe/serve.py            # --nanobot URL --key API_KEY if needed
```

You can try the skill on its own:

```bash
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py top --sort value --region europe
python3 ~/.nanobot/workspace/skills/build-atlas/scripts/atlas.py place Lisbon
```

`build/build.py` regenerates `assets/atlas-data.json` together with `index.html`
(the scoring is mirrored in `build/export_skill.py`).

## Chat understanding tests

The offline chat parses each question into an intent (list, place, country, compare,
property, explain ...) plus filters (region, country, price cap, size, how many). It
tolerates typos ("potencial", "goverment", "Polland") and synonyms. A generated test
suite checks it on about 2,000 questions per seed:

```bash
npm i playwright d3@7.9.0
node realestate-globe/tests/chat-understanding.test.js 1   # try other seeds: 2, 3, ...
```

## On a Mac

San Francisco is used for text, ⌘K (or /) jumps to search, + − 0 and the arrow
keys move the globe, and trackpad pinch works in Safari and Chrome.

## Mac app

`mac/` wraps the map in a native macOS window (Electron): offline map and imagery,
Mac title bar and menus, live news, and Ask AI through your local nanobot.

```bash
cd realestate-globe/mac
npm install
node build-mac.js        # -> dist/Build-Atlas-<version>-mac-Apple-Silicon.zip and ...-Intel.zip
```

The app is ad-hoc signed, not notarised, so the first time macOS asks: right-click
the app, choose **Open**, then **Open** (or System Settings > Privacy & Security >
Open Anyway). Optional settings live in
`~/Library/Application Support/Build Atlas/config.json`:
`{"nanobotUrl": "http://127.0.0.1:8900", "nanobotApiKey": "..."}`.

## Live news

The Mac app and `serve.py` fetch property and economy headlines from Google News
every 10 minutes. Each headline is matched to the countries and big cities it names
and scored positive or negative ("seizes", "sanctions", "crash" vs "boom",
"investment", "reforms"); newer headlines count more. A country's scores move by at
most ±6 points, and headlines about seizures or nationalisation lower property
safety by up to 15. The headlines are listed under **In the news** for each place.
(The claude.ai version cannot fetch feeds, so it shows the base model only.)

## Why a score is what it is

Every place and country has a **Why X%?** section: what the percentage means
(very poor, poor, mixed, strong, excellent), and each factor with how many points
it adds or removes from the 50% midpoint and a plain-language reason.
