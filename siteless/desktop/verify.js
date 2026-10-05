// Does a place really have no website? OpenStreetMap often just doesn't list one, so this looks
// the way a person would: it tries the obvious web addresses for the name, then searches the web
// for the name and town and looks for a result whose address matches the name.
// Runs in the app's main process (no browser restrictions); `get(url, opts)` is injected so the
// logic can be tested without the internet.

// sites that list businesses but are not the business's own website
const NOT_OWN = /(^|\.)(facebook|fb|instagram|twitter|x|threads|tiktok|youtube|youtu|linkedin|pinterest|snapchat|whatsapp|telegram|yelp|tripadvisor|google|goo|gstatic|googleusercontent|blogger|foursquare|ubereats|uber|doordash|grubhub|deliveroo|justeat|just-eat|wolt|bolt|glovo|foodpanda|opentable|thefork|resy|zomato|timeout|wikipedia|wikimedia|wikidata|wikivoyage|mapquest|yellowpages|yell|bbb|apple|bing|microsoft|msn|duckduckgo|yahoo|mojeek|openstreetmap|osm|waze|booking|expedia|hotels|airbnb|agoda|trivago|kayak|trustpilot|nextdoor|groupon|menupages|allmenus|seamless|postmates|restaurantguru|wanderlog|happycow|untappd|cylex|cylex-usa|hotfrog|manta|chamberofcommerce|birdeye|tupalo|infobel|europages|kompass|dnb|zoominfo|indeed|glassdoor|reddit|quora|medium|eater|infatuation|michelin|guide|thrillist|zagat|sluurpy|top-rated|restaurantji|menuism|beyondmenu|grubstreet|citysearch|superpages|local|merchantcircle|showmelocal|brownbook|find-open|opendi|n49|yably|storeboard|bizapedia|opencorporates|companieshouse|gov|amazon|ebay|etsy|archive|bizbuysell|loopnet|zillow|realtor|redfin|streeteasy|apartments|rent|ticketmaster|eventbrite|meetup|allevents|songkick|bandsintown|vagaro|fresha|booksy|styleseat|mindbodyonline|classpass|treatwell|planity|setmore|square|squareup|toasttab|clover|chownow|slicelife|menufy|order-online|orderonline|beyondmenu|dineinapp|appfront|sirved|waiterio|myguide|visit[a-z]*|tourism|lonelyplanet|frommers|fodors|cntraveler|nytimes|theguardian|bbc|cnn)\.[a-z.]+$/i;
const GENERIC = new Set(['the', 'and', 'of', 'de', 'la', 'le', 'el', 'del', 'di', 'da', 'du', 'des', 'los', 'las', 'y', 'e', 'et', 'und', 'a', 'an', 'at', 'on', 'in', 'by', 'for', 'to', 'n',
  'restaurant', 'restaurants', 'restaurante', 'ristorante', 'cafe', 'caffe', 'coffee', 'kava', 'kavine', 'bar', 'pub', 'grill', 'kitchen', 'bistro', 'bakery', 'deli', 'diner', 'pizza', 'pizzeria',
  'sushi', 'burger', 'burgers', 'tacos', 'taqueria', 'food', 'foods', 'house', 'shop', 'store', 'market', 'salon', 'hair', 'beauty', 'nails', 'nail', 'spa', 'studio', 'barber', 'barbers',
  'barbershop', 'auto', 'repair', 'service', 'services', 'center', 'centre', 'clinic', 'dental', 'hotel', 'hostel', 'motel', 'inn', 'gym', 'fitness', 'club', 'co', 'company', 'ltd', 'llc', 'inc',
  'gmbh', 'uab', 'sa', 'srl', 'new', 'york', 'nyc', 'street', 'st', 'ave', 'avenue', 'road', 'rd', 'express', 'place', 'corner', 'garden', 'family', 'original', 'best', 'city']);
const PARKED = /domain (name )?(is |may be )?for sale|buy this domain|this domain (is|has been) (registered|parked)|parked (free|domain)|domain parking|sedoparking|godaddy\.com\/domains|afternic|dan\.com|hugedomains|undeveloped\.com|is available for purchase|future home of|coming soon|account suspended|website is under construction|default web page|it works!|welcome to nginx|iis windows server/i;

const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '');
const tokens = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
const compact = s => tokens(s).join('');
const distinctive = name => tokens(name).filter(t => t.length >= 4 && !GENERIC.has(t));
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\d?\./, '').toLowerCase(); } catch (e) { return ''; } };
const labelOf = host => host.split('.').slice(0, -1).filter(l => !['co', 'com', 'org', 'net'].includes(l)).join('');   // joespizza.co.uk -> joespizza

// does this web address look like it belongs to a business with this name?
function hostMatches(host, name) {
  if (!host || NOT_OWN.test(host)) return false;
  const label = labelOf(host).replace(/[^a-z0-9]/g, '');
  const full = compact(name);
  if (label.length < 4) return false;
  if (full.length >= 6 && label.includes(full)) return true;                       // joespizzanyc.com for Joe's Pizza
  if (full.length >= 6 && label.length >= 8 && label.length >= full.length * 0.7 && full.includes(label)) return true;   // most of the name
  // otherwise every distinctive word of the name must be in it (not just "first" or "italian")
  const d = distinctive(name);
  return d.length > 0 && d.every(t => label.includes(t));
}
// the address made from the whole name, or the name inside a longer address
const strongHost = (host, name) => { const full = compact(name.replace(/^the\s+/i, '')); return full.length >= 6 && labelOf(host).replace(/[^a-z0-9]/g, '').includes(full); };
const pageText = html => fold(String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&rsquo;/g, "'"));
// does this page talk about the business?
function pageMentions(html, name) {
  const flat = pageText(html).replace(/[^a-z0-9]/g, '');
  const full = compact(name);
  if (full.length >= 4 && flat.includes(full)) return true;
  const d = distinctive(name);
  return d.length > 0 && d.every(t => flat.includes(t));
}
const parked = html => PARKED.test(String(html).slice(0, 60000));
// what we know about where the place is: words of its street, its phone, its town
function whereClues(place) {
  const street = tokens(place.street).filter(t => t.length >= 4 && !/^\d+$/.test(t) && !GENERIC.has(t) && !['east', 'west', 'north', 'south', 'gatve', 'strasse', 'rue', 'calle', 'via'].includes(t));
  const phone = String(place.phone || '').replace(/\D/g, '');
  const city = compact(place.city);
  return { street, phone: phone.length >= 7 ? phone.slice(-7) : '', city: city.length >= 4 ? city : '' };
}
const hasClues = c => c.street.length > 0 || !!c.phone || !!c.city;
// does the page show it is this place, in this town?
function pageIsHere(html, clues) {
  const flat = pageText(html).replace(/[^a-z0-9]/g, '');
  const digits = String(html).replace(/\D/g, '');
  return clues.street.some(t => flat.includes(t)) || (!!clues.phone && digits.includes(clues.phone)) || (!!clues.city && flat.includes(clues.city));
}

// links in a search results page, unwrapped from the engines' redirect links
function resultLinks(html) {
  const out = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1].replace(/&amp;/g, '&');
    try {
      if (u.startsWith('//')) u = 'https:' + u;
      const url = new URL(u, 'https://search.invalid/');
      const q = url.searchParams;
      if (q.get('uddg')) u = q.get('uddg');                                  // DuckDuckGo
      else if (/^a1/.test(q.get('u') || '')) {                                // Bing
        u = Buffer.from(q.get('u').slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } else if (/\/RU=/.test(u)) u = decodeURIComponent(u.split('/RU=')[1].split('/R')[0]);   // Yahoo
      else if (url.pathname === '/url' && q.get('q')) u = q.get('q');         // Google
      else if (url.hostname === 'search.invalid') continue;
      if (/^https?:\/\//i.test(u)) out.push(u);
    } catch (e) { /* not a link */ }
  }
  return [...new Set(out)];
}

const SEARCH = [
  q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`,
  q => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
];
const ENGINES = /(^|\.)(bing|microsoft|msn|live|brave|duckduckgo|yahoo|mojeek|google|gstatic)\.[a-z.]+$/i;
// an engine answered if it gave a page of ordinary result links (a "prove you're human" page has none)
const answered = (r, links) => r && r.ok && r.status === 200 && links.filter(u => !ENGINES.test(hostOf(u))).length >= 3;

// place: { name, city, street, tld }  ->  { url, how } when a website is found, { url: null, searched } when not
async function findWebsite(place, get, opts = {}) {
  const name = String(place.name || '').trim();
  if (!name) return { url: null, searched: false };
  // a place named after its town ("Berlin") can't be told apart from the town's own sites
  if (compact(name) === compact(place.city)) return { url: null, searched: false };
  const clues = whereClues(place);
  const tried = new Set();
  // a site counts if it is about this business and shows it is this one (its street, phone or
  // town on the home or contact page). Without any of those to go on, only an address made of
  // the whole name counts.
  const confirm = async (url, how, fromSearch) => {
    const host = hostOf(url);
    if (!host || tried.has(host)) return null;
    tried.add(host);
    const strong = strongHost(host, name);
    const r = await get(`https://${host}/`, { timeout: 8000 }).catch(() => null);
    if (!r || !r.ok) return fromSearch && strong ? { url: `https://${host}/`, how, broken: true } : null;   // listed for this search, does not load
    if (parked(r.text) || !pageMentions(r.text, name)) return null;
    if (!hasClues(clues)) return strong ? { url: r.url || `https://${host}/`, how } : null;
    if (pageIsHere(r.text, clues)) return { url: r.url || `https://${host}/`, how };
    for (const path of ['contact', 'contact-us', 'kontaktai', 'kontakt', 'about']) {
      const c = await get(`https://${host}/${path}`, { timeout: 6000 }).catch(() => null);
      if (c && c.ok && pageIsHere(c.text, clues)) return { url: r.url || `https://${host}/`, how };
    }
    return null;
  };

  // 1. the obvious addresses: joespizza.com, joespizza.<country>
  const base = compact(name.replace(/^the\s+/i, ''));
  if (base.length >= 5 && base.length <= 40) {
    const tlds = ['com', ...(place.tld && place.tld !== 'com' ? [place.tld] : [])];
    for (const tld of tlds) {
      const hit = await confirm(`https://${base}.${tld}/`, 'its name as a web address', false);
      if (hit) return hit;
    }
  }

  // 2. a web search for the name and town
  const q = [name, place.street, place.city].filter(Boolean).join(' ');
  let searched = false;
  for (const engine of opts.engines || SEARCH) {
    const r = await get(engine(q), { timeout: 10000, search: true }).catch(() => null);
    const all = r ? resultLinks(r.text) : [];
    if (!answered(r, all)) continue;
    searched = true;
    const links = all.filter(u => hostMatches(hostOf(u), name)).slice(0, 4);
    for (const u of links) {
      const hit = await confirm(u, 'a web search', true);
      if (hit) return hit;
    }
    break;   // one engine answered; its results are the answer
  }
  return { url: null, searched };
}

module.exports = { findWebsite, hostMatches, pageMentions, pageIsHere, whereClues, resultLinks, parked, compact };
