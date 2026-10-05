// Unit test for verify.js (finding a website the map data missed), with a fake web.
//   node verify.test.js
const { findWebsite, hostMatches, pageMentions, resultLinks, parked } = require("./verify");

let failures = 0;
const results = [];
const check = (ok, msg) => { console.log((ok ? "  ok  " : "  FAIL ") + msg); results.push([ok, msg]); if (!ok) failures++; };

// --- does an address look like the business's own? ---
check(hostMatches("katzsdelicatessen.com", "Katz's Delicatessen"), "katzsdelicatessen.com belongs to Katz's Delicatessen");
check(hostMatches("joespizzanyc.com", "Joe's Pizza"), "joespizzanyc.com belongs to Joe's Pizza");
check(hostMatches("nonnarosa.it", "Nonna Rosa"), "nonnarosa.it belongs to Nonna Rosa");
check(hostMatches("mamas.wixsite.com", "Mama's Kitchen"), "a free Wix site counts as the business's site");
check(hostMatches("kavinezalias.lt", "Kavinė Žalias") , "accents in the name are ignored (Kavinė Žalias, kavinezalias.lt)");
check(!hostMatches("yelp.com", "Katz's Delicatessen") && !hostMatches("www.tripadvisor.co.uk", "Katz's Delicatessen") && !hostMatches("facebook.com", "Katz"), "review and social sites never count");
check(!hostMatches("pizza.com", "Joe's Pizza") && !hostMatches("bestpizza.com", "Joe's Pizza"), "a generic word alone is not a match (pizza.com for Joe's Pizza)");
check(!hostMatches("rosas.com", "Nonna Rosa"), "a partial name is not a match (rosas.com for Nonna Rosa)");
check(!hostMatches("katzdeli.yelp.com", "Katz's Delicatessen"), "a page on a review site is not the business's site");

// --- page content ---
check(pageMentions("<title>Katz&#39;s Delicatessen | Since 1888</title>", "Katz's Delicatessen"), "a page with the name in its title mentions the business");
check(!pageMentions("<title>Welcome</title><p>Best deli in town</p>", "Katz's Delicatessen"), "a page without the name does not");
check(parked("<h1>This domain is for sale!</h1>") && parked("Buy this domain at Afternic") && !parked("<h1>Katz's Delicatessen</h1>"), "parked 'domain for sale' pages are recognised");

// --- result links from search pages ---
const bingLink = u => `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(u).toString("base64url")}&ntb=1`;
const links = resultLinks(`<a href="${bingLink("https://katzsdelicatessen.com/")}">Katz</a><a href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.yelp.com/biz/katzs")}">Yelp</a><a href="/search?q=x">next</a><a href="https://www.tripadvisor.com/x">TA</a>`);
check(links.includes("https://katzsdelicatessen.com/") && links.includes("https://www.yelp.com/biz/katzs") && links.includes("https://www.tripadvisor.com/x") && !links.some(u => /search\?q/.test(u)),
  "result links are unwrapped from Bing and DuckDuckGo redirects: " + JSON.stringify(links));

// --- the whole check, on a fake web ---
function fakeWeb(pages) {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    const host = new URL(url).hostname;
    for (const [pattern, page] of pages) if (pattern.test(url) || pattern.test(host)) {
      if (page === "down") throw new Error("ECONNREFUSED");
      return { ok: (page.status || 200) < 400, status: page.status || 200, url, text: page.text || page };
    }
    throw new Error("ENOTFOUND " + host);
  };
  return { get, calls };
}
const results200 = (...urls) => urls.map(u => `<li><a href="${bingLink(u)}">${u}</a></li>`).join("") + '<a href="https://www.yelp.com/a">y</a><a href="https://www.tripadvisor.com/b">t</a><a href="https://www.facebook.com/c">f</a>';

(async () => {
  let w = fakeWeb([[/katzsdelicatessen\.com/, "<title>Katz's Delicatessen</title>"]]);
  let r = await findWebsite({ name: "Katz's Delicatessen", city: "New York" }, w.get);
  check(r.url && /katzsdelicatessen\.com/.test(r.url) && /name/.test(r.how) && !w.calls.some(u => /bing/.test(u)), `finds a website at the address of its name, without searching (${r.url}, ${r.how})`);

  w = fakeWeb([[/bing\.com/, results200("https://nonnarosanyc.com/menu", "https://www.timeout.com/x", "https://example.org/")], [/nonnarosanyc\.com/, "<h1>Nonna Rosa — Italian kitchen</h1>"]]);
  r = await findWebsite({ name: "Nonna Rosa", city: "New York", street: "Ludlow St" }, w.get);
  check(r.url === "https://nonnarosanyc.com/" && /search/.test(r.how), `finds a website by searching the web (${r.url}, ${r.how})`);
  check(w.calls.some(u => /bing\.com\/search\?q=Nonna%20Rosa%20Ludlow%20St%20New%20York/.test(u)), "searches for the name, street and town");

  w = fakeWeb([[/bing\.com/, results200("https://www.yelp.com/biz/little-cup", "https://www.instagram.com/littlecup", "https://news.example.com/cafes")]]);
  r = await findWebsite({ name: "Little Cup", city: "Brooklyn" }, w.get);
  check(r.url === null && r.searched === true, "reports no website when the search only finds review and social pages");

  w = fakeWeb([[/littlecup\.com/, "<h1>This domain is for sale</h1> Little Cup"], [/bing\.com/, results200("https://a.example.com/", "https://b.example.com/", "https://c.example.com/")]]);
  r = await findWebsite({ name: "Little Cup", city: "Brooklyn" }, w.get);
  check(r.url === null, "a parked 'for sale' page at the name's address is not a website");

  w = fakeWeb([[/bing\.com/, { status: 200, text: "<html>Please solve the challenge</html>" }], [/search\.brave\.com/, results200("https://tacospotla.com/", "https://x.example.com/", "https://y.example.com/")], [/tacospotla\.com/, "<title>Taco Spot</title>"]]);
  r = await findWebsite({ name: "Taco Spot", city: "Los Angeles" }, w.get);
  check(r.url === "https://tacospotla.com/" && w.calls.some(u => /brave/.test(u)), `when Bing asks "are you human", Brave is asked instead (${r.url})`);

  w = fakeWeb([]);
  r = await findWebsite({ name: "Corner Barber", city: "Vilnius" }, w.get);
  check(r.url === null && r.searched === false, "with no internet, says it could not check (not that there is no website)");

  w = fakeWeb([[/bing\.com/, results200("https://cornerbarbervilnius.lt/", "https://x.example.com/", "https://y.example.com/")], [/cornerbarbervilnius\.lt/, "down"]]);
  r = await findWebsite({ name: "Corner Barber", city: "Vilnius", tld: "lt" }, w.get);
  check(r.url === "https://cornerbarbervilnius.lt/" && r.broken, "a website found by search that does not load still counts (as broken)");
  check(w.calls.some(u => /cornerbarber\.lt/.test(u)), "also tries the name with the country's ending (cornerbarber.lt)");

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  if (process.env.GITHUB_STEP_SUMMARY) require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n### Website double-check (unit test)\n\n" + results.map(([ok, m]) => `- ${ok ? "✅" : "❌"} ${m}`).join("\n") + "\n");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
