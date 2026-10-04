# Siteless

A map of well-reviewed restaurants, cafés, bars, salons, trades and shops that have
**no website or a bad one**. Tap a pin to see the place's Google Maps listing (embedded),
its rating, reviews, phone number, opening hours and what is wrong with its website.

Pins are coloured by website and labelled with the Google rating:

| Colour | Meaning |
| --- | --- |
| Red | No website on the Google listing |
| Berry | Broken website: dead domain, error page, parked domain, or an old Google `business.site` page (Google shut those down in 2024) |
| Orange | Only a Facebook, Instagram, link-in-bio or similar page |
| Brown | A free builder address (`wixsite.com`, `square.site` …) or a third-party page (DoorDash, Toast, Booksy, Yelp …) |
| Olive | Poor website: Google PageSpeed scored it under 50/100, or it has no HTTPS or no mobile layout |
| Grey | Has its own website that has not been checked yet |
| Green | Decent website (hidden by default) |

The **lead score** (0–100) ranks places by how weak the website is and how good the
reviews are (rating and number of reviews). Mark places as Saved, Contacted or Not a fit,
add notes, and download the list as a CSV.

## Use it

Open `siteless/index.html` from a web server, for example:

```bash
cd siteless && python3 -m http.server 8000     # then open http://localhost:8000
```

The website workflow also publishes it next to Building Atlas at `/siteless/`
(https://dominicsuse.github.io/Claude-apps/siteless/ or https://buildingatlas.eu.org/siteless/
once the custom domain is live).

1. Move the map to a neighbourhood or search for a town.
2. Pick what to look for (restaurants, cafés, bars … ).
3. Press **Scan this area**. Busy areas are split into smaller squares automatically.
4. Set the minimum rating and number of reviews, and which website types to show.

### Free mode (no key)

Without a key the app uses OpenStreetMap: it finds places that list no website, or only a
Facebook or Instagram page, and skips chains. OpenStreetMap has no reviews and can miss
websites, so every place links to its Google Maps listing to check.

### Google mode (recommended)

A Google Maps Platform API key adds Google ratings and review counts, the rating filters,
phone numbers, the embedded Google listing, photos, hours, recent reviews and website
quality checks.

1. In the [Google Cloud console](https://console.cloud.google.com/projectcreate) create a
   project and add a billing account (Google requires one even inside the free allowance).
2. Enable **Places API (New)**, **Maps Embed API** and **PageSpeed Insights API**.
3. Create an API key under **APIs & Services > Credentials**. Restrict it to those three
   APIs and to your site's address (for example `http://localhost:8000/*` or
   `https://dominicsuse.github.io/*`).
4. Paste it in the app's **Settings**. It is stored only in your browser.

Costs: each scan makes at most the number of searches set in Settings (30 by default,
20 places each). Searches that return ratings and websites, and detailed listings with
reviews, fall under Google's Enterprise pricing, which currently includes about 1,000 free
requests per month each; check [Google's pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
and set a quota cap in the Cloud console for a hard limit. The embedded map and website
checks are free. Settings shows how many requests you made this month.

## How a website is judged

1. **By its address**: social and link-in-bio pages, free builder sub-addresses, delivery,
   booking and directory pages are flagged straight away (see `HOSTS` in `index.html`).
2. **By Google PageSpeed Insights** (mobile Lighthouse) for everything else: the quality
   score mixes speed (30%), SEO (30%), accessibility (20%) and best practices (20%), minus
   penalties for no HTTPS (−20), no mobile layout (−25), old-style HTML (−8) and tiny text
   (−5). Under 50, or no HTTPS, or no mobile layout, counts as poor. Domains that do not
   resolve, return errors, or forward to a parking page count as broken, and sites that
   just forward to Facebook and the like count as social pages.

## Test

The test drives the app in Chromium with every network call mocked, so it needs no key:

```bash
npm i playwright leaflet@1.9.4
node siteless/tests/app.test.js            # --shots DIR saves screenshots
```
