import assert from "node:assert/strict";
import { test } from "node:test";
import { charsToCaptions, parseCsv, payoff, round, savingsPath, toCsv, unverifiedNumbers } from "./lib";

test("csv round-trips commas, quotes and line breaks", () => {
  const rows = [["id", "script"], ["1", 'He said "save", then\nwaited, a lot']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.deepEqual(parseCsv("﻿a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("investing $300/month at 7% from 25 vs 35 to 65", () => {
  assert.equal(round(savingsPath(300, 480, 7)[480]), 787444);
  assert.equal(round(savingsPath(300, 360, 7)[360]), 365991);
});

test("paying the minimum on $5,000 at 22% APR", () => {
  const min = payoff(5000, 22, (bal, due) => Math.max(due + bal * 0.01, 25));
  assert.equal(min.months, 230);
  assert.equal(round(min.interest, -2), 8100);
  const fixed = payoff(5000, 22, () => 200);
  assert.equal(fixed.months, 34);
  assert.throws(() => payoff(5000, 22, () => 50), /never pays/);
});

test("number check accepts rounded facts and rejects invented numbers", () => {
  const facts = [421453, 787444, 365991, 300, 7, 25, 35, 40, 19.2];
  const years = new Set([1970, 2026]);
  const ok = "Start at 25 or 35, $300 a month, 7%. After 40 years: $787K vs $365,991. The gap is $421,000. That's 19 years.";
  assert.deepEqual(unverifiedNumbers(ok, facts, years), []);
  assert.deepEqual(unverifiedNumbers("The gap is $500,000, up 9% since 1969.", facts, years), ["$500,000", "9%", "1969"]);
  assert.deepEqual(unverifiedNumbers("In 1970 three of 10 people", facts, years), []);
  assert.deepEqual(unverifiedNumbers("FRED APU0000708111 and MEHOINUSA646N", facts, years), []);
});

test("character timestamps become word captions", () => {
  const chars = [..."Hi there"];
  const caps = charsToCaptions(chars, chars.map((_, i) => i / 10), chars.map((_, i) => (i + 1) / 10));
  assert.deepEqual(caps.map((c) => [c.text, c.startMs, c.endMs]), [["Hi", 0, 200], [" there", 300, 800]]);
});
