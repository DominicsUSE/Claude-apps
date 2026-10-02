# Build Atlas

Interactive globe that scores cities, towns and countries for starting a
real-estate development company: green (65–100%), yellow (50–64%), red (0–49%).
Switch between three ratings:
- **Overall**: best all-round places to start and build.
- **Price**: cheapest land and homes (estimated USD per m²; green is cheaper).
- **Potential**: where demand and prices should grow most.
Drag to spin, scroll or pinch to zoom; city and town names appear as you zoom in.
Click a place or country for its score breakdown, its growth potential and
plain-language reasons why it scores well or badly. Map labels carry a
small arrow for growth potential (up = high, sideways = some, down = low).

Open `index.html` in a browser (it loads d3 from cdnjs; everything else is inline).

Scores are indicative estimates, not financial advice:
- Country baseline = weighted mix of demand growth (25%), economy (25%),
  affordability & yield (15%), stability (20%) and business & finance (15%).
- City score = baseline + market size (−4 to +5) + national capital (+2)
  + local momentum for known hot or overheated markets.
- Price: country typical $/m² × city size, capital and demand multipliers,
  or a known city price; scored on a log scale ($400 = 100%, $25,000 = 0%).
- Potential: demand (45%), economy (40%) and stability (15%), plus size,
  1.3× local momentum and price headroom.

To change scores, edit `build/scores.py`, then run `python3 build/build.py`
to regenerate `index.html`. Country-specific reasons live in `COUNTRY_NOTES`.
Map data: Natural Earth via world-atlas. Satellite imagery: NASA Blue Marble.
