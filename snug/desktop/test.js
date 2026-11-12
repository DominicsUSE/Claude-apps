// Drives the real desktop app: first-run setup, hosting Snug inside the app,
// creating an account, sending a message, and finding it all still there
// after closing and reopening.
//   node build.js --files-only && node --test test.js      (on Linux: under xvfb-run -a)
//   SNUG_BIN=<packaged app> node --test test.js           (test a packaged build)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-"));
const shots = process.env.SNUG_SHOTS;
const launch = async (userData = dir) => {
  // SNUG_BIN points at a packaged build; without it the app runs from source.
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  const app = await electron.launch({
    executablePath: bin || require("electron"),
    args: [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${userData}`],
    cwd: __dirname,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  return { app, page };
};
test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

test("first run: choose to run Snug on this computer, create an account, send a message", async (t) => {
  const { app, page } = await launch();
  t.after(() => app.close().catch(() => {}));
  await page.waitForSelector("#setup");
  assert.equal(await page.locator("h1").textContent(), "Where should Snug run?");
  if (shots) await page.screenshot({ path: path.join(shots, "desktop-setup.png") });
  await page.click("#go");

  await page.waitForSelector(".auth-form");
  assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(await page.evaluate(() => typeof window.snugDesktop), "undefined", "the Snug page gets no desktop bridge");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.click('.auth-link:has-text("Create an account")');
  await page.fill("#auth-handle", "ada");
  await page.fill("#auth-name", "Ada Okafor");
  await page.fill("#auth-pass", "a long password");
  await page.click(".auth-form button[type=submit]");
  await page.waitForSelector(".nav");
  await page.waitForFunction(() => window.snug.S.conn.socket === "open");

  await page.click('.rail-add');
  await page.fill("#house-name", "Kiln & Co.");
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.main .bar-title:has-text("Lounge")');
  await page.fill(".main .composer textarea", "First message from the desktop app");
  await page.press(".main .composer textarea", "Enter");
  await page.waitForFunction(() => Object.values(window.snug.S.msgs).flat().some((m) => m.text.startsWith("First message") && !m.state));
  if (shots) await page.screenshot({ path: path.join(shots, "desktop-app.png") });
  assert.ok(fs.existsSync(path.join(dir, "data", "snug.db")), "the database is in the app-data folder");
  await app.close();
});

test("reopening goes straight in, still signed in, with the message still there", async (t) => {
  const { app, page } = await launch();
  t.after(() => app.close().catch(() => {}));
  await page.waitForSelector(".nav");
  // Rooms are in their community's column; open it from the rail unless it is where you were.
  if (!(await page.locator('.rail-house[aria-current="page"]:has-text("Kiln & Co.")').count())) await page.click('.rail-house:has-text("Kiln & Co.")');
  await page.click('.nav .row:has-text("Lounge")');
  await page.locator('.main .msg:has-text("First message from the desktop app")').waitFor();
  assert.equal(await page.locator(".self-name").textContent(), "Ada Okafor");
  await app.close();
});

test("joining an address that does not answer returns to setup with the reason", async (t) => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-join-"));
  const { app, page } = await launch(other);
  t.after(() => app.close().catch(() => {}));
  await page.waitForSelector("#setup");
  await page.click("#pick-join");
  await page.click("#go");
  await page.locator('#error:has-text("Type the address")').waitFor();
  await page.fill("#url", "not a real address !!");
  await page.click("#go");
  await page.locator('#error:has-text("doesn’t look like an address")').waitFor();
  await page.fill("#url", "http://127.0.0.1:9");
  await page.click("#go");
  await page.locator('#error:has-text("Couldn’t reach http://127.0.0.1:9")').waitFor();
  await app.close();
  fs.rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});
