import type { Line, Spec } from "../video/spec";
import { fmt, short } from "../video/spec";
import { monthsToGoal, parseCsv, parseParams, payoff, round, savingsPath, slug } from "./lib";

// A recipe turns one queue row (recipe name + params) into a chart Spec with checked facts.
// Data comes from FRED's public CSV download and the World Bank API; neither needs a key.

type P = Record<string, string>;
type Annual = { years: number[]; values: number[]; partial: boolean };

const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
const list = (v: string | undefined, d: string[]) => (v ? v.split(",").map((s) => s.trim()) : d);
const HYPOTHETICAL = (rate: number) => `Hypothetical ${rate}% yearly return, not a prediction.`;

async function get(url: string) {
  try {
    return await fetch(url);
  } catch {
    throw new Error(`Could not reach ${new URL(url).host}. Check your internet connection and run again.`);
  }
}

export async function fredAnnual(id: string): Promise<Annual> {
  const res = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`FRED series ${id}: HTTP ${res.status}`);
  const byYear = new Map<number, number[]>();
  for (const [date, v] of parseCsv(await res.text()).slice(1)) {
    const n = Number(v);
    if (!/^\d{4}-/.test(date ?? "") || v === "." || v === "" || !Number.isFinite(n)) continue;
    const y = Number(date.slice(0, 4));
    byYear.set(y, [...(byYear.get(y) ?? []), n]);
  }
  if (!byYear.size) throw new Error(`FRED series ${id}: no data (check the series ID on fred.stlouisfed.org)`);
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const counts = years.map((y) => byYear.get(y)!.length);
  return {
    years,
    values: years.map((y) => byYear.get(y)!.reduce((a, b) => a + b, 0) / byYear.get(y)!.length),
    partial: counts.length > 1 && counts.at(-1)! < counts.at(-2)!,
  };
}

const since = (a: Annual, from: number): Annual => {
  const i = a.years.findIndex((y) => y >= from);
  if (i < 0) throw new Error(`No data from ${from} onward`);
  return { years: a.years.slice(i), values: a.values.slice(i), partial: a.partial };
};
const valueIn = (a: Annual, year: number) => {
  const i = a.years.indexOf(year);
  if (i < 0) throw new Error(`No data for ${year}`);
  return a.values[i];
};
const partialNote = (a: Annual) => (a.partial ? [`${a.years.at(-1)} is the average of the months published so far.`] : []);

export async function buildSpec(row: P): Promise<Spec> {
  const p = parseParams(row.params ?? "");
  const base = { id: row.id, series: row.series };
  const recipe = RECIPES[row.recipe];
  if (!recipe) throw new Error(`Unknown recipe "${row.recipe}". Use one of: ${Object.keys(RECIPES).join(", ")}`);
  return { ...base, ...(await recipe(p)) };
}

type Built = Omit<Spec, "id" | "series">;

export const RECIPES: Record<string, (p: P) => Built | Promise<Built>> = {
  /** What an amount from one year is worth in today's money. params: amount, from */
  "value-of-dollars": async (p) => {
    const amount = num(p.amount, 100);
    const from = num(p.from, 1970);
    const cpi = since(await fredAnnual(p.series ?? "CPIAUCNS"), from);
    if (cpi.years[0] !== from) throw new Error(`CPI starts in ${cpi.years[0]}, not ${from}`);
    const points = cpi.years.map((y, i): [number, number] => [y, (amount * cpi.values[i]) / cpi.values[0]]);
    const [latest, today] = points.at(-1)!;
    return {
      headline: `$${amount} in ${from} = *$${fmt(today)}*`,
      sub: `in ${latest} money`,
      annotation: `${fmt(today / amount, { decimals: 1 })}× the dollars`,
      source: `Source: US Bureau of Labor Statistics, CPI-U (FRED ${p.series ?? "CPIAUCNS"})`,
      chart: { kind: "line", x: "year", format: { prefix: "$" }, lines: [{ label: `$${amount} from ${from}`, points }] },
      facts: {
        amount,
        from_year: from,
        latest_year: latest,
        value_today: round(today),
        times: round(today / amount, 1),
        what_todays_amount_bought_then: round((amount * cpi.values[0]) / cpi.values.at(-1)!),
      },
      notes: [
        `value_today: ${amount} dollars of ${from} have the buying power of value_today dollars in ${latest}.`,
        `what_todays_amount_bought_then: ${amount} of today's dollars buys what that many dollars bought in ${from}.`,
        ...partialNote(cpi),
      ],
    };
  },

  /** Same monthly investment started at different ages. params: monthly, ages, end, rate */
  "start-age": (p) => {
    const monthly = num(p.monthly, 300);
    const ages = list(p.ages, ["25", "35"]).map(Number);
    const end = num(p.end, 65);
    const rate = num(p.rate, 7);
    const runs = ages.map((age) => {
      const path = savingsPath(monthly, (end - age) * 12, rate);
      const points = Array.from({ length: end - age + 1 }, (_, y): [number, number] => [age + y, path[y * 12]]);
      return { age, final: round(path.at(-1)!), contributed: monthly * 12 * (end - age), points };
    });
    const facts: Record<string, number> = { monthly, rate_pct: rate, end_age: end };
    runs.forEach((r, i) => {
      facts[`age_${i + 1}`] = r.age;
      facts[`years_invested_${i + 1}`] = end - r.age;
      facts[`final_${i + 1}`] = r.final;
      facts[`contributed_${i + 1}`] = r.contributed;
    });
    facts.gap = runs[0].final - runs[1].final;
    facts.extra_contributed = runs[0].contributed - runs[1].contributed;
    facts.head_start_years = runs[1].age - runs[0].age;
    return {
      headline: `*$${short(runs[0].final)}* vs $${short(runs[1].final)}`,
      sub: `Same $${monthly} a month, invested until ${end}`,
      annotation: `$${short(runs[0].final - runs[1].final)} head start`,
      source: "Calculation: monthly contributions, compounded monthly, no fees or taxes",
      disclaimer: HYPOTHETICAL(rate),
      chart: { kind: "line", x: "age", format: { prefix: "$" }, lines: runs.map((r) => ({ label: `Start at ${r.age}`, points: r.points })) },
      facts,
      notes: ["final_N is the balance at end_age for the person starting at age_N; contributed_N is the money they put in."],
    };
  },

  /** One series divided by another, e.g. home price / income. params: a, b, from, label */
  ratio: async (p) => {
    const from = num(p.from, 1984);
    const [a, b] = await Promise.all([fredAnnual(p.a ?? "MSPUS"), fredAnnual(p.b ?? "MEHOINUSA646N")]);
    const points = a.years
      .filter((y) => y >= from && b.years.includes(y))
      .map((y): [number, number] => [y, valueIn(a, y) / valueIn(b, y)]);
    if (points.length < 2) throw new Error("The two series overlap in fewer than 2 years");
    const peak = points.reduce((m, pt) => (pt[1] > m[1] ? pt : m));
    const [first, last] = [points[0], points.at(-1)!];
    return {
      headline: `${fmt(first[1], { decimals: 1 })}× → *${fmt(last[1], { decimals: 1 })}×*`,
      sub: `${p.label ?? "Years of income to buy a home"}, ${first[0]} vs ${last[0]}`,
      annotation: `peak: ${peak[0]}`,
      source: `Source: ${p.source ?? "US Census Bureau & HUD"} (FRED ${p.a ?? "MSPUS"}, ${p.b ?? "MEHOINUSA646N"})`,
      chart: { kind: "line", x: "year", format: { suffix: "×", decimals: 1 }, lines: [{ label: p.label ?? "Home price ÷ income", points }] },
      facts: {
        from_year: first[0], ratio_from: round(first[1], 1),
        latest_year: last[0], ratio_latest: round(last[1], 1),
        peak_year: peak[0], peak_ratio: round(peak[1], 1),
      },
      notes: [`ratio = ${p.a ?? "median home sale price"} divided by ${p.b ?? "median household income"} (years of income).`, ...partialNote(a)],
    };
  },

  /** Years to reach a goal at several salaries. params: goal, rate, save, salaries */
  "years-to-goal": (p) => {
    const goal = num(p.goal, 1_000_000);
    const rate = num(p.rate, 7);
    const save = num(p.save, 15);
    const salaries = list(p.salaries, ["40000", "60000", "80000", "100000", "150000"]).map(Number);
    const facts: Record<string, number> = { goal, rate_pct: rate, save_pct: save };
    const bars = salaries.map((s, i) => {
      const years = round(monthsToGoal((s * save) / 100 / 12, goal, rate) / 12, 1);
      facts[`salary_${i + 1}`] = s;
      facts[`years_${i + 1}`] = years;
      return { label: `$${short(s)} salary`, value: years };
    });
    return {
      headline: `*$${fmt(goal)}*`,
      sub: `Years to get there saving ${save}% of pay`,
      annotation: "no raises assumed",
      source: "Calculation: monthly saving, compounded monthly, no raises, fees or taxes",
      disclaimer: HYPOTHETICAL(rate),
      chart: { kind: "bars", format: { suffix: " yrs", decimals: 1 }, bars },
      facts,
      notes: ["years_N is how long salary_N takes to reach the goal."],
    };
  },

  /** A price then and now, plus the old price in today's dollars. params: series, from, label, unit, decimals */
  "real-price": async (p) => {
    const from = num(p.from, 1980);
    const decimals = num(p.decimals, 2);
    const [s, cpi] = await Promise.all([fredAnnual(p.series ?? "APU000074714"), fredAnnual("CPIAUCNS")]);
    const nominal = since(s, from);
    const dollarsYear = cpi.years.at(-1)!;
    const years = nominal.years.filter((y) => cpi.years.includes(y));
    const adj = (y: number) => (valueIn(nominal, y) * cpi.values.at(-1)!) / valueIn(cpi, y);
    const adjusted = years.map((y): [number, number] => [y, adj(y)]);
    const peak = adjusted.reduce((m, pt) => (pt[1] > m[1] ? pt : m));
    const first = years[0];
    const money = { prefix: "$", decimals };
    return {
      headline: `${first}: *$${fmt(adj(first), { decimals })}* in today's money`,
      sub: `${p.label ?? "Gas"}${p.unit ? `, ${p.unit}` : ""}, adjusted for inflation`,
      annotation: `${nominal.years.at(-1)} price`,
      source: `Source: US Bureau of Labor Statistics (FRED ${p.series ?? "APU000074714"}, CPIAUCNS)`,
      chart: {
        kind: "line", x: "year", format: money,
        lines: [
          { label: "Price at the time", points: nominal.years.map((y, i): [number, number] => [y, nominal.values[i]]) },
          { label: `In ${dollarsYear} dollars`, points: adjusted },
        ],
      },
      facts: {
        from_year: first, price_from: round(valueIn(nominal, first), decimals), price_from_adjusted: round(adj(first), decimals),
        latest_year: nominal.years.at(-1)!, price_latest: round(nominal.values.at(-1)!, decimals),
        peak_year: peak[0], peak_adjusted: round(peak[1], decimals), dollars_year: dollarsYear,
      },
      notes: [`*_adjusted values are in ${dollarsYear} dollars.`, ...partialNote(nominal)],
    };
  },

  /** Minimum payments vs a fixed payment. params: balance, apr, fixed, minpct, floor */
  "debt-payoff": (p) => {
    const balance = num(p.balance, 5000);
    const apr = num(p.apr, 22);
    const fixed = num(p.fixed, 200);
    const minPct = num(p.minpct, 1);
    const floor = num(p.floor, 25);
    const min = payoff(balance, apr, (bal, due) => Math.max(due + (bal * minPct) / 100, floor));
    const fix = payoff(balance, apr, () => fixed);
    const toLine = (label: string, path: number[]): Line => ({ label, points: path.map((b, m): [number, number] => [m / 12, b]) });
    return {
      headline: `*${Math.round(min.months / 12)} years*`,
      sub: `to pay off $${fmt(balance)} with minimum payments`,
      annotation: `$${fmt(min.interest)} in interest`,
      source: "Calculation · APR context: Federal Reserve G.19 (FRED TERMCBCCINTNS)",
      disclaimer: `${apr}% APR. Minimum = interest + ${minPct}% of balance ($${floor} floor). Card issuers vary.`,
      chart: { kind: "line", x: "years", format: { prefix: "$" }, lines: [toLine("Minimum payments", min.path), toLine(`$${fixed} a month`, fix.path)] },
      facts: {
        balance, apr_pct: apr, fixed_payment: fixed, min_pct: minPct, min_floor: floor,
        min_months: min.months, min_years: round(min.months / 12, 1), min_interest: round(min.interest),
        fixed_months: fix.months, fixed_years: round(fix.months / 12, 1), fixed_interest: round(fix.interest),
      },
      notes: ["min_* is paying only the minimum; fixed_* is paying fixed_payment every month. No new charges."],
    };
  },

  /** Cumulative inflation by country from World Bank data. params: from, top, highlight (ISO3) */
  "world-inflation": async (p) => {
    const from = num(p.from, 2000);
    const top = num(p.top, 10);
    const highlight = p.highlight ?? "USA";
    const wb = async (q: string) => {
      const res = await get(`https://api.worldbank.org/v2/${q}`);
      if (!res.ok) throw new Error(`World Bank: HTTP ${res.status}`);
      return ((await res.json()) as [unknown, unknown[]])[1];
    };
    const countries = (await wb("country?format=json&per_page=400")) as { id: string; name: string; region: { value: string } }[];
    const real = new Map(countries.filter((c) => c.region.value !== "Aggregates").map((c) => [c.id, c.name]));
    const rows = (await wb(`country/all/indicator/FP.CPI.TOTL.ZG?format=json&per_page=20000&date=${from}:${new Date().getFullYear()}`)) as
      { countryiso3code: string; date: string; value: number | null }[];
    const byCountry = new Map<string, Map<number, number>>();
    const perYear = new Map<number, number>();
    for (const r of rows) {
      if (r.value === null || !real.has(r.countryiso3code)) continue;
      const y = Number(r.date);
      byCountry.set(r.countryiso3code, (byCountry.get(r.countryiso3code) ?? new Map()).set(y, r.value));
      perYear.set(y, (perYear.get(y) ?? 0) + 1);
    }
    const last = Math.max(...[...perYear].filter(([, n]) => n >= 100).map(([y]) => y));
    const multiples = [...real.keys()].flatMap((iso) => {
      const series = byCountry.get(iso);
      let m = 1;
      for (let y = from; y <= last; y++) {
        const r = series?.get(y);
        if (r === undefined) return [];
        m *= 1 + r / 100;
      }
      return [{ iso, name: real.get(iso)!, multiple: m }];
    }).sort((a, b) => b.multiple - a.multiple);
    const shown = multiples.slice(0, top);
    const mine = multiples.find((c) => c.iso === highlight);
    if (mine && !shown.includes(mine)) shown.push(mine);
    const decimals = shown[0].multiple < 100 ? 1 : 0;
    return {
      headline: `*${short(shown[0].multiple, { decimals })}×* in ${shown[0].name}`,
      sub: `How much prices multiplied, ${from}–${last}`,
      annotation: mine ? `${mine.name}: #${multiples.indexOf(mine) + 1}` : undefined,
      source: "Source: World Bank, Inflation, consumer prices (FP.CPI.TOTL.ZG), CC BY 4.0",
      chart: { kind: "bars", format: { suffix: "×", decimals }, bars: shown.map((c) => ({ label: c.name, value: round(c.multiple, decimals), highlight: c.iso === highlight })) },
      facts: {
        from_year: from, latest_year: last, countries_compared: multiples.length,
        countries_left_out: real.size - multiples.length, top_multiple: round(shown[0].multiple, decimals),
        ...(mine ? { highlight_multiple: round(mine.multiple, 1), highlight_rank: multiples.indexOf(mine) + 1 } : {}),
      },
      notes: [
        `#1 is ${shown[0].name}. The top ${top}: ${shown.slice(0, top).map((c) => c.name).join(", ")}.`,
        `highlight_* is ${mine?.name ?? highlight}. Countries with any missing year are left out.`,
      ],
    };
  },

  /** A small daily amount saved for years. params: daily, years, rate */
  "daily-habit": (p) => {
    const daily = num(p.daily, 5);
    const years = num(p.years, 30);
    const rate = num(p.rate, 7);
    const monthly = (daily * 365) / 12;
    const path = savingsPath(monthly, years * 12, rate);
    const at = (y: number) => round(path[y * 12]);
    const mid = Math.max(years - 10, 0);
    const yearsAxis = Array.from({ length: years + 1 }, (_, y) => y);
    return {
      headline: `$${daily} a day → *$${short(at(years))}*`,
      sub: `after ${years} years, invested monthly`,
      annotation: `you put in $${short(monthly * 12 * years)}`,
      source: "Calculation: monthly contributions, compounded monthly, no fees or taxes",
      disclaimer: HYPOTHETICAL(rate),
      chart: {
        kind: "line", x: "years", format: { prefix: "$" },
        lines: [
          { label: "Hypothetical balance", points: yearsAxis.map((y): [number, number] => [y, path[y * 12]]) },
          { label: "Money put in", points: yearsAxis.map((y): [number, number] => [y, monthly * 12 * y]) },
        ],
      },
      facts: {
        daily, monthly: round(monthly, 2), years, rate_pct: rate, contributed: round(monthly * 12 * years),
        final: at(years), mid_year: mid, value_at_mid_year: at(mid), last_10_years_gain: at(years) - at(mid),
      },
      notes: ["value_at_mid_year is the balance after mid_year years; last_10_years_gain is what the final 10 years added."],
    };
  },

  /** Several price indexes rebased to 1 in the start year. params: series, labels, from */
  indexed: async (p) => {
    const ids = list(p.series, ["CUUR0000SEEB01", "CPIAUCNS"]);
    const labels = list(p.labels, ["College tuition", "All prices"]);
    const data = await Promise.all(ids.map(fredAnnual));
    const start = Math.max(num(p.from, 1980), ...data.map((d) => d.years[0]));
    const end = Math.min(...data.map((d) => d.years.at(-1)!));
    const facts: Record<string, number> = { from_year: start, latest_year: end };
    const lines = data.map((d, i) => {
      const base = valueIn(d, start);
      const points = d.years.filter((y) => y >= start && y <= end).map((y): [number, number] => [y, valueIn(d, y) / base]);
      facts[`times_${slug(labels[i])}`] = round(points.at(-1)![1], 1);
      return { label: labels[i], points };
    });
    const t = lines.map((l) => fmt(l.points.at(-1)![1], { decimals: 1 }));
    return {
      headline: `*${t[0]}×* vs ${t[1]}×`,
      sub: `${labels.join(" vs ")}, ${start}–${end}`,
      source: `Source: US Bureau of Labor Statistics (FRED ${ids.join(", ")})`,
      chart: { kind: "line", x: "year", format: { suffix: "×", decimals: 1 }, lines },
      facts,
      notes: [`times_X is how many times higher X is in ${end} than in ${start}.`, ...data.flatMap(partialNote)],
    };
  },

  /** Average prices of one or more items. params: series, labels, from */
  prices: async (p) => {
    const ids = list(p.series, ["APU0000708111", "APU0000717311", "APU0000703112"]);
    const labels = list(p.labels, ["Eggs (dozen)", "Coffee (lb)", "Ground beef (lb)"]);
    const [cpi, ...data] = await Promise.all(["CPIAUCNS", ...ids].map(fredAnnual));
    const start = Math.max(num(p.from, 2000), ...data.map((d) => d.years[0]));
    const end = Math.min(...data.map((d) => d.years.at(-1)!));
    const facts: Record<string, number> = { from_year: start, latest_year: end };
    const lines = data.map((d, i) => {
      const points = d.years.filter((y) => y >= start && y <= end).map((y): [number, number] => [y, valueIn(d, y)]);
      facts[`price_${slug(labels[i])}_from`] = round(points[0][1], 2);
      facts[`price_${slug(labels[i])}_latest`] = round(points.at(-1)![1], 2);
      return { label: labels[i], points };
    });
    const total = (y: number) => data.reduce((s, d) => s + valueIn(d, y), 0);
    facts.basket_from = round(total(start), 2);
    facts.basket_latest = round(total(end), 2);
    facts.basket_times = round(total(end) / total(start), 1);
    if (cpi.years.includes(end)) facts.all_prices_times = round(valueIn(cpi, end) / valueIn(cpi, start), 1);
    return {
      headline: `$${fmt(total(start), { decimals: 2 })} → *$${fmt(total(end), { decimals: 2 })}*`,
      sub: `${labels.join(" + ")}, ${start} vs ${end}`,
      source: `Source: US Bureau of Labor Statistics average prices (FRED ${ids.join(", ")})`,
      chart: { kind: "line", x: "year", format: { prefix: "$", decimals: 2 }, lines },
      facts,
      notes: ["basket_* is the sum of all items. all_prices_times is overall inflation (CPI-U) over the same years.", ...data.flatMap(partialNote)],
    };
  },
};
