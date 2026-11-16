// page.waitForFunction() does not await a predicate that returns a Promise: an
// async predicate's Promise is truthy, so the wait resolves at once and checks
// nothing. waitAsync() polls page.evaluate(), which does await it, until the
// predicate's result is truthy. Use it for every async check.
export async function waitAsync(page, fn, arg, { timeout = 15000, polling = 250 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const ok = await Promise.race([page.evaluate(fn, arg), new Promise((r) => setTimeout(r, 5000, false))]);
    if (ok) return ok;
    if (Date.now() > end) throw new Error(`waitAsync: timed out after ${timeout} ms: ${String(fn).slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, typeof polling === 'number' ? polling : 100));
  }
}
