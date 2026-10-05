# Siteless

A Windows app with a map of well-reviewed restaurants, cafés, bars, salons, trades, shops
and other local businesses that have **no website or a bad one**. Click a pin to see the
place's Google Maps listing (embedded), its rating, reviews, photo, phone number, opening
hours, what is wrong with its website, and a ready-made email, message or call script to
offer them one.

## Get the app

Every change to `siteless/` builds the app on GitHub's Windows machines
(`.github/workflows/build-siteless-windows.yml`):

- Open **Actions > Siteless Windows app**, pick the latest run and download
  **Siteless-Windows-Installer** (installs Siteless with Start menu and desktop shortcuts)
  or **Siteless-Windows-Portable** (one `.exe` that runs without installing).
- Builds on the default branch also publish both files as a GitHub release (`siteless-v<version>`, for example `siteless-v1.0.1`).

The app is not code-signed, so the first time Windows may show "Windows protected your PC":
click **More info**, then **Run anyway**. Siteless needs an internet connection for maps,
Google and OpenStreetMap. Your places, leads and settings are saved on your computer.

## Using it

1. Move the map to a neighbourhood, or search for a town, street or postcode.
2. Every type of place is selected under **Look for**. Untick what you don't want, or type
   a keyword instead (tattoo, mechanic, sushi …).
3. Click **Scan this area** (or press <kbd>S</kbd>).
4. Set the minimum rating and number of reviews and which website types to show. Chains and
   franchises are hidden.

Pins show the Google rating and are marked by website. Colours were checked so every pair
stays distinguishable with colour blindness, and each pin also carries a glyph:

| Pin | Meaning |
| --- | --- |
| Red `∅` | No website on the Google listing |
| Violet `!` | Broken website: dead domain, error page, parked domain, or an old Google `business.site` page (Google shut those down in 2024) |
| Pink `@` | Only a Facebook, Instagram, link-in-bio or similar page |
| Blue `↗` | A free builder address (`wixsite.com`, `square.site` …) or a third-party page (DoorDash, Toast, Booksy, Yelp …) |
| Amber `↓` | Poor website: Google PageSpeed scored it under 50/100, or it has no HTTPS or no mobile layout |
| Grey `?` | Has its own website that has not been checked yet |
| Green `✓` | Decent website (hidden by default) |

Overlapping pins group into rings that show the mix of website types. The bar under
**Website** shows what share of the places in view have no real website.

**Leads.** The lead score (0–100) ranks places by how weak the website is and how good the
reviews are. Mark places New, Saved, Contacted, Won or Not a fit (keys <kbd>1</kbd>–<kbd>5</kbd>),
add notes and a follow-up date; due follow-ups get their own filter. **Route** opens Google
Maps directions through your saved leads in view (or the top 10 places). **CSV** downloads the
list for a spreadsheet; Settings can download a backup of everything and restore it on
another computer.

**Reach out.** Each place has an email, a short text or DM, and a call script that mention
its rating and exactly what is wrong with its website. Fill in your name, business and offer
in Settings.

Other shortcuts: <kbd>/</kbd> search, <kbd>J</kbd>/<kbd>K</kbd> next and previous place,
<kbd>O</kbd> open in Google Maps, <kbd>Esc</kbd> back to the list.

### Making sure "no website" really means no website

Map listings often just don't mention a place's website. So the Windows app double-checks
every place without one, best leads first: it tries the web address made from the name
(`joespizza.com`, and the country's own ending) and searches the web (Bing, then Brave) for
the name and street, skipping directories like Yelp, TripAdvisor and Facebook. If it finds
the place's site, the place moves to the website types (a site that does not load counts
as broken). If not, the place gets **✓ No site online**. With **Only places double-checked
on the web to have no website** ticked (the default), places still being checked are not
shown yet. The spreadsheet export has a column with the result.

### Free mode (no key)

Without a key Siteless uses OpenStreetMap: it finds places that list no website, or only a
Facebook or Instagram page, and skips chains. OpenStreetMap has no reviews and can miss
websites, so every place links to its Google Maps listing to check. Larger areas are scanned
in up to 16 parts.

### Google mode (recommended)

A Google Maps Platform API key adds Google ratings and review counts, the rating filters,
phone numbers, the embedded Google listing, photos, hours, recent reviews and website checks.

1. In the [Google Cloud console](https://console.cloud.google.com/projectcreate) create a
   project and add a billing account (Google requires one even inside the free allowance).
2. Enable **Places API (New)**, **Maps Embed API** and **PageSpeed Insights API**.
3. Create an API key under **APIs & Services > Credentials**. For the app, set
   **Application restrictions** to **None** (the key stays on your computer) and under
   **API restrictions** pick the three APIs.
4. Paste it in the app's **Settings**.

**Scanning thoroughness** (Settings): **Maximum** (default) keeps splitting busy squares until
every place is found, up to 250 Google searches per scan; **Thorough** stops at 60 and
**Quick** at 15. Each search returns up to 20 places; keyword scans page through up to 60 per
square. Unsupported place types are dropped once and remembered.

**Costs.** Area searches with ratings and websites, keyword searches, detailed listings and
photos each fall under Google's Enterprise pricing, which currently includes about 1,000 free
requests per month each; check [Google's pricing](https://developers.google.com/maps/billing-and-pricing/pricing).
Siteless counts your requests and by default stops at 1,000 a month per kind, so you stay
inside the free allowance (change or turn this off in Settings). The embedded map and website
checks are free. You can also set a hard daily cap under Quotas in the Cloud console.

## How a website is judged

1. **By its address**: social and link-in-bio pages, free builder sub-addresses, delivery,
   booking and directory pages are flagged straight away (see `HOSTS` in `index.html`).
2. **By Google PageSpeed Insights** (mobile Lighthouse) for everything else: the quality
   score mixes speed (30%), SEO (30%), accessibility (20%) and best practices (20%), minus
   penalties for no HTTPS (−20), no mobile layout (−25), old-style HTML (−8), tiny text (−5)
   and very old jQuery (−4). Under 50, or no HTTPS, or no mobile layout, counts as poor.
   Domains that do not resolve, return errors, or forward to a parking page count as broken,
   and sites that just forward to Facebook and the like count as social pages. The check also
   shows a phone screenshot of the site and what it is built with (WordPress, Wix …).

## Files

- `index.html`: the whole app (one page; the desktop app wraps it).
- `desktop/verify.js`: the web double-check for places without a website (tested offline by
  `desktop/verify.test.js`).
- `desktop/`: the Windows app (Electron). `build.js` bundles Leaflet into the page and builds
  the installer and portable exe with electron-builder; `main.js` serves the page from
  `siteless://`, opens links in your default browser, mail app or phone app, keeps one
  window, and sends the OpenStreetMap requests itself under the app's name (the main
  OpenStreetMap server turns away requests that look like they come from a web page).
  In the app the map comes from Esri (CARTO, used by the web page, needs a key there).
- `icons/`, `tools/make-icons.js`: app icons, rendered from the logo with headless Chromium.
- `manifest.webmanifest`, `sw.js`: only used if the page is later published as a website
  (installable web app). The website workflow does not publish Siteless.

## Develop and test

```bash
# run the desktop app from source (Windows, macOS or Linux)
cd siteless/desktop && npm install && npm start

# build the Windows installer and portable exe (on Windows)
cd siteless/desktop && npm install && node build.js

# end-to-end test of the page, every network call mocked (no key needed)
npm i playwright leaflet@1.9.4 leaflet.markercluster@1.5.3
node siteless/tests/app.test.js            # --shots DIR saves screenshots

# smoke test of the desktop app (on Linux without a screen: xvfb-run node test.js)
cd siteless/desktop && npm install && npm i --no-save playwright && node test.js

# the app on the real internet: map tiles, search, "my location", real scans in nine
# cities, a keyword scan, Google listings, satellite view and Google's key check
cd siteless/desktop && node live-test.js
```

`.github/workflows/test-siteless-windows.yml` runs all of this on Windows Server 2022,
Windows Server 2025 and Windows 11 on ARM on every change and once a day: it installs the
app silently, checks the shortcuts and uninstall entry, drives the installed app with mocked
and real data, runs the portable exe, tests the page in Edge and Chrome, and uninstalls.
