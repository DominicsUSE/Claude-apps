// Playwright's page.waitForFunction treats the promise an async predicate returns as truthy, so it resolves
// at once and checks nothing. waitAsync polls an async predicate in the page until it returns truthy.
export async function waitAsync(page, fn, arg, { timeout = 30_000, polling = 250 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitAsync: not true within ${timeout} ms: ${String(fn).slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, polling));
  }
}
