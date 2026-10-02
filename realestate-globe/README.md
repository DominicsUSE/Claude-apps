# Build Atlas

Interactive globe that scores cities, towns and countries for starting a
real-estate development company: green (65–100%), yellow (50–64%), red (0–49%).
Drag to spin, scroll or pinch to zoom; city and town names appear as you zoom in.
Click a place or country for its score breakdown.

Open `index.html` in a browser (it loads d3 from cdnjs; everything else is inline).

Scores are indicative estimates, not financial advice:
- Country baseline = weighted mix of demand growth (25%), economy (25%),
  affordability & yield (15%), stability (20%) and business & finance (15%).
- City score = baseline + market size (−4 to +5) + national capital (+2)
  + local momentum for known hot or overheated markets.

To change scores, edit `build/scores.py`, then run `python3 build/build.py`
to regenerate `index.html`. Map data: Natural Earth via world-atlas.
