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

// ---------- Camera and screen sharing (video agent) ----------
// The desktop app allows the camera for the Snug page, and answers a screen
// share with its own picker of screens and windows. Fake camera and
// microphone, so it runs on machines without them.
test("voice: the camera turns on, and the screen picker shares a screen", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-video-"));
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  const app = await electron.launch({
    executablePath: bin || require("electron"),
    args: [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${userData}`, "--use-fake-device-for-media-stream"],
    cwd: __dirname,
  });
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForSelector("#setup");
  await page.click("#go");
  await page.waitForSelector(".auth-form");
  await page.click('.auth-link:has-text("Create an account")');
  await page.fill("#auth-handle", "vic");
  await page.fill("#auth-name", "Vic Moreau");
  await page.fill("#auth-pass", "a long password");
  await page.click(".auth-form button[type=submit]");
  await page.waitForSelector(".nav");
  await page.click(".rail-add");
  await page.fill("#house-name", "Studio");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector('.main .bar-title:has-text("Lounge")');
  await page.click('.nav .row:has-text("Hangout")');
  await page.click('.stage .btn.primary:has-text("Join voice")');
  await page.locator('.stage [aria-label="Leave voice"]').waitFor();
  // A video in this kind of tile has a picture and its time moves on.
  const plays = async (kind) => {
    const sel = `.vt[data-tile$=":${kind}"] video`;
    await page.waitForFunction((s) => document.querySelector(s)?.videoWidth > 0, sel, { timeout: 30000 });
    const t0 = await page.$eval(sel, (v) => v.currentTime);
    await page.waitForFunction(({ s, t }) => document.querySelector(s)?.currentTime > t, { s: sel, t: t0 }, { timeout: 15000 });
  };

  // A real click in the picker; the app closes the picker as soon as it has
  // the answer, which can land before Playwright finishes the click. That
  // closing is the expected result, so it is waited for and not an error.
  const choose = async (w, sel) => {
    const closed = w.waitForEvent("close");
    await w.click(sel).catch((e) => { if (!w.isClosed()) throw e; });
    await closed;
  };
  await page.click(".stage .vc.cam");
  await plays("camera");

  // Cancel shares nothing and says nothing.
  let picked = app.waitForEvent("window");
  await page.click(".stage .vc.scr");
  let picker = await picked;
  await picker.waitForSelector("button[data-i]", { timeout: 30000 });
  assert.equal(await picker.title(), "Share your screen");
  assert.equal(await picker.evaluate(() => typeof window.snugDesktop), "undefined", "the picker gets no desktop bridge");
  await choose(picker, ".cancel");
  await page.waitForFunction(() => !window.snug.S.call.screenBusy);
  assert.equal(await page.locator(".stage .vc.scr").getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator(".toast").count(), 0);

  picked = app.waitForEvent("window");
  await page.click(".stage .vc.scr");
  picker = await picked;
  await picker.waitForSelector("button[data-i]", { timeout: 30000 });
  await choose(picker, 'button[data-i="0"]');
  await page.locator('.stage .vc.scr[aria-pressed="true"]').waitFor();
  await plays("screen");
  await page.locator('.vt-main .vt[data-tile$=":screen"]').waitFor();
  await page.click(".stage .vc.scr");
  await page.locator('.vt[data-tile$=":screen"]').waitFor({ state: "detached" });
  await page.click('.stage [aria-label="Leave voice"]');
});

// ---------- Running in the tray (notifications agent) ----------
// Closing the window hides it; the in-app server keeps answering and the page
// keeps its connection, so a message from someone else still notifies (the
// page's Notification API, recorded here). Clicking that notification brings
// the window back on the conversation. A second launch shows the hidden
// window. Quit in the tray menu stops the server and closes the database.
test("tray: closing hides the window, notifications still arrive and open the conversation, tray Quit exits cleanly", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-tray-"));
  const WebSocket = require("ws");
  const { spawn } = require("child_process");
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  const args = [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${userData}`];
  const app = await electron.launch({ executablePath: bin || require("electron"), args, cwd: __dirname });
  let other = null;
  t.after(async () => {
    other?.terminate();
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector("#setup");
  await page.click("#go");
  await page.waitForSelector(".auth-form");
  const origin = new URL(page.url()).origin;
  await page.click('.auth-link:has-text("Create an account")');
  await page.fill("#auth-handle", "kim");
  await page.fill("#auth-name", "Kim Sato");
  await page.fill("#auth-pass", "a long password");
  await page.click(".auth-form button[type=submit]");
  await page.waitForSelector(".nav");
  await page.waitForFunction(() => window.snug.S.conn.socket === "open");
  assert.equal(await page.evaluate(() => typeof window.snugDesktop), "undefined", "the setup bridge stays on the setup page");
  assert.equal(await page.evaluate(() => window.snugApp && window.snugApp.desktop), true);

  // Settings > Notifications: desktop notifications on, and the tray setting (on by default).
  await page.click(".self");
  await page.click(".me-pop >> text=Settings");
  await page.click(".layer-nav >> text=Notifications");
  await page.click('.layer-body [aria-label="Desktop notifications"]');
  await page.locator('.layer-body [aria-label="Desktop notifications"][aria-checked="true"]').waitFor();
  await page.locator('#set-keep-running [role="switch"][aria-checked="true"]').waitFor();
  await page.keyboard.press("Escape");

  // A house, and a second person on this server: Kim invites them by link.
  await page.click(".rail-add");
  await page.fill("#house-name", "Kiln & Co.");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector('.main .bar-title:has-text("Lounge")');
  await page.click('.rail-house:has-text("Kiln & Co.")', { button: "right" });
  await page.click('.menu-item:has-text("Invite people")');
  await page.waitForFunction(() => /\/join\//.test(document.querySelector(".copy-row input")?.value || ""));
  const code = (await page.locator(".copy-row input").first().inputValue()).split("/join/")[1];
  await page.keyboard.press("Escape");
  const reg = await fetch(`${origin}/api/register`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ handle: "lou", name: "Lou Brandt", password: "a long password" }),
  });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get("set-cookie").split(";")[0];
  other = new WebSocket(`${origin.replace("http", "ws")}/ws`, { headers: { cookie, origin } });
  let seq = 0;
  const acks = new Map();
  await new Promise((resolve, reject) => {
    other.on("error", reject);
    other.on("message", (buf) => { const m = JSON.parse(buf); if (m.t === "hello") resolve(); else if (m.t === "ack") acks.get(m.id)?.(m); });
  });
  const op = (name, d) => new Promise((resolve, reject) => {
    const id = ++seq;
    acks.set(id, (m) => (m.ok ? resolve(m.d) : reject(new Error(m.error))));
    other.send(JSON.stringify({ t: "op", id, op: name, d }));
  });
  await op("invite.accept", { code });
  const kimId = await page.evaluate(() => window.snug.S.me);
  const { id: dm } = await op("dm.open", { users: [kimId] });

  // Record the notifications the page makes (and still make them).
  await page.evaluate(() => {
    const N = window.Notification;
    window.__notes = [];
    window.Notification = new Proxy(N, {
      construct(target, a) { const n = Reflect.construct(target, a); window.__notes.push({ title: a[0], body: a[1]?.body, n }); return n; },
      get: (target, k) => Reflect.get(target, k),
    });
  });

  // Close the window: it hides, Snug keeps running, the first close leaves a tip.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForFunction(() => window.snugApp.hidden());
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), gone: w.isDestroyed() }))), [{ visible: false, gone: false }]);
  const cfg = JSON.parse(fs.readFileSync(path.join(userData, "desktop.json"), "utf8"));
  assert.equal(cfg.mode, "host");
  assert.equal(cfg.trayTipShown, true, "the first close explains where Snug went");
  assert.notEqual(cfg.keepRunning, false);
  assert.equal(await app.evaluate(() => !!globalThis.snugTrayMenu), true, "a tray icon with a menu");
  assert.deepEqual(await app.evaluate(() => globalThis.snugTrayMenu.items.filter((i) => i.type !== "separator").map((i) => i.label)), ["Open Snug", "Quit"]);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await fetch(`${origin}/api/me`, { headers: { cookie } })).status, 200, "the server keeps answering");
  assert.equal(await page.evaluate(() => window.snug.S.conn.socket), "open", "the hidden window stays connected");

  // Lou writes; the hidden window notifies.
  await op("msg.send", { conv: dm, id: "m_traytest0001", text: "Kiln’s **cool**, you can unload." });
  await page.waitForFunction(() => window.__notes.length > 0);
  const note = await page.evaluate(() => ({ title: window.__notes[0].title, body: window.__notes[0].body }));
  assert.deepEqual(note, { title: "Lou Brandt", body: "Kiln’s cool, you can unload." });

  // Clicking it shows the window on the conversation.
  await page.evaluate(() => window.__notes[0].n.onclick());
  await page.waitForFunction(() => !window.snugApp.hidden());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await page.locator('.main .msg:has-text("you can unload")').waitFor();

  // Hidden again, a second launch brings the running one back and exits.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForFunction(() => window.snugApp.hidden());
  const second = spawn(bin || require("electron"), args, { cwd: __dirname, stdio: "ignore" });
  const code2 = await new Promise((r) => second.on("exit", r));
  assert.equal(code2, 0, "the second launch exits");
  await page.waitForFunction(() => !window.snugApp.hidden());

  // The setting can be turned off: then closing really closes (checked through the menu state only).
  await page.evaluate(() => window.snugApp.setKeepRunning(false));
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "desktop.json"), "utf8")).keepRunning, false);
  assert.equal(await app.evaluate(() => globalThis.snugTrayMenu), null, "no tray icon while it is off");
  await page.evaluate(() => window.snugApp.setKeepRunning(true));
  assert.equal(await app.evaluate(() => !!globalThis.snugTrayMenu), true);

  // Quit from the tray: the app exits, the server stops, the database closes cleanly.
  const exited = new Promise((r) => app.process().once("exit", r));
  await app.evaluate(() => { setTimeout(() => globalThis.snugTrayMenu.items.find((i) => i.label === "Quit").click(), 0); });
  await exited;
  await assert.rejects(fetch(`${origin}/api/me`), "the server is gone");
  assert.equal(fs.existsSync(path.join(userData, "data", "snug.db-wal")), false, "the database was closed cleanly");
});

// ---------- Calls (calls agent) ----------
// Someone calls while the window is hidden in the tray: the app brings the
// window back, shows a system notification ("Lou Brandt is calling"), and the
// page shows the incoming-call screen. The caller hanging up takes it away.
test("incoming call: the hidden window comes back from the tray with a notification and the incoming-call screen", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-call-"));
  const WebSocket = require("ws");
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  const app = await electron.launch({ executablePath: bin || require("electron"), args: [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${userData}`], cwd: __dirname });
  let other = null;
  t.after(async () => {
    other?.terminate();
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector("#setup");
  await page.click("#go");
  await page.waitForSelector(".auth-form");
  const origin = new URL(page.url()).origin;
  await page.click('.auth-link:has-text("Create an account")');
  await page.fill("#auth-handle", "kim");
  await page.fill("#auth-name", "Kim Sato");
  await page.fill("#auth-pass", "a long password");
  await page.click(".auth-form button[type=submit]");
  await page.waitForSelector(".nav");
  await page.waitForFunction(() => window.snug.S.conn.socket === "open");
  assert.equal(await page.evaluate(() => typeof window.snugApp.incomingCall), "function");

  // A second person on this server, in a house with Kim and a conversation with her.
  await page.click(".rail-add");
  await page.fill("#house-name", "Kiln & Co.");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector('.main .bar-title:has-text("Lounge")');
  const reg = await fetch(`${origin}/api/register`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ handle: "lou", name: "Lou Brandt", password: "a long password" }),
  });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get("set-cookie").split(";")[0];
  other = new WebSocket(`${origin.replace("http", "ws")}/ws`, { headers: { cookie, origin } });
  let seq = 0;
  const acks = new Map();
  await new Promise((resolve, reject) => {
    other.on("error", reject);
    other.on("message", (buf) => { const m = JSON.parse(buf); if (m.t === "hello") resolve(); else if (m.t === "ack") acks.get(m.id)?.(m); });
  });
  const op = (name, d) => new Promise((resolve, reject) => {
    const id = ++seq;
    acks.set(id, (m) => (m.ok ? resolve(m.d) : reject(new Error(m.error))));
    other.send(JSON.stringify({ t: "op", id, op: name, d }));
  });
  const house = await page.evaluate(() => window.snug.S.houseOrder[0]);
  const { code } = await page.evaluate((h) => new Promise((r) => {
    const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "hello") ws.send(JSON.stringify({ t: "op", id: 1, op: "invite.create", d: { house: h } })); if (m.t === "ack") { ws.close(); r(m.d); } };
  }), house);
  await op("invite.accept", { code });
  const kimId = await page.evaluate(() => window.snug.S.me);
  const { id: dm } = await op("dm.open", { users: [kimId] });
  await page.waitForFunction((d) => !!window.snug.S.dms[d], dm);

  // Hide the window in the tray.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForFunction(() => window.snugApp.hidden());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);

  // Lou calls: the window comes back with a notification and the incoming screen.
  await op("call.start", { dm, video: true });
  await page.waitForFunction(() => !window.snugApp.hidden());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, "the window is up again");
  assert.deepEqual(await app.evaluate(() => globalThis.snugCallNotes), [{ title: "Lou Brandt is calling", body: "Video call" }]);
  const notesSupported = await app.evaluate(({ Notification }) => Notification.isSupported());
  assert.equal(await app.evaluate(() => globalThis.snugCallNotesOpen()), notesSupported ? 1 : 0);
  const card = page.locator(".incoming");
  await card.waitFor();
  assert.equal(await card.locator(".inc-name").textContent(), "Lou Brandt");
  if (shots) await page.screenshot({ path: path.join(shots, "desktop-incoming-call.png") });
  // Lou gives up: the screen goes, and Kim's conversation has the missed call.
  await op("voice.leave", {});
  await card.waitFor({ state: "detached" });
  await page.waitForFunction((d) => (window.snug.S.msgs[d] || []).some((m) => m.call?.outcome === "missed"), dm);
  // The ring is over, so its notification is gone too.
  for (let i = 0; i < 50 && await app.evaluate(() => globalThis.snugCallNotesOpen()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await app.evaluate(() => globalThis.snugCallNotesOpen()), 0, "the ring's notification closed");
});
