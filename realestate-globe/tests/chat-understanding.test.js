// Generates ~2,000 questions per seed (paraphrases, regions, countries, cities, price
// limits and random typos) with known meanings, and checks the Ask AI chat understands them.
//   npm i playwright d3@7.9.0 && node tests/chat-understanding.test.js [seed]
const path = require('path');
const { chromium } = require('playwright');
const SEED = +process.argv[2] || 1;
const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const p = await b.newPage();
  // use a local d3 when there is one (offline runs); otherwise the page loads it from cdnjs
  const fs = require('fs');
  const d3 = [__dirname, path.join(__dirname, '..'), process.cwd()].map(d=>path.join(d, 'node_modules', 'd3', 'dist', 'd3.min.js')).find(f=>fs.existsSync(f));
  if (d3) await p.route('**/d3.min.js', r=>r.fulfill({path:d3, contentType:'application/javascript'}));
  await p.route('**fonts.g**', r=>r.abort());
  await p.goto(PAGE); await p.waitForTimeout(1500);
  const res = await p.evaluate((SEED)=>{
    const B = window.__atlasBrain;
    let s = SEED*7919; const rnd = ()=>((s=(s*16807)%2147483647)/2147483647); const pick = a => a[Math.floor(rnd()*a.length)];
    const typo = w => { if (w.length < 5) return w; const i = 1 + Math.floor(rnd()*(w.length-2)); const k = Math.floor(rnd()*3);
      return k===0 ? w.slice(0,i)+w[i+1]+w[i]+w.slice(i+2) : k===1 ? w.slice(0,i)+w.slice(i+1) : w.slice(0,i)+w[i]+w.slice(i); };
    const messy = q => q.split(" ").map(w => (/^[a-z]{6,}$/i.test(w) && rnd() < .35) ? typo(w) : w).join(" ");
    const REG = [["",null],[" in europe","europe"],[" in asia","asia"],[" in africa","africa"],[" in latin america","latin america"],[" in the middle east","middle east"],[" in south america","latin america"],[" in southeast asia","asia"],[" in eastern europe","europe"]];
    const CTRY = [["Poland","POL"],["Germany","DEU"],["Mexico","MEX"],["Thailand","THA"],["Russia","RUS"],["Venezuela","VEN"],["Kenya","KEN"],["Vietnam","VNM"],["Portugal","PRT"],["Brazil","BRA"],["the USA","USA"],["the UK","GBR"],["UAE","ARE"],["China","CHN"],["Japan","JPN"],["India","IND"],["Colombia","COL"],["Turkey","TUR"],["Argentina","ARG"],["Nigeria","NGA"],["Spain","ESP"],["Georgia","GEO"],["Rwanda","RWA"],["Indonesia","IDN"],["Philippines","PHL"],["Canada","CAN"],["Australia","AUS"],["Egypt","EGY"],["Morocco","MAR"],["Slovakia","SVK"],["Lithuania","LTU"],["Romania","ROU"],["Cuba","CUB"],["South Africa","ZAF"],["Saudi Arabia","SAU"]];
    const CITY = ["Lisbon","Warsaw","Austin","Dubai","Medellin","Kigali","Nairobi","Lagos","Bangkok","Hanoi","Berlin","Madrid","Krakow","Tbilisi","Istanbul","Miami","Toronto","Sydney","Tokyo","Mumbai","Cairo","Riyadh","Dallas","Phoenix","Prague","Budapest","Bucharest","Manila","Jakarta","Bogota","Lima","Santiago","Accra","Casablanca","Porto","Valencia","Milan","Athens","Moscow","Caracas","Bratislava","Vilnius"];
    const cases = [];
    const add = (q, exp) => { cases.push([q, exp]); cases.push([messy(q), exp]); };
    for (const [rs, r] of REG){
      for (const t of ["cheap places with the most growth","best value places","where should I build cheap with high potential","best cheap and most potencial places","bargains for real estate","good deals to invest","cheap cities with growth potential","which places are cheap but growing"]) add(t+rs, {intent:"list", sort:"value", region:r});
      for (const t of ["cheapest places","cheapest cities","most affordable places to build","where is land cheap","low cost cities"]) add(t+rs, {intent:"list", sort:"price", region:r});
      add("cheapest big cities"+rs, {intent:"list", sort:"price", region:r, big:true});
      add("cheapest towns"+rs, {intent:"list", sort:"price", region:r, small:true});
      for (const t of ["most growth potential","fastest growing cities","where will prices rise","booming cities","emerging markets with growth"]) add(t+rs, {intent:"list", sort:"potential", region:r});
      for (const t of ["worst places to build","where should I avoid building","riskiest cities"]) add(t+rs, {intent:"list", lowest:true, region:r});
      for (const t of ["cheap places under $1500","cheap growth cities under 1500 dollars","best value under 1.5k per m2"]) add(t+rs, {intent:"list", maxPrice:1500, region:r});
      add("top 10 cheap places with growth"+rs, {intent:"list", sort:"value", region:r, limit:10});
      add("safest cheap places with growth"+rs, {intent:"list", sort:"value", region:r, safe:true});
    }
    for (const [name, iso] of CTRY){
      for (const t of [`${name}`,`why is ${name} rated badly?`,`tell me about ${name}`,`is ${name} good for real estate`,`what are the risks in ${name}`]) add(t, {intent:"country", country:iso});
      for (const t of [`can foreigners own property in ${name}?`,`can the goverment take my house in ${name}`,`is my land safe from seizure in ${name}`,`property rights in ${name}`]) add(t, {intent:"property", country:iso});
      for (const t of [`cheapest cities in ${name}`,`best value places in ${name}`,`where to build in ${name}`,`top 5 cities in ${name} with growth`]) add(t, {intent:"list", country:iso});
    }
    for (const c of CITY){
      for (const t of [`${c}`,`tell me about ${c}`,`is ${c} cheap?`,`how much does it cost to build in ${c}`,`why is ${c} rated like that`,`is ${c} a good place to build`]) add(t, {intent:"place", place:c});
    }
    for (let i=0;i<120;i++){ const a = pick(CITY), c2 = pick(CITY); if (a===c2) continue;
      add(pick([`${a} vs ${c2}`,`compare ${a} and ${c2}`,`${a} or ${c2}?`,`which is better ${a} or ${c2}`]), {intent:"compare"}); }
    for (let i=0;i<40;i++){ const [a]=pick(CTRY), [c2]=pick(CTRY); if (a===c2) continue; add(`compare ${a} and ${c2}`, {intent:"compare"}); }
    for (const t of ["where can the government take my property?","which countries seize property","where do governments confiscate land","countries where foreigners cannot own land","which goverments can take my properties","in which countris can goverments take you properties"]) add(t, {intent:"property"});
    for (const t of ["what do the percentages mean","how are the scores calculated","what is the value score","what does growth potential mean","what do the procentages mean"]) add(t, {intent:"explain"});
    for (const t of ["hi","hello there","thanks!","thank you"]) cases.push([t, {intent: /thank/.test(t) ? "thanks" : "hello"}]);
    for (const t of ["asdf qwerty","tell me a joke","banana"]) cases.push([t, {intent:"unknown"}]);
    // the user's own wording from this conversation
    for (const t of ["make it so it would show the best cheap and most potential","best cheap and most potencial","where are the best places to make a company of real estate"]) cases.push([t, {intent:"list", sort:"value"}]);

    const fails = []; let ok = 0;
    for (const [q, e] of cases){
      const u = B.understand(q), intent = B.decide(u);
      const why = [];
      if (intent !== e.intent) why.push(`intent ${intent}`);
      if (e.region !== undefined && u.region !== e.region) why.push(`region ${u.region}`);
      if (e.country && !u.countries.includes(e.country) && !(u.places[0] && u.places[0].ck===e.country)) why.push(`countries ${u.countries}`);
      if (e.place && !(u.places[0] && u.places[0].name.toLowerCase().startsWith(e.place.toLowerCase().slice(0,4)))) why.push(`places ${u.places.map(p=>p.name)}`);
      if (e.maxPrice && u.maxPrice !== e.maxPrice) why.push(`maxPrice ${u.maxPrice}`);
      if (e.limit && u.limit !== e.limit) why.push(`limit ${u.limit}`);
      if (e.intent === "list" && (e.sort || e.lowest || e.big || e.small || e.safe)){
        const s = (()=>{ const has=c=>u.concepts.has(c); return {lowest:has("worst"), big:has("big"), small:has("small"), safe:has("safe"),
          sort: has("worst") ? "overall" : (has("cheap")&&has("growth")) || has("value") ? "value" : has("cheap") ? "price" : has("growth") ? "potential" : "value"}; })();
        if (e.sort && s.sort !== e.sort) why.push(`sort ${s.sort}`);
        if (e.lowest && !s.lowest) why.push("not lowest");
        if (e.big && !s.big) why.push("not big");
        if (e.small && !s.small) why.push("not small");
        if (e.safe && !s.safe) why.push("not safe");
      }
      // every answer must say something
      const a = B.localAnswer(q); if (!a.text || a.text.length < 20) why.push("empty answer");
      if (why.length) fails.push(q + "  =>  " + why.join(", ") + "  [" + [...u.concepts].join(",") + "]"); else ok++;
    }
    return {total:cases.length, ok, fails};
  }, SEED);
  console.log(`seed ${SEED}: ${res.ok}/${res.total} understood (${(100*res.ok/res.total).toFixed(1)}%)`);
  res.fails.slice(0, 60).forEach(f=>console.log("  ✗ " + f));
  await b.close();
  process.exitCode = res.ok / res.total >= 0.995 ? 0 : 1;
})();
