"""Assemble the public website (GitHub Pages) into _site/.

    python3 realestate-globe/site/build_site.py [--domain buildingatlas.com] [--out _site]

Adds search/social metadata and icons to the map page, writes CNAME for the custom
domain and fetches fresh headlines into news.json (the page polls it every minute;
the website workflow rebuilds it every 10 minutes).
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import serve  # noqa: E402  (reuses the news fetcher)

DESCRIPTION = ("Interactive globe of the best places to start a real-estate company: about 7,300 cities "
               "rated by opportunity, price per m2, growth potential, value and whether the government "
               "can take your property, with live news.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="buildingatlas.com")
    ap.add_argument("--out", default="_site")
    ap.add_argument("--no-news", action="store_true")
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    url = "https://" + a.domain + "/"

    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as fh:
        page = fh.read()
    head = f"""<meta name="description" content="{DESCRIPTION}">
<link rel="canonical" href="{url}">
<link rel="icon" type="image/png" href="favicon.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" content="#04070e">
<meta property="og:type" content="website">
<meta property="og:url" content="{url}">
<meta property="og:title" content="Building Atlas">
<meta property="og:description" content="{DESCRIPTION}">
<meta property="og:image" content="{url}og-image.jpg">
<meta name="twitter:card" content="summary_large_image">
"""
    if "</head>" not in page:
        raise SystemExit("index.html has no </head>")
    page = page.replace("</head>", head + "</head>", 1)
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(page)

    for f in ("favicon.png", "apple-touch-icon.png", "og-image.jpg"):
        shutil.copy(os.path.join(HERE, f), os.path.join(out, f))
    with open(os.path.join(out, "CNAME"), "w") as fh:
        fh.write(a.domain + "\n")
    with open(os.path.join(out, "robots.txt"), "w") as fh:
        fh.write(f"User-agent: *\nAllow: /\nSitemap: {url}sitemap.xml\n")
    with open(os.path.join(out, "sitemap.xml"), "w") as fh:
        fh.write(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                 f"<url><loc>{url}</loc><changefreq>hourly</changefreq></url></urlset>\n")
    open(os.path.join(out, ".nojekyll"), "w").close()

    if not a.no_news:
        serve.refresh_news()
    with open(os.path.join(out, "news.json"), "w", encoding="utf-8") as fh:
        json.dump(serve.NEWS, fh)
    print(f"site in {out}: {len(serve.NEWS.get('items', []))} headlines" + (" (news fetch failed)" if serve.NEWS.get("error") else ""))


if __name__ == "__main__":
    main()
