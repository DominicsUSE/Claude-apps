# Money, Charted: video pipeline

Turns official money data into finished YouTube Shorts. You pick topics in a spreadsheet. The pipeline pulls the data, has Claude write the narration from those numbers only, adds your voice (or an AI narrator), and renders a 1080×1920 video with an animated chart, captions, a cover frame, a long-form thumbnail and a ready-to-paste description.

Nothing is uploaded automatically. You watch each video once and schedule it in YouTube Studio. That check is what keeps the channel accurate and monetizable.

## One-time setup

1. Install **Node.js 22 LTS** from https://nodejs.org (Windows or Mac installer, default options).
2. Get this folder onto your computer: on GitHub use **Code → Download ZIP** and unzip it, or `git clone` the repository.
3. Open a terminal in the `money-charted` folder and run:
   ```
   npm install
   ```
4. Copy `.env.example` to a new file named `.env` and paste your Anthropic API key after `ANTHROPIC_API_KEY=` (get one at https://console.anthropic.com). Add an ElevenLabs key only if you want an AI voice.
5. Check everything works:
   ```
   npm test
   ```

Data comes from FRED (St. Louis Fed) and the World Bank. Neither needs an account or key.

## Daily use

Everything is driven by `queue.csv`. Open it in Google Sheets (File → Import), VS Code, or Excel (save as **CSV UTF-8**). Close it before running the pipeline.

1. Set a row's `status` to **Approved**.
2. Run `npm run make`. It fetches the data and writes the script, caption, titles, description and hashtags into the row. Status becomes **Scripted**.
3. Read the script. Check the numbers against the source named in the description. Edit anything you like.
4. Optional: record the script yourself and save it as `voice/<id>.wav` (or `.mp3` / `.m4a`), e.g. `voice/3.m4a`.
5. Set the status to **Checked** and run `npm run make` again. It renders into the `out/` folder:
   - `<id>.mp4`: the Short
   - `<id>-cover.png`: the first frame (pick it as the Shorts thumbnail)
   - `<id>-thumb.png`: a 1280×720 thumbnail for long-form use
   - `<id>-upload.txt`: title, description, pinned comment and schedule to paste into YouTube Studio
6. Watch the video once. Upload and schedule it in YouTube Studio, then set the status to **Published** and paste the link into `video_url`.

`npm run make` handles up to 7 rows per step. Use `npm run make -- --batch 14` for more, or `npm run make -- --id 5` for one row. If a row fails, the reason is written in its `notes` column and its status stays the same.

| Status | Meaning |
|---|---|
| Idea | Parked. The pipeline ignores it. |
| Approved | Ready for data and a script. |
| Scripted | Script written. Waiting for you to check it. |
| Checked | You approved the script. Ready for voice and video. |
| Rendered | Video is in `out/`. Waiting for you to watch and upload. |
| Published | Live on YouTube. |

## The voice

Your own voice is the best option. It sounds human because it is, it builds trust, and it is the strongest protection against YouTube's inauthentic-content rule.

- Record in a small, soft room (a closet full of clothes works), phone 15–20 cm from your mouth, slightly off to the side.
- Read slower than feels natural and smile a little. Leave half a second of silence at the start.
- The pipeline evens the loudness to −14 LUFS, the level YouTube plays at, so every video sounds the same volume.
- Captions are timed by spreading the words across your recording, so read the script as written.

No recording? With an ElevenLabs key the pipeline uses a warm, deep narrator ("Brian") with natural-sounding settings and word-accurate captions. Pick another voice by putting its ID in `ELEVENLABS_VOICE_ID`. ElevenLabs needs a paid plan for commercial use. Never use a cloned voice of anyone but yourself.

With neither, you get a silent preview with captions, which is useful for checking the look.

## Adding topics

Add a row to `queue.csv` with a `recipe` and its `params` (separated by `;`). FRED series IDs are on https://fred.stlouisfed.org (the code after `series/` in the page URL).

| Recipe | Draws | Params (defaults) |
|---|---|---|
| `value-of-dollars` | What an old amount is worth today | `amount=100; from=1970` |
| `real-price` | A price then and now, inflation-adjusted | `series=APU000074714; from=1980; label=Regular gas; unit=per gallon` |
| `prices` | Average prices of 1–3 items | `series=APU0000708111,APU0000717311; labels=Eggs (dozen),Coffee (lb); from=2000` |
| `indexed` | Two price indexes from the same start | `series=CUUR0000SEEB01,CPIAUCNS; labels=College tuition,All prices; from=1980` |
| `ratio` | One series divided by another | `a=MSPUS; b=MEHOINUSA646N; from=1984; label=Years of income to buy a home` |
| `world-inflation` | Countries ranked by price growth | `from=2000; top=10; highlight=USA` |
| `start-age` | Same investment, different start ages | `monthly=300; ages=25,35; end=65; rate=7` |
| `years-to-goal` | Years to a goal at several salaries | `goal=1000000; save=15; rate=7; salaries=40000,60000,80000` |
| `daily-habit` | A small daily amount over years | `daily=5; years=30; rate=7` |
| `debt-payoff` | Minimum payments vs a fixed payment | `balance=5000; apr=22; fixed=200; minpct=1; floor=25` |

`series` must be one of: Then vs Now, Math of Money, Paycheck vs, World Rankings, Myth vs Data. Each has its own color in the video.

Need a chart these recipes can't draw (a map, a mortgage comparison)? Ask Claude Code to add a recipe in `pipeline/recipes.ts`.

## Look and feel

The house style follows newsroom data graphics: one typeface (Libre Franklin) in a few weights, one accent green, black and two greys for everything else, hairline gridlines, labels written at the end of each line instead of a legend, and a short leader-line callout for the one thing worth noticing. No glow, grain or gradients. When one bar matters (the US in a world ranking), it is green and the rest are grey.

- Change colors, type sizes and layout in `video/Short.tsx` (the palette is the `C` object at the top). Preview with `npm run studio` (opens a browser editor).
- Optional background music: put a licensed track at `public/music/bed.mp3`. It plays quietly under the voice. Don't use tracks from YouTube's Shorts music picker; those send half your Shorts revenue to the music owner.
- The font is in `public/fonts` under the SIL Open Font License, so renders work offline.

## How the number check works

Claude only gets the numbers the pipeline calculated (`data/<id>.json`). Every number in the script, caption, titles and description must match one of them, allowing normal rounding ("$787,444" can be said as "$787K"). If Claude invents a number it gets one retry; if it still fails, the row stops with the bad numbers listed in `notes`. The same check runs again before rendering, so an edit of yours can't slip a wrong number in either. Numbers written as words ("ten years") are not checked.

## Troubleshooting

- **"Could not save queue.csv"**: close the file in Excel or Sheets and run again.
- **"Could not reach fred.stlouisfed.org"**: check your internet connection, then run again.
- **"Numbers not in the data"**: edit the text in `queue.csv` so it uses the numbers from `data/<id>.json`, then run again.
- **First render is slow**: Remotion downloads a headless browser once (about 100 MB).
- **Remotion can't download its browser**: set `REMOTION_BROWSER` in `.env` to a Chrome headless shell.

## Costs

About $0.03–0.06 per script with Claude (well under $5 a month at two videos a day). ElevenLabs is optional. Rendering is free and local (Remotion is free for individuals and companies of up to three people).
