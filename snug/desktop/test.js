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

// Every launched app, so removing a user-data folder can close its apps first: t.after hooks run in the
// order they were added, and Windows can't delete a database the app still has open.
const live = new Set();
const realLaunch = electron.launch.bind(electron);
electron.launch = async (opts) => {
  // sec-desktop D9: an installed app honours SNUG_UPDATE_CHECK / SNUG_UPDATE_URL only with --dev-update,
  // so every launch here passes it (a packaged build under SNUG_BIN would otherwise ask GitHub).
  if (!opts.noDevUpdate) opts = { ...opts, args: [...(opts.args || []), "--dev-update"] };
  const app = await realLaunch(opts);
  const entry = { app, args: (opts.args || []).join(" ") };
  live.add(entry);
  app.on("close", () => live.delete(entry));
  return app;
};
const removeDir = async (p) => {
  await Promise.all([...live].filter((e) => e.args.includes(p)).map((e) => e.app.close().catch(() => {})));
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
};

// These tests cover local-only mode; the P2P test below turns P2P back on with a local registry.
process.env.SNUG_P2P = "off";
// The update check is off too (a packaged build would ask GitHub); the update tests turn it on against a stub.
process.env.SNUG_UPDATE_CHECK = "0";
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

  // setup.html has an .auth-form too: wait for the in-app server's page first.
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
  await page.waitForSelector(".auth-form");
  assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(await page.evaluate(() => typeof window.snugDesktop), "undefined", "the Snug page gets no desktop bridge");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => window.snugApp.builtIn), true, "the in-app server's page is the app's own code");
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
  // View > Streamer mode (snug/js/views/account.js) turns it on and off in the page.
  const clickStreamer = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === "View").submenu.items.find((i) => i.label === "Streamer mode").click());
  await clickStreamer();
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-streamer"));
  await clickStreamer();
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-streamer"));
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
  const step = (s) => process.env.CI && process.stderr.write(`[voice test] ${s}\n`);
  await page.waitForSelector("#setup");
  await page.click("#go");
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
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
  step("join voice");
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
  step("camera on");
  await page.click(".stage .vc.cam");
  step("camera plays");
  await plays("camera");
  // On macOS the app hands screen sharing to the system's own picker (useSystemPicker), which a test
  // can't click and which waits on the Screen Recording permission: the Snug picker below is Windows/Linux.
  if (process.platform === "darwin") {
    t.diagnostic("macOS: screen sharing uses the system picker; picker steps not run");
    await page.click('.stage [aria-label="Leave voice"]');
    return;
  }

  // Cancel shares nothing and says nothing.
  step("open picker");
  let picked = app.waitForEvent("window");
  await page.click(".stage .vc.scr");
  let picker = await picked;
  step("picker has sources");
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
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
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
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
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

// ---------- Push to talk while Snug isn't in front (voice options) ----------
// In a voice room in push-to-talk mode, the page asks the app for a global
// shortcut; each press the system reports opens the microphone, which closes
// again shortly after the presses stop. Leaving voice lets the key go.
test("push to talk: a global key is held only while in voice in push-to-talk mode, and its presses open the microphone", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-ptt-"));
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
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
  await page.waitForSelector(".auth-form");
  await page.click('.auth-link:has-text("Create an account")');
  await page.fill("#auth-handle", "pat");
  await page.fill("#auth-name", "Pat Lee");
  await page.fill("#auth-pass", "a long password");
  await page.click(".auth-form button[type=submit]");
  await page.waitForSelector(".nav");
  await page.click(".rail-add");
  await page.fill("#house-name", "Studio");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector('.main .bar-title:has-text("Lounge")');
  assert.equal(await page.evaluate(() => typeof window.snugApp.setPushToTalk), "function");
  await page.click('.nav .row:has-text("Hangout")');
  await page.click('.stage .btn.primary:has-text("Join voice")');
  await page.locator('.stage [aria-label="Leave voice"]').waitFor();
  assert.equal(await app.evaluate(() => globalThis.snugPushToTalk()), null, "voice activity needs no key");
  await page.click(".stage .vo-opts");
  await page.click('.menu-item:has-text("Push to talk")');
  for (let i = 0; i < 50 && !(await app.evaluate(() => globalThis.snugPushToTalk())); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await app.evaluate(() => globalThis.snugPushToTalk()), "`");
  await page.waitForFunction(() => window.snug.voiceDebug().trackEnabled === false);
  // What the system sends when the key is pressed (and repeated while held).
  const press = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("ptt:press"));
  await press();
  await page.waitForFunction(() => window.snug.voiceDebug().trackEnabled === true);
  for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 200)); await press(); }
  assert.equal(await page.evaluate(() => window.snug.voiceDebug().trackEnabled), true, "repeats keep it open");
  await page.waitForFunction(() => window.snug.voiceDebug().trackEnabled === false, null, { timeout: 5000 });
  // Only plain keys from the fixed list are accepted.
  assert.equal(await page.evaluate(() => window.snugApp.setPushToTalk("CommandOrControl+Q")), false);
  await page.click('.stage [aria-label="Leave voice"]');
  for (let i = 0; i < 50 && (await app.evaluate(() => globalThis.snugPushToTalk())); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await app.evaluate(() => globalThis.snugPushToTalk()), null, "leaving voice lets the key go");
});
// ---------- end push to talk ----------

// ---------- Desktop shell (inbox track) ----------
// The unread number on the icon and a flash for a mention while unfocused,
// the window colour following the theme, desktop settings (open at login,
// minimise to tray), global mute and deafen keys while in voice, snug:// links
// from a second launch, no update strip or update bridge on the Snug page, and
// the window's size and place kept across launches.
const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-shell-"));
test("update during a call: nothing downloads or restarts until the call ends, then it installs by itself", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-update-call-"));
  t.after(() => removeDir(userData));
  upd.badSums = false;
  const { app, page } = await launchUpdate(userData);
  t.after(() => app.close().catch(() => {}));
  const before = upd.hits;
  // The page says it is in a call (as js/desktop.js does when S.call is set). Everything else says "go ahead".
  await page.evaluate(() => window.snugApp.voiceActive(true));
  await app.evaluate(() => { globalThis.snugUpdateQuiet = true; });
  const r = await app.evaluate(() => globalThis.snugCheckUpdate());
  assert.equal(r.version, "9.9.9");
  await new Promise((res) => setTimeout(res, 800));
  assert.equal(upd.hits, before, "the download waits: the call keeps the connection");
  assert.ok(!(await app.evaluate(() => globalThis.snugUpdateLog)).includes("downloading"), "nothing started");
  assert.equal(await app.evaluate(() => globalThis.snugUpdateShown()), false, "the call keeps its window");
  assert.doesNotMatch(page.url(), /update\.html$/);
  assert.equal(await app.evaluate(() => globalThis.snugUpdateInstalled ?? null), null);
  // The call ends: the download, the check and the install follow with nobody pressing anything. That
  // navigation can end the page before the call answers.
  await page.evaluate(() => window.snugApp.voiceActive(false)).catch(() => {});
  await page.waitForURL(/update\.html$/);
  await page.locator('h1:has-text("Updating to Snug 9.9.9")').waitFor();
  await page.waitForSelector('body[data-phase="installed"]', { timeout: 30000 });
  const rec = await app.evaluate(() => globalThis.snugUpdateInstalled);
  assert.equal(rec.kind, "portable");
  fs.rmSync(path.dirname(rec.file), { recursive: true, force: true });
});

// A stand-in for GitHub's releases API and the registry's notices (the mandatory update test below).
// The shell tests point at it too, with the update check off.
const crypto = require("crypto");
const upd = { version: "9.9.9", bytes: crypto.randomBytes(3 * 1048576), badSums: false, min: null, hits: 0 };
const updName = () => `Snug-${upd.version}-portable.exe`;
const updateStub = require("http").createServer((req, res) => {
  const base = `http://127.0.0.1:${updateStub.address().port}`;
  if (req.url === "/latest") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ tag_name: `snug-v${upd.version}`, assets: [
      { name: updName(), size: upd.bytes.length, browser_download_url: `${base}/dl/${updName()}` },
      { name: "SHA256SUMS-windows.txt", size: 100, browser_download_url: `${base}/dl/SHA256SUMS-windows.txt` },
    ] }));
  }
  if (req.url === "/notices") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ min: upd.min, ann: [] })); }
  if (req.url === "/dl/SHA256SUMS-windows.txt") {
    const h = upd.badSums ? "0".repeat(64) : crypto.createHash("sha256").update(upd.bytes).digest("hex");
    res.writeHead(200);
    return res.end(`${h}  ${updName()}\n`);
  }
  if (req.url === `/dl/${updName()}`) {
    upd.hits += 1;
    // Slowly enough that the page shows its progress.
    res.writeHead(200, { "content-length": upd.bytes.length });
    let i = 0;
    const step = 128 * 1024;
    const next = () => { if (i >= upd.bytes.length) return res.end(); res.write(upd.bytes.subarray(i, i + step)); i += step; setTimeout(next, 60); };
    return next();
  }
  res.writeHead(404);
  return res.end();
});
const stubReady = new Promise((r) => updateStub.listen(0, "127.0.0.1", r));
test.after(() => { updateStub.close(); fs.rmSync(shellDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
async function launchShell(extra = []) {
  await stubReady;
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  const app = await electron.launch({
    executablePath: bin || require("electron"),
    args: [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${shellDir}`, "--use-fake-device-for-media-stream", ...extra],
    cwd: __dirname,
    env: { ...process.env, SNUG_UPDATE_URL: `http://127.0.0.1:${updateStub.address().port}/latest` },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  return { app, page };
}
const mainWin = (app, fn, arg) => app.evaluate(({ BrowserWindow }, [src, a]) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith("http"));
  return new Function("w", "a", `return (${src})(w, a);`)(w, a);
}, [fn.toString(), arg]);

test("desktop shell: badge and flash, theme colour, settings, global voice keys, snug:// links, no update strip", async (t) => {
  const WebSocket = require("ws");
  const { spawn } = require("child_process");
  const { app, page } = await launchShell();
  let other = null;
  t.after(async () => { other?.terminate(); await app.close().catch(() => {}); });
  await page.waitForSelector("#setup");
  await page.click("#go");
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
  await page.waitForSelector(".auth-form");
  const origin = new URL(page.url()).origin;
  await page.click('.auth-link:has-text("Create an account")');
  await page.fill("#auth-handle", "nia");
  await page.fill("#auth-name", "Nia Shell");
  await page.fill("#auth-pass", "a long password");
  await page.click(".auth-form button[type=submit]");
  await page.waitForSelector(".nav");
  await page.waitForFunction(() => window.snug.S.conn.socket === "open");
  for (const fn of ["setBadge", "setThemeColor", "getDesktopSettings", "setDesktopSettings", "setVoiceKeys", "voiceActive", "onVoiceToggle", "onSystemIdle", "onDeepLink"]) {
    assert.equal(await page.evaluate((f) => typeof window.snugApp[f], fn), "function", fn);
  }
  await page.click(".rail-add");
  await page.fill("#house-name", "Shell House");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector('.main .bar-title:has-text("Lounge")');
  const lounge = await page.evaluate(() => window.snug.S.ui.view.id);
  await page.click('.rail-house:has-text("Shell House")', { button: "right" });
  await page.click('.menu-item:has-text("Invite people")');
  await page.waitForFunction(() => /\/join\//.test(document.querySelector(".copy-row input")?.value || ""));
  const code = (await page.locator(".copy-row input").first().inputValue()).split("/join/")[1];
  await page.keyboard.press("Escape");

  // A second person mentions Nia while the window isn't focused: the badge count goes up and the window flashes.
  const reg = await fetch(`${origin}/api/register`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ handle: "oto", name: "Oto Second", password: "a long password" }) });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get("set-cookie").split(";")[0];
  other = new WebSocket(`${origin.replace("http", "ws")}/ws`, { headers: { cookie, origin } });
  let seq = 0;
  const acks = new Map();
  await new Promise((resolve, reject) => { other.on("error", reject); other.on("message", (b) => { const m = JSON.parse(b); if (m.t === "hello") resolve(); else if (m.t === "ack") acks.get(m.id)?.(m); }); });
  const op = (name, d) => new Promise((resolve, reject) => { const id = ++seq; acks.set(id, (m) => (m.ok ? resolve(m.d) : reject(new Error(m.error)))); other.send(JSON.stringify({ t: "op", id, op: name, d })); });
  await op("invite.accept", { code });
  await page.click(".rail-home"); // away from the Lounge, so the mention stays unread
  await page.waitForFunction(() => window.snug.desktop.badgeCount() === 0);
  // Another window takes the focus.
  await app.evaluate(({ BrowserWindow }) => { const w = new BrowserWindow({ width: 200, height: 200, show: true }); w.focus(); globalThis.__focusThief = w; });
  await new Promise((r) => setTimeout(r, 300));
  const focused = await mainWin(app, (w) => w.isFocused());
  await op("msg.send", { conv: lounge, id: "m_shelltest0001", text: "@nia the kiln is ready" });
  await page.waitForFunction(() => window.snug.desktop.badgeCount() === 1);
  await app.evaluate(async () => { for (let i = 0; i < 50 && !globalThis.snugBadgeLog.some((b) => b.n === 1); i++) await new Promise((r) => setTimeout(r, 100)); });
  const log = await app.evaluate(() => globalThis.snugBadgeLog);
  assert.deepEqual(log.at(-1), { n: 1, method: process.platform === "win32" ? "overlay" : "count" });
  if (!focused) assert.deepEqual(await app.evaluate(() => globalThis.snugFlashLog), [1], "flashed while not focused");
  else t.diagnostic("this display gave the focus back to Snug; the flash was not checked");
  assert.ok((await app.evaluate(() => globalThis.snugBadgeImage(3))) === 16 * 16 * 4, "the Windows overlay is drawn at run time");
  await app.evaluate(() => globalThis.__focusThief.destroy());
  // The bridge clamps whatever it is given.
  await page.evaluate(() => window.snugApp.setBadge(5000));
  await app.evaluate(async () => { for (let i = 0; i < 20 && globalThis.snugBadgeLog.at(-1).n !== 999; i++) await new Promise((r) => setTimeout(r, 50)); });
  assert.equal((await app.evaluate(() => globalThis.snugBadgeLog.at(-1))).n, 999);
  await page.evaluate(() => window.snugApp.setBadge(1));

  // The window colour follows the theme; anything but #rrggbb is refused.
  assert.equal(await page.evaluate(() => window.snugApp.setThemeColor("#123456")), true);
  assert.equal((await mainWin(app, (w) => w.getBackgroundColor())).toLowerCase(), "#123456");
  for (const bad of ["red", "#12345", "url(x)", "#1234567"]) assert.equal(await page.evaluate((b) => window.snugApp.setThemeColor(b), bad), false, bad);
  assert.equal((await mainWin(app, (w) => w.getBackgroundColor())).toLowerCase(), "#123456");

  // Settings: open at login, minimise to tray; unknown names refused.
  let r = await page.evaluate(() => window.snugApp.setDesktopSettings({ openAtLogin: true, minimizeToTray: true }));
  assert.equal(r.settings.openAtLogin, true);
  assert.equal(await app.evaluate(() => globalThis.snugLoginItem), true);
  // Windows matches the Run entry by path and args, so ask with the args main.js registers.
  const loginItem = () => app.evaluate(({ app: a }) => a.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin);
  const hasLoginItems = process.platform === "win32" || process.platform === "darwin";
  if (hasLoginItems) assert.equal(await loginItem(), true);
  const cfg = JSON.parse(fs.readFileSync(path.join(shellDir, "desktop.json"), "utf8"));
  assert.equal(cfg.openAtLogin, true);
  assert.equal(cfg.minimizeToTray, true);
  assert.equal(cfg.themeColor, "#123456");
  assert.match((await page.evaluate(() => window.snugApp.setDesktopSettings({ evil: true }))).error, /isn’t a desktop setting/);
  await mainWin(app, (w) => w.minimize());
  await new Promise((res) => setTimeout(res, 400));
  // Without a window manager (xvfb) nothing minimises: send the window the event a manager would.
  await mainWin(app, (w) => { if (w.isVisible() && !w.isMinimized()) w.emit("minimize", { preventDefault() {} }); });
  await page.waitForFunction(() => window.snugApp.hidden());
  assert.equal(await mainWin(app, (w) => w.isVisible()), false, "minimising hides it to the tray");
  await mainWin(app, (w) => { w.show(); w.focus(); });
  await page.waitForFunction(() => !window.snugApp.hidden());
  r = await page.evaluate(() => window.snugApp.setDesktopSettings({ openAtLogin: false, minimizeToTray: false }));
  assert.equal(await app.evaluate(() => globalThis.snugLoginItem), false);
  if (hasLoginItems) assert.equal(await loginItem(), false);
  // The Snug menu mirrors them.
  const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === "Snug").submenu.items.map((i) => i.label));
  for (const l of ["Open Snug at login", "Start minimised", "Minimise to the tray"]) assert.ok(labels.includes(l), l);
  assert.ok(!labels.some((l) => /newer Snug/.test(l)), "updates are mandatory: no on/off item");

  // Settings > Desktop app is there in the desktop app.
  await page.click(".self");
  await page.click(".me-pop >> text=Settings");
  await page.click(".layer-nav >> text=Desktop app");
  await page.locator('.layer-body [aria-label="Open Snug when you sign in to your computer"]').waitFor();
  await page.keyboard.press("Escape");

  // Global mute and deafen keys: bad ones refused, good ones held only in voice; a press toggles mute.
  assert.equal((await page.evaluate(() => window.snugApp.setVoiceKeys({ mute: "M" }))).ok, false, "a key needs a modifier");
  assert.equal((await page.evaluate(() => window.snugApp.setVoiceKeys({ mute: "Ctrl+Alt+Shift+M" }))).ok, false, "at most two modifiers");
  assert.equal((await page.evaluate(() => window.snugApp.setVoiceKeys({ mute: "CommandOrControl+C" }))).ok, false, "never a shortcut other apps rely on");
  assert.equal((await page.evaluate(() => window.snugApp.setVoiceKeys({ mute: "Alt+F4" }))).ok, false, "never Alt+F4");
  assert.match((await page.evaluate(() => window.snugApp.setVoiceKeys({ mute: "CommandOrControl+Shift+F9", deafen: "CommandOrControl+Shift+F9" }))).errors.deafen, /different/);
  r = await page.evaluate(() => window.snugApp.setVoiceKeys({ mute: "CommandOrControl+Shift+F9", deafen: "CommandOrControl+Shift+F10" }));
  assert.equal(r.ok, true);
  assert.deepEqual(await app.evaluate(() => globalThis.snugVoiceKeys()), {}, "not held outside voice");
  await page.click('.rail-house:has-text("Shell House")');
  await page.click('.nav .row:has-text("Hangout")');
  await page.click('.stage .btn.primary:has-text("Join voice")');
  await page.locator('.stage [aria-label="Leave voice"]').waitFor();
  await app.evaluate(async () => { for (let i = 0; i < 50 && !globalThis.snugVoiceKeys().mute; i++) await new Promise((res) => setTimeout(res, 100)); });
  assert.deepEqual(await app.evaluate(() => globalThis.snugVoiceKeys()), { mute: "CommandOrControl+Shift+F9", deafen: "CommandOrControl+Shift+F10" });
  const muted = await page.evaluate(() => !!window.snug.S.call.muted);
  await mainWin(app, (w) => w.webContents.send("voice:toggle", "mute"));
  await page.waitForFunction((m) => !!window.snug.S.call.muted !== m, muted);
  await mainWin(app, (w) => w.webContents.send("voice:toggle", "deafen"));
  await page.waitForFunction(() => window.snug.S.call.deaf === true);
  await page.click('.stage [aria-label="Leave voice"]');
  await app.evaluate(async () => { for (let i = 0; i < 50 && globalThis.snugVoiceKeys().mute; i++) await new Promise((res) => setTimeout(res, 100)); });
  assert.deepEqual(await app.evaluate(() => globalThis.snugVoiceKeys()), {}, "leaving voice lets them go");

  // The computer going idle reports Away (auto-idle on the server).
  await app.evaluate(() => globalThis.snugTellIdle("locked"));
  await page.waitForFunction(() => window.snug.S.users[window.snug.S.me].presence === "away", null, { timeout: 5000 });
  await app.evaluate(() => globalThis.snugTellIdle("unlocked"));
  await page.waitForFunction(() => window.snug.S.users[window.snug.S.me].presence === "around", null, { timeout: 5000 });

  // snug:// links: a second launch with a join link shows the join preview; a malformed one does nothing.
  const linksBefore = (await app.evaluate(() => globalThis.snugLinks)).length;
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  const second = (link) => new Promise((res) => spawn(bin || require("electron"), [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${shellDir}`, link], { cwd: __dirname, stdio: "ignore" }).on("exit", res));
  assert.equal(await second("snug://join/../../etc/passwd"), 0);
  await new Promise((res) => setTimeout(res, 500));
  assert.equal((await app.evaluate(() => globalThis.snugLinks)).length, linksBefore, "a malformed link goes nowhere");
  assert.equal(await page.locator(".modal").count(), 0);
  assert.equal(await second(`snug://join/${code}`), 0);
  await page.locator(".modal").waitFor();
  assert.match(await page.locator(".modal").textContent(), /Shell House/);
  assert.equal((await app.evaluate(() => globalThis.snugLinks)).at(-1), `snug://join/${code}`);
  assert.equal(await app.evaluate(() => globalThis.snugParseLink("snug://open/r_abc/m_def")), "snug://open/r_abc/m_def");
  assert.equal(await app.evaluate(() => globalThis.snugParseLink("snug://open/a/b/c")), null);
  await page.keyboard.press("Escape");

  // Updates are mandatory (the test below): the Snug page has no strip, no update bridge, no setting.
  assert.equal(await page.evaluate(() => typeof window.snugUpdate), "undefined");
  assert.equal(await page.evaluate(() => typeof window.snugApp.openUpdate), "undefined");
  assert.equal(await page.locator(".update-strip").count(), 0);
  assert.match((await page.evaluate(() => window.snugApp.setDesktopSettings({ updateCheck: false }))).error, /isn’t a desktop setting/);

  // Leave a known size and place for the next test.
  await mainWin(app, (w) => { w.unmaximize(); w.setBounds({ x: 60, y: 40, width: 900, height: 700 }); });
  await new Promise((res) => setTimeout(res, 900));
});

test("desktop shell: the window opens where it was; a place off every screen falls back to the centre", async (t) => {
  let { app, page } = await launchShell();
  const first = app;
  t.after(() => first.close().catch(() => {})); // even if a check below fails, so the data folder can be removed
  await page.waitForSelector(".nav");
  const b = await mainWin(app, (w) => w.getBounds());
  // macOS shrinks a window that would run past the bottom of a small screen (CI runners): then it fills the room left.
  const area0 = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const roomH = Math.min(700, area0.y + area0.height - b.y);
  assert.equal(b.width, 900, "width kept");
  assert.ok(b.height === 700 || (process.platform === "darwin" && Math.abs(b.height - roomH) <= 2), `height kept (${b.height}, room ${roomH})`);
  assert.ok(Math.abs(b.x - 60) <= 40 && Math.abs(b.y - 40) <= 60, `place kept (${b.x}, ${b.y})`);
  assert.equal(await app.evaluate(() => globalThis.snugPlaceRestored), true);
  await app.close();
  // A screen that is gone: the saved place is far off.
  const file = path.join(shellDir, "desktop.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, bounds: { x: -9000, y: -9000, width: 900, height: 700 }, maximized: false, themeColor: "#123456" }));
  ({ app, page } = await launchShell());
  t.after(() => app.close().catch(() => {}));
  await page.waitForSelector(".nav");
  assert.equal(await app.evaluate(() => globalThis.snugPlaceRestored), false);
  const c = await mainWin(app, (w) => w.getBounds());
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  assert.ok(c.x >= area.x - 1 && c.y >= area.y - 1 && c.x < area.x + area.width && c.y < area.y + area.height, `back on screen (${c.x}, ${c.y})`);
  // The theme colour from last time is the window's colour from the start (the page then sets its own).
  assert.equal(await app.evaluate(() => globalThis.snugStartColor), "#123456");
  for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(file, "utf8")).themeColor === "#123456"; i++) await new Promise((r) => setTimeout(r, 100));
  const now = JSON.parse(fs.readFileSync(file, "utf8")).themeColor;
  assert.match(now, /^#[0-9a-fA-F]{6}$/, "the page told the app its theme colour");
});

test("p2p: the in-app server uses the registry through net.fetch, the OS key store wraps the device key, and the resume cookie is set", async (t) => {
  const { pathToFileURL } = require("url");
  const { startLocalRegistry } = await import(pathToFileURL(path.join(__dirname, "..", "registry", "dev.js")).href);
  const reg = await startLocalRegistry();
  t.after(() => reg.close());
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-p2p-"));
  t.after(() => removeDir(userData));
  fs.writeFileSync(path.join(userData, "desktop.json"), JSON.stringify({ mode: "host" }));
  const env = { SNUG_REGISTRY_URL: reg.url, SNUG_GITHUB_CLIENT_ID: reg.github.clientId, SNUG_GITHUB_URL: reg.github.url };
  Object.assign(process.env, env);
  delete process.env.SNUG_P2P;
  // A packaged build honours the registry variables only with --dev-registry (S20).
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  let app;
  try {
    app = await electron.launch({
      executablePath: bin || require("electron"),
      args: [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${userData}`, "--dev-registry"],
      cwd: __dirname,
    });
  } finally { for (const k of Object.keys(env)) delete process.env[k]; process.env.SNUG_P2P = "off"; }
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  t.after(() => app.close().catch(() => {}));
  // v0.12: with a registry, the first screen is "Create my account" (no GitHub needed; js/views/keyauth.js).
  // GitHub is under "I already have an account"; password accounts are one link away.
  assert.equal((await page.locator("#auth-create").textContent()).trim(), "Create my account");
  await page.waitForSelector("#auth-use-password");
  await page.click("#auth-have");
  await page.click("#auth-github-path");
  assert.equal((await page.locator("#auth-github").textContent()).trim(), "Continue with GitHub");
  const token = reg.github.issueToken({ id: 4242 });
  const r = await app.evaluate(async ({ safeStorage }, token) => {
    const peer = globalThis.snugHostForTest().peer;
    const auth = await peer.reg.authGithub(token); // goes out through Electron's net.fetch
    const { account } = await peer.reg.claim(auth.ticket, "desk_user");
    const available = safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
    return { enabled: peer.enabled, status: auth.status, username: account.username, protectedKey: peer.identity.protected, available };
  }, token);
  assert.equal(r.enabled, true);
  assert.equal(r.status, "new");
  assert.equal(r.username, "desk_user");
  const file = JSON.parse(fs.readFileSync(path.join(userData, "data", "identity.json"), "utf8"));
  assert.equal(file.enc, r.available ? "safeStorage" : "none", "wrapped exactly when the OS key store works");
  assert.equal(r.protectedKey, file.enc === "safeStorage");
  if (process.platform === "win32") assert.equal(file.enc, "safeStorage", "Windows always has DPAPI");
  assert.doesNotMatch(fs.readFileSync(path.join(userData, "data", "identity.json"), "utf8"), /PRIVATE KEY/);
  const [resume] = await app.evaluate(({ session }) => session.defaultSession.cookies.get({ name: "snug_resume" }));
  assert.ok(resume && resume.httpOnly, "the per-launch resume cookie is set, httpOnly");
});

test("p2p: Create my account works in the app: the proof of work runs in a worker thread, the recovery key is wrapped like the device key", async (t) => {
  const { pathToFileURL } = require("url");
  const { startLocalRegistry } = await import(pathToFileURL(path.join(__dirname, "..", "registry", "dev.js")).href);
  const reg = await startLocalRegistry();
  t.after(() => reg.close());
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-key-"));
  t.after(() => removeDir(userData));
  fs.writeFileSync(path.join(userData, "desktop.json"), JSON.stringify({ mode: "host" }));
  const env = { SNUG_REGISTRY_URL: reg.url, SNUG_GITHUB_CLIENT_ID: reg.github.clientId, SNUG_GITHUB_URL: reg.github.url };
  Object.assign(process.env, env);
  delete process.env.SNUG_P2P;
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  let app;
  try {
    app = await electron.launch({
      executablePath: bin || require("electron"),
      args: [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${userData}`, "--dev-registry"],
      cwd: __dirname,
    });
  } finally { for (const k of Object.keys(env)) delete process.env[k]; process.env.SNUG_P2P = "off"; }
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  t.after(() => app.close().catch(() => {}));
  await page.click("#auth-create");
  await page.fill("#auth-username", "desk_key");
  await page.locator("#auth-username-ok").waitFor();
  await page.click(".auth-form button[type=submit]");
  await page.locator("#rk-key").waitFor();
  const code = (await page.locator("#rk-key > span").allTextContents()).join("-");
  assert.match(code, /^([A-Z2-7]{4}-){8}[A-Z2-7]{4}$/);
  const file = JSON.parse(fs.readFileSync(path.join(userData, "data", "recovery.json"), "utf8"));
  const id = JSON.parse(fs.readFileSync(path.join(userData, "data", "identity.json"), "utf8"));
  assert.equal(file.enc, id.enc, "the recovery secret is wrapped exactly like the device key");
  await page.fill("#rk-last", code.slice(-4));
  await page.click("#rk-saved");
  await page.waitForFunction(() => window.snug?.S?.auth === "in" && window.snug.S.p2p?.kind === "key", null, { timeout: 30000 });
  assert.ok(!fs.existsSync(path.join(userData, "data", "recovery.json")), "gone once saved");
});

// ---------- Automatic updates (desktop/updater.js, update.html) ----------
// Against the stand-in above, as a portable app with a dry install. Nobody presses anything: Snug downloads
// the new version while it stays in use, checks it, and installs it at a quiet moment (the test says when:
// SNUG_UPDATE_QUIET=0 at start, globalThis.snugUpdateQuiet after). A download left from an earlier run is
// used again. A bad checksum installs nothing and is tried again later. Only the registry's minimum version
// puts the update page in the way before the install.
// The app's own check (3 s after start) stays out of the way unless a test asks for it (auto): the tests call
// the check themselves, so nothing depends on how long a start takes.
async function launchUpdate(userData, { auto = false } = {}) {
  await stubReady;
  fs.writeFileSync(path.join(userData, "desktop.json"), JSON.stringify({ mode: "host" }));
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  const env = { ...process.env, SNUG_UPDATE_URL: `http://127.0.0.1:${updateStub.address().port}/latest`, SNUG_NOTICES_URL: `http://127.0.0.1:${updateStub.address().port}/notices`, SNUG_UPDATE_KIND: "portable", SNUG_UPDATE_DRY_INSTALL: "1", SNUG_UPDATE_QUIET: auto ? "1" : "0", SNUG_UPDATE_CHECK: "manual" };
  if (auto) delete env.SNUG_UPDATE_CHECK;
  const app = await electron.launch({ executablePath: bin || require("electron"), args: [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${userData}`], cwd: __dirname, env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForSelector(".auth-form");
  return { app, page };
}
const updatePhase = (app) => app.evaluate(() => globalThis.snugUpdateState().phase);
async function untilPhase(app, want, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const p = await updatePhase(app);
    if (p === want) return;
    if (Date.now() > end) throw new Error(`update phase is ${p}, not ${want}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("automatic update: downloads while Snug stays in use, installs by itself at a quiet moment, reuses a finished download; a bad checksum installs nothing", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-update-"));
  t.after(() => removeDir(userData));
  upd.badSums = false;
  let { app, page } = await launchUpdate(userData);
  const first = app;
  t.after(() => first.close().catch(() => {}));
  const origin = new URL(page.url()).origin;
  assert.equal(await page.evaluate(() => typeof window.snugUpdate), "undefined", "no update bridge on the Snug page");

  // The check (3 s after start, every hour; called here at once) finds 9.9.9: it downloads behind Snug.
  const r = await app.evaluate(() => globalThis.snugCheckUpdate());
  assert.equal(r.version, "9.9.9");
  await untilPhase(app, "waiting");
  assert.equal(await app.evaluate(() => globalThis.snugUpdateShown()), false, "Snug stays in use while it downloads");
  assert.doesNotMatch(page.url(), /update\.html$/);
  assert.ok(await page.locator(".auth-form").isVisible());
  assert.equal(await page.evaluate(() => typeof window.snugUpdate), "undefined");
  assert.equal((await fetch(`${origin}/`)).status, 200);
  let log = await app.evaluate(() => globalThis.snugUpdateLog);
  for (const p of ["downloading", "verifying", "verified", "waiting"]) assert.ok(log.includes(p), `phase ${p} (${log.join(", ")})`);
  // Not a quiet moment: it waits, however often the check runs.
  await app.evaluate(() => globalThis.snugCheckUpdate());
  assert.equal(await updatePhase(app), "waiting");
  assert.equal(await app.evaluate(() => globalThis.snugUpdateInstalled ?? null), null, "nothing installed while Snug is in use");
  // A quiet moment during a call is still not one.
  await page.evaluate(() => window.snugApp.voiceActive(true));
  await app.evaluate(() => { globalThis.snugUpdateQuiet = true; return globalThis.snugCheckUpdate(); });
  assert.equal(await updatePhase(app), "waiting");
  assert.equal(await app.evaluate(() => globalThis.snugUpdateInstalled ?? null), null, "never during a call");
  // The call ends, but this computer is moving a data file, or someone who joined over the network is in a
  // call on its server: still not.
  await app.evaluate(() => { const h = globalThis.snugHostForTest(); h.realVaultBusy = h.vaultBusy; h.vaultBusy = () => true; });
  await page.evaluate(() => window.snugApp.voiceActive(false));
  await app.evaluate(() => globalThis.snugCheckUpdate());
  assert.equal(await updatePhase(app), "waiting");
  await app.evaluate(() => { const h = globalThis.snugHostForTest(); h.vaultBusy = h.realVaultBusy; h.realVoiceBusy = h.voiceBusy; h.voiceBusy = () => true; });
  assert.equal(await app.evaluate(() => globalThis.snugHostForTest().vaultBusy()), false, "the real answer: nothing is moving");
  await app.evaluate(() => globalThis.snugCheckUpdate());
  assert.equal(await updatePhase(app), "waiting");
  assert.equal(await app.evaluate(() => globalThis.snugUpdateInstalled ?? null), null, "never during a transfer or a guest's call");
  await app.evaluate(() => { const h = globalThis.snugHostForTest(); h.voiceBusy = h.realVoiceBusy; });
  assert.equal(await app.evaluate(() => globalThis.snugHostForTest().voiceBusy()), false, "the real answer: nobody is in voice");
  // Nothing is in the way now, and the window waits in the tray: it installs by itself, and the window shows
  // the update page meanwhile.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await app.evaluate(() => globalThis.snugCheckUpdate());
  await page.waitForURL(/update\.html$/);
  await page.locator('h1:has-text("Updating to Snug 9.9.9")').waitFor();
  await page.waitForSelector('body[data-phase="installed"]', { timeout: 30000 });
  assert.match(await page.locator("#lead").textContent(), /Snug updates itself/);
  assert.ok(await page.locator("#go").isHidden(), "nothing to press");
  assert.equal(await page.evaluate(() => typeof window.snugApp), "undefined", "the update page gets only its own bridge");
  assert.equal(await page.evaluate(() => typeof window.snugDesktop), "undefined");
  assert.equal(await page.evaluate(() => typeof window.snugUpdate.start), "function");
  assert.equal((await fetch(`${origin}/`)).status, 200, "the in-app server keeps running");
  log = await app.evaluate(() => globalThis.snugUpdateLog);
  assert.ok(log.indexOf("verified") < log.indexOf("installing"), "installed only after the checksum matched");
  const rec = await app.evaluate(() => globalThis.snugUpdateInstalled);
  assert.equal(rec.kind, "portable");
  assert.match(rec.file, /snug-update-9\.9\.9[\\/]Snug-9\.9\.9-portable\.exe$/);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(rec.file)).digest("hex"), crypto.createHash("sha256").update(upd.bytes).digest("hex"));
  assert.match(rec.script, /copy \/Y/);
  // How the window was is written down for the next start.
  const note = JSON.parse(fs.readFileSync(path.join(userData, "update-relaunch.json"), "utf8"));
  assert.equal(note.mode, "hidden", "it was in the tray");
  await app.close();

  // Snug was closed before it could install: at the next start the finished download is checked and used,
  // not fetched again. The note says the window was hidden, so it comes back hidden (or minimised, with no tray).
  fs.writeFileSync(path.join(userData, "update-relaunch.json"), JSON.stringify({ mode: "hidden", at: Date.now() }));
  const hits = upd.hits;
  ({ app, page } = await launchUpdate(userData));
  const second = app;
  t.after(() => second.close().catch(() => {}));
  assert.equal(await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return !w.isVisible() || w.isMinimized(); }), true, "back the way it was: hidden");
  assert.equal(fs.existsSync(path.join(userData, "update-relaunch.json")), false, "the note is read once");
  await app.evaluate(() => { globalThis.snugUpdateQuiet = true; return globalThis.snugCheckUpdate(); });
  await untilPhase(app, "installed");
  assert.equal(upd.hits, hits, "the download from last time was used");
  assert.equal((await app.evaluate(() => globalThis.snugUpdateInstalled)).file, rec.file);
  fs.rmSync(path.dirname(rec.file), { recursive: true, force: true });
  await app.close();

  // A release whose checksum doesn't match: nothing is installed, nothing is in the way, and the next check
  // tries again.
  upd.version = "9.9.10";
  upd.badSums = true;
  ({ app, page } = await launchUpdate(userData));
  t.after(() => app.close().catch(() => {}));
  await app.evaluate(() => { globalThis.snugUpdateQuiet = true; return globalThis.snugCheckUpdate(); });
  await untilPhase(app, "error");
  assert.equal(await app.evaluate(() => globalThis.snugUpdateShown()), false, "a failed download never gets in the way");
  assert.equal(await app.evaluate(() => globalThis.snugUpdateInstalled ?? null), null, "nothing installed");
  const temp = await app.evaluate(({ app: a }) => a.getPath("temp"));
  const dir = path.join(temp, "snug-update-9.9.10");
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], "the bad download is gone");
  assert.ok(!(await app.evaluate(() => globalThis.snugUpdateLog)).includes("verified"));
  // The release gets fixed; the next check installs it.
  upd.badSums = false;
  await app.evaluate(() => globalThis.snugCheckUpdate());
  await page.waitForURL(/update\.html$/);
  await page.waitForSelector('body[data-phase="installed"]', { timeout: 30000 });
  assert.equal((await app.evaluate(() => globalThis.snugUpdateInstalled)).kind, "portable");
  fs.rmSync(dir, { recursive: true, force: true });
  upd.version = "9.9.9";
});

test("automatic update: a version below the registry's minimum shows the update page at once, and it downloads and installs by itself", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-update-min-"));
  t.after(() => removeDir(userData));
  upd.badSums = true;
  upd.min = "9.9.9";
  t.after(() => { upd.min = null; upd.badSums = false; });
  const { app, page } = await launchUpdate(userData);
  t.after(() => app.close().catch(() => {}));
  // Not a quiet moment (SNUG_UPDATE_QUIET=0), and still: this version may not be used.
  await app.evaluate(() => globalThis.snugCheckUpdate());
  await page.waitForURL(/update\.html$/);
  await page.locator('h1:has-text("Updating to Snug 9.9.9")').waitFor();
  // The release's checksum doesn't match: the page says so and offers its one button. Nothing is installed.
  await page.waitForSelector('body[data-phase="error"]', { timeout: 30000 });
  assert.match(await page.locator("#error").textContent(), /didn’t match its checksum/);
  assert.equal(await page.locator("#go").textContent(), "Try again");
  assert.ok(await page.locator("#go").isVisible());
  assert.equal(await app.evaluate(() => globalThis.snugUpdateInstalled ?? null), null, "nothing installed");
  // The release gets fixed: Try again (the next check would do the same by itself).
  upd.badSums = false;
  await page.click("#go");
  await page.waitForSelector('body[data-phase="downloading"]');
  assert.match(await page.locator("#status").textContent(), /of 3\.0 MB/);
  assert.ok(await page.locator("#go").isHidden(), "nothing to press");
  await page.waitForSelector('body[data-phase="installed"]', { timeout: 30000 });
  const log = await app.evaluate(() => globalThis.snugUpdateLog);
  for (const p of ["downloading", "verifying", "verified", "installing", "installed"]) assert.ok(log.includes(p), `phase ${p} (${log.join(", ")})`);
  const rec = await app.evaluate(() => globalThis.snugUpdateInstalled);
  assert.equal(rec.kind, "portable");
  fs.rmSync(path.dirname(rec.file), { recursive: true, force: true });
});

test("automatic update: the app's own check, a few seconds after starting, does all of it with nobody asking", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-update-auto-"));
  t.after(() => removeDir(userData));
  upd.badSums = false;
  const { app, page } = await launchUpdate(userData, { auto: true });
  t.after(() => app.close().catch(() => {}));
  await page.waitForURL(/update\.html$/, { timeout: 60000 });
  await page.waitForSelector('body[data-phase="installed"]', { timeout: 30000 });
  const rec = await app.evaluate(() => globalThis.snugUpdateInstalled);
  assert.equal(rec.kind, "portable");
  fs.rmSync(path.dirname(rec.file), { recursive: true, force: true });
});

// ---------- sec-desktop: join mode against a stand-in server, the in-app server's switches, fuses ----------
const http = require("http");
function stubSite(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
  const ready = new Promise((r) => srv.listen(0, "127.0.0.1", r)).then(() => `http://127.0.0.1:${srv.address().port}`);
  return { srv, hits, ready };
}
async function launchWith(userData, { config, env = {}, args = [] } = {}) {
  if (config) fs.writeFileSync(path.join(userData, "desktop.json"), JSON.stringify(config));
  const bin = process.env.SNUG_BIN && path.resolve(process.env.SNUG_BIN);
  const app = await electron.launch({
    executablePath: bin || require("electron"),
    args: [...(bin ? [] : [__dirname]), "--no-sandbox", `--user-data-dir=${userData}`, ...args],
    cwd: __dirname,
    env: { ...process.env, ...env },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  return { app, page };
}

test("join mode: a server redirect to another site never takes over the window (will-redirect); the microphone asks first", async (t) => {
  const other = stubSite((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>elsewhere</title>elsewhere"); });
  const otherBase = await other.ready;
  const join = stubSite((req, res) => {
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ version: "0.12.0", proto: 12, minClient: 12, e2ee: 1 })); }
    // Pinned, only /api/ reaches the host (other paths load the app's own page, as on a real Snug server).
    if (req.url === "/api/go") { res.writeHead(302, { location: `${otherBase}/landed` }); return res.end(); }
    if (req.url === "/api/file") { res.writeHead(302, { location: "file:///etc/hostname" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>stand-in Snug</title><p>a Snug someone else runs</p>");
  });
  const joinBase = await join.ready;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-join-"));
  t.after(async () => { other.srv.close(); join.srv.close(); await removeDir(userData); });
  const { app, page } = await launchWith(userData, { config: { mode: "join", url: joinBase }, args: ["--use-fake-device-for-media-stream"] });
  await page.waitForURL(`${joinBase}/`);
  // Pinned (the stand-in answers /api/version): the window shows the app's own page, in the join partition,
  // and the guards and permission handlers below hold there too. (The stand-in has no API, so the page stops early.)
  await page.waitForSelector('link[href="/css/tokens.css"]', { state: "attached" });
  assert.ok(!join.hits.includes("/"), "the host's page was never loaded");
  await app.evaluate(({ shell, dialog }) => {
    globalThis.testOpened = [];
    shell.openExternal = async (u) => { globalThis.testOpened.push(u); };
    globalThis.testAsked = [];
    globalThis.testAnswer = 1; // "Don't allow"
    dialog.showMessageBox = async (_w, o) => { globalThis.testAsked.push(o.message); return { response: globalThis.testAnswer }; };
  });

  // D1: /api/go answers 302 to another origin. will-navigate only sees /api/go (same origin); will-redirect stops the rest.
  await page.evaluate(() => { location.href = "/api/go"; });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(new URL(page.url()).origin, joinBase, "still the Snug address");
  assert.ok(!other.hits.includes("/landed"), "the other site was never loaded in the window");
  assert.deepEqual(await app.evaluate(() => globalThis.testOpened), [`${otherBase}/landed`], "it opens in the browser instead");

  // D6: the remote page asks for the microphone: the person is asked; "Don't allow" refuses it.
  const mic = () => page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((x) => x.stop()); return "ok"; }, (e) => e.name));
  assert.equal(await mic(), "NotAllowedError");
  assert.deepEqual(await app.evaluate(() => globalThis.testAsked), ["Let this Snug use your microphone?"]);
  // "Allow microphone": granted, and not asked again this run.
  await app.evaluate(() => { globalThis.testAnswer = 0; });
  assert.equal(await mic(), "ok");
  assert.equal(await mic(), "ok");
  assert.equal((await app.evaluate(() => globalThis.testAsked)).length, 2, "asked once more, then remembered");
  // The camera still asks on its own.
  const cam = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((x) => x.stop()); return "ok"; }, (e) => e.name));
  assert.equal(cam, "ok");
  assert.equal((await app.evaluate(() => globalThis.testAsked)).at(-1), "Let this Snug use your camera?");
  // A redirect into the file loader: never followed (an error page at most), never handed to the browser.
  await page.evaluate(() => { location.href = "/api/file"; });
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!page.url().startsWith("file:"), page.url());
  assert.equal((await app.evaluate(() => globalThis.testOpened)).length, 1);
  await app.close();
});

test("join mode, pinned: a script or worker the host serves under /api/ never runs in the page (review M6, second pass)", async (t) => {
  const dests = {};
  const join = stubSite((req, res) => {
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ version: "0.12.0", proto: 12, minClient: 12, e2ee: 1 })); }
    dests[req.url] = req.headers["sec-fetch-dest"] || "(none)";
    if (req.url.startsWith("/api/evil")) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("self.pwned = 1; try { postMessage('ran'); } catch {}"); }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  });
  const joinBase = await join.ready;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-api-js-"));
  t.after(async () => { join.srv.close(); await removeDir(userData); });
  const { app, page } = await launchWith(userData, { config: { mode: "join", url: joinBase } });
  await page.waitForURL(`${joinBase}/`);
  await page.waitForSelector('link[href="/css/tokens.css"]', { state: "attached" });
  const got = await page.evaluate(async () => {
    const script = await new Promise((r) => { const s = document.createElement("script"); s.src = "/api/evil.js"; s.onload = () => r("loaded"); s.onerror = () => r("blocked"); document.head.append(s); });
    const mod = await import("/api/evil-module.js").then(() => "loaded", () => "blocked");
    const worker = await new Promise((r) => { try { const w = new Worker("/api/evil-worker.js"); w.onmessage = () => r("ran"); w.onerror = () => r("blocked"); setTimeout(() => r("silent"), 2000); } catch { r("blocked"); } });
    await fetch("/api/data").catch(() => {});
    return { script, mod, worker, pwned: self.pwned === 1 };
  });
  assert.deepEqual(got, { script: "blocked", mod: "blocked", worker: "blocked", pwned: false });
  for (const u of ["/api/evil.js", "/api/evil-module.js", "/api/evil-worker.js"]) assert.equal(join.hits.includes(u), false, `${u} was requested from the host`);
  // What the protocol handler passes on as Sec-Fetch-Dest for a page fetch (reported, for the record).
  t.diagnostic(`Sec-Fetch-Dest the host saw for fetch("/api/data"): ${dests["/api/data"]}`);
  await app.close();
});

// ---------- Join mode, pinned (desktop/pinned.js) ----------
// A Snug someone else runs, behind a small front that records every request and would hand out a changed
// /js/app.js (the "host's code"). The window must run the app's own copy at the host's address instead,
// with the host's cookies, socket, uploads and redirects all working, in its own session.
const NO_PROXY_ENV = Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"].map((k) => [k, ""]));
async function realHost({ hosts = [] } = {}) {
  const { startServer } = await import(require("url").pathToFileURL(path.join(__dirname, "..", "server", "index.js")).toString());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-host-"));
  const srv = await startServer({ port: 0, dataDir, quiet: true, hosts, e2ee: true });
  const hits = [];
  const front = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/js/app.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("window.snugHostCode = 'changed by the host';"); }
    if (req.url === "/api/test-302") { res.writeHead(302, { location: "/api/version" }); return res.end(); }
    const up = http.request({ host: "127.0.0.1", port: srv.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => res.destroy());
    req.pipe(up);
    return undefined;
  });
  // The socket upgrade, byte for byte.
  front.on("upgrade", (req, sock, head) => {
    hits.push(`WS ${req.url}`);
    const up = require("net").connect(srv.port, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      sock.pipe(up).pipe(sock);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  return { srv, front, hits, port: front.address().port, close: async () => { front.closeAllConnections?.(); front.close(); await srv.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
// The window showing an address (the window is replaced when it needs another session).
async function windowAt(app, base) {
  for (let i = 0; i < 100; i++) {
    const p = app.windows().find((w) => !w.isClosed() && w.url().startsWith(base));
    if (p) { p.setDefaultTimeout(20000); return p; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no window at ${base}`);
}
async function signUpIn(page, handle) {
  await page.waitForSelector(".auth-form");
  await page.click('.auth-link:has-text("Create an account")');
  await page.fill("#auth-handle", handle);
  await page.fill("#auth-name", handle);
  await page.fill("#auth-pass", "a long password");
  await page.click(".auth-form button[type=submit]");
  await page.waitForFunction(() => window.snug?.S.conn.socket === "open");
}

test("join mode, pinned: the app's own client runs at a plain-http LAN address, with the host's cookies, socket, uploads, redirects and encryption", async (t) => {
  const host = await realHost({ hosts: ["snug.test"] });
  const origin = `http://snug.test:${host.port}`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-pinned-"));
  t.after(async () => { await removeDir(userData); await host.close(); });
  // snug.test stands for a LAN name: plain http that isn't this computer, so not a secure context by itself.
  const { app, page } = await launchWith(userData, { config: { mode: "join", url: origin }, args: ["--host-resolver-rules=MAP snug.test 127.0.0.1"], env: NO_PROXY_ENV });
  await page.waitForURL(`${origin}/`);
  await page.waitForSelector(".auth-form");
  assert.equal(await page.evaluate(() => window.snugHostCode), undefined, "the host's changed app.js never ran");
  assert.deepEqual(host.hits.filter((h) => !h.startsWith("GET /api/") && !h.startsWith("POST /api/") && !h.startsWith("WS ")), [], "the host was never asked for the page or its code");
  assert.ok(host.hits.includes("GET /api/version"), "the versions were checked first");
  // The insecure-origin switch for this one address: WebCrypto is there, so encryption can work.
  assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.subtle?.generateKey, window.snugApp?.builtIn]), [true, "function", true]);

  await signUpIn(page, "lou");
  // The host's session cookie lives in the join partition only.
  const jar = await app.evaluate(async ({ session }, url) => ({
    join: (await session.fromPartition("persist:snug-join").cookies.get({ url })).map((c) => c.name),
    main: (await session.defaultSession.cookies.get({ url })).map((c) => c.name),
  }), origin);
  assert.ok(jar.join.length > 0, "signed in through the partition");
  assert.deepEqual(jar.main, [], "nothing in the default session's jar");
  assert.ok(host.hits.includes("WS /ws"), "the socket went straight to the host");

  // Encryption works in the pinned window, and this device is "Snug app (built-in code)".
  const dialog = page.locator(".modal[role=dialog]");
  await page.click('.rail-btn:has(.sr:text-matches("^Messages"))');
  await page.locator('.e2-invite button:has-text("Turn on")').click(); // offered above the direct messages
  await dialog.locator('h2:has-text("Turn on end-to-end encryption")').waitFor();
  assert.equal(await dialog.locator(':text("Snug’s code comes from this server")').count(), 0, "no browser warning: the code is the app's own");
  await dialog.locator('button:has-text("Turn on")').click();
  await dialog.locator("#e2-recovery-key").waitFor();
  const key = (await dialog.locator("#e2-recovery-key code").allTextContents()).join("-");
  await dialog.locator("#e2-last").fill(key.slice(-4));
  await dialog.locator('button:has-text("I’ve saved it")').click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.snug.e2ee.E2.status === "ready");
  await page.click('.me-row [aria-label="Settings"], .me-panel [aria-label="Settings"]');
  await page.click('.layer-nav .row:has-text("Encryption")');
  await page.locator('.layer-col :text("Snug app (built-in code)")').first().waitFor();
  await page.locator('.layer-col :text("isn’t https")').first().waitFor(); // plain http: what crosses the network unencrypted is said
  // A house to post a file in (house rooms aren't encrypted, so a plain upload is right there).
  await page.keyboard.press("Escape");
  await page.click(".rail-add");
  await page.fill("#house-name", "Pinned house");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector('.main .bar-title:has-text("Lounge")');
  const room = host.srv.db.get("SELECT id FROM rooms WHERE name = 'Lounge'").id;
  // An upload through the pass-through, then a Range request for it, then a redirect the page follows itself.
  const r = await page.evaluate(async (conv) => {
    const up = await fetch(`/api/files?conv=${conv}`, { method: "POST", body: new Blob([new Uint8Array(200000).fill(7)], { type: "text/plain" }), headers: { "Content-Type": "text/plain", "X-File-Name": "notes%20one.txt" } });
    const data = await up.json().catch(() => ({}));
    const id = data.id || data.file?.id;
    const part = id ? await fetch(`/api/files/${id}`, { headers: { range: "bytes=0-9" } }) : null;
    const rd = await fetch("/api/test-302");
    return { up: up.status, data, part: part && [part.status, (await part.arrayBuffer()).byteLength], redirected: [rd.redirected, new URL(rd.url).pathname, (await rd.json()).proto] };
  }, room);
  assert.equal(r.up, 201, JSON.stringify(r.data));
  assert.deepEqual(r.part, [206, 10]);
  assert.deepEqual(r.redirected, [true, "/api/version", 12]);
  assert.ok(host.hits.some((h) => h.startsWith("POST /api/files")), "the upload reached the host");

  await app.close();
});

test("join mode, pinned: without the switch a plain-http LAN address is no secure context (why main.js sets it)", async (t) => {
  // The same address joined from the server's own page (default session, no switch for it): no WebCrypto.
  const host = await realHost({ hosts: ["snug.test"] });
  const origin = `http://snug.test:${host.port}`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-pinned-off-"));
  t.after(async () => { await removeDir(userData); await host.close(); });
  // The switch is only ever for the configured join address: here the configured one is another.
  const { app } = await launchWith(userData, { config: { mode: "join", url: "http://127.0.0.1:9" }, args: ["--host-resolver-rules=MAP snug.test 127.0.0.1"], env: NO_PROXY_ENV });
  const secure = await app.evaluate(async ({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await w.loadURL(url);
    const v = await w.webContents.executeJavaScript("isSecureContext");
    w.destroy();
    return v;
  }, `${origin}/`);
  assert.equal(secure, false);
  await app.close();
});

test("join mode, fallback: an older server gets a local page, never its code silently; its own page opens in the default session with a label", async (t) => {
  let version = { version: "0.12.0", proto: 12, minClient: 12, e2ee: 1 };
  const host = stubSite((req, res) => {
    if (req.url === "/api/version") {
      if (!version) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(version));
    }
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>Old Snug</title><p id=old>the server's own page</p>");
  });
  const base = await host.ready;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-fallback-"));
  t.after(async () => { host.srv.close(); await removeDir(userData); });

  // First a 0.12 server: the pinned client runs and keeps something in IndexedDB for this address.
  let { app, page } = await launchWith(userData, { config: { mode: "join", url: base } });
  await page.waitForSelector('link[href="/css/tokens.css"]', { state: "attached" });
  await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open("pinned-only"); r.onsuccess = () => { r.result.close(); resolve(); }; }));
  await app.close();

  // Then the server goes back to 0.11 (no /api/version): the fallback page, saying why.
  version = null;
  ({ app, page } = await launchWith(userData, { config: { mode: "join", url: base } }));
  await page.waitForSelector("#fallback");
  assert.ok(page.url().startsWith("file:"), page.url());
  const host0 = new URL(base).host;
  assert.equal(await page.locator("#lead").textContent(), `${host0} runs an older Snug (0.11 or earlier); this app has ${await app.evaluate(({ app: a }) => a.getVersion())}. The app runs its own built-in code, which needs a newer server.`);
  assert.match(await page.locator("#own-note").textContent(), /runs code from/);
  assert.ok(!host.hits.includes("/"), "nothing of the server's page was loaded");
  // "Check for an app update": nothing to find when running from source; it says so.
  await page.click("#update");
  await page.locator('#status:has-text("No newer Snug app")').waitFor();
  // "Open the server's own page": a new window on the default session, labelled, with a one-time note.
  await app.evaluate(({ dialog }) => { globalThis.testNotes = []; dialog.showMessageBox = async (_w, o) => { globalThis.testNotes.push(o.message); return { response: 0 }; }; });
  await page.click("#own");
  const own = await windowAt(app, base);
  await own.waitForSelector("#old");
  await own.waitForFunction(() => document.title === "Old Snug");
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => w.getTitle())[0]), "Old Snug — server’s own page");
  assert.deepEqual(await app.evaluate(() => globalThis.testNotes), [`This window runs code from ${host0}. Encrypted conversations here depend on trusting it.`]);
  assert.equal(await app.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()).webContents.session === session.defaultSession), true);
  // A separate store: the server's own code can't see what the pinned client kept for this address.
  assert.deepEqual(await own.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)), []);
  assert.equal(await own.evaluate(() => typeof window.snugApp?.builtIn), "boolean");
  assert.equal(await own.evaluate(() => window.snugApp.builtIn), false, "the server's own code is not the app's");
  await app.close();

  // The choice is remembered for this server and version: next time it opens straight away, with no new note.
  ({ app } = await launchWith(userData, { config: undefined }));
  await (await windowAt(app, base)).waitForSelector("#old");
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()).getTitle()), "Old Snug — server’s own page");
  await app.close();
});

test("in-app server: ambient SNUG_* variables change nothing, and a foreign Host gets 421 (DNS rebinding), LAN mode included", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-hosts-"));
  t.after(() => removeDir(userData));
  // What same-user malware could plant in the environment.
  const planted = { SNUG_HOSTS: "rebind.attacker.example", SNUG_ORIGINS: "http://rebind.attacker.example:47821", SNUG_TRUST_PROXY: "1", SNUG_SECURE: "1", SNUG_E2EE: "off" };
  const { app, page } = await launchWith(userData, { config: { mode: "host", lan: true }, env: planted });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
  await page.waitForSelector(".auth-form");
  const port = new URL(page.url()).port;
  const ask = (host, extra = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ handle: "planted", name: "Planted", password: "a long password" });
    const req = http.request({ host: "127.0.0.1", port, path: "/api/register", method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extra } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, cookie: res.headers["set-cookie"] }));
    });
    req.on("error", reject);
    req.end(body);
  });
  // Encryption stays offered whatever the environment says (the in-app server sets it itself).
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/version")).json()).e2ee), 1);
  const foreign = await ask(`rebind.attacker.example:${port}`);
  assert.equal(foreign.status, 421, "a name this server doesn't answer to");
  assert.equal(foreign.cookie, undefined);
  // The real address still works, and the cookie isn't marked Secure by a planted SNUG_SECURE (it is plain http).
  const real = await ask(`127.0.0.1:${port}`);
  assert.equal(real.status, 201);
  assert.doesNotMatch(String(real.cookie), /;\s*Secure/i);
  await app.close();
});

test("fuses: the packaged app can't be run as plain Node (ELECTRON_RUN_AS_NODE)", { skip: !process.env.SNUG_BIN && "only for a packaged build (SNUG_BIN)" }, async () => {
  const { spawn } = require("child_process");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-fuse-"));
  const marker = path.join(userData, "ran-as-node.txt");
  const child = spawn(path.resolve(process.env.SNUG_BIN), ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`, "--no-sandbox", `--user-data-dir=${userData}`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore",
  });
  // As Node it would write the file and exit at once; with RunAsNode off it starts Snug instead, which we stop.
  await new Promise((r) => { const timer = setTimeout(r, 8000); child.on("exit", () => { clearTimeout(timer); r(); }); });
  try { child.kill(); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 500));
  const ran = fs.existsSync(marker);
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(ran, false);
});

test("an installed app ignores planted updater variables without --dev-update (SNUG_UPDATE_URL)", { skip: !process.env.SNUG_BIN && "only for a packaged build (SNUG_BIN)" }, async (t) => {
  const planted = stubSite((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  const base = await planted.ready;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-noupd-"));
  fs.writeFileSync(path.join(userData, "desktop.json"), JSON.stringify({ mode: "host" }));
  t.after(async () => { planted.srv.close(); await removeDir(userData); });
  const app = await electron.launch({
    executablePath: path.resolve(process.env.SNUG_BIN), args: ["--no-sandbox", `--user-data-dir=${userData}`], cwd: __dirname, noDevUpdate: true,
    env: (({ SNUG_UPDATE_CHECK, ...rest }) => ({ ...rest, SNUG_UPDATE_URL: `${base}/latest`, SNUG_NOTICES_URL: `${base}/notices`, SNUG_UPDATE_KIND: "portable" }))(process.env),
  });
  // This launch asks the real GitHub: whatever it finds there is never installed on the test machine.
  await app.evaluate(() => { globalThis.snugUpdateQuiet = false; });
  const page = await app.firstWindow();
  await page.waitForSelector(".auth-form", { timeout: 20000 });
  // The check asks GitHub, never the planted address (SNUG_UPDATE_CHECK=0 is ignored the same way: updater.test.js).
  await app.evaluate(() => globalThis.snugCheckUpdate());
  assert.deepEqual(planted.hits, []);
  await app.close();
});
