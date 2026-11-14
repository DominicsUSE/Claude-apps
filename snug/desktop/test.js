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

// These tests cover local-only mode; the P2P test below turns P2P back on with a local registry.
process.env.SNUG_P2P = "off";
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
// from a second launch, the update check against a local stand-in, and the
// window's size and place kept across launches.
const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "snug-desktop-shell-"));
let updateReply = { status: 200, body: { tag_name: "v9.9.9", html_url: "https://github.com/DominicsUSE/Claude-apps/releases/tag/v9.9.9" } };
const updateStub = require("http").createServer((req, res) => {
  if (updateReply.status === 0) { req.socket.destroy(); return; }
  res.writeHead(updateReply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(updateReply.body));
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

test("desktop shell: badge and flash, theme colour, settings, global voice keys, snug:// links, update check", async (t) => {
  const WebSocket = require("ws");
  const { spawn } = require("child_process");
  const { app, page } = await launchShell();
  let other = null;
  t.after(async () => { other?.terminate(); await app.close().catch(() => {}); });
  await page.waitForSelector("#setup");
  await page.click("#go");
  await page.waitForSelector(".auth-form");
  const origin = new URL(page.url()).origin;
  await page.click('.auth-link:has-text("Create an account")');
  await page.fill("#auth-handle", "nia");
  await page.fill("#auth-name", "Nia Shell");
  await page.fill("#auth-pass", "a long password");
  await page.click(".auth-form button[type=submit]");
  await page.waitForSelector(".nav");
  await page.waitForFunction(() => window.snug.S.conn.socket === "open");
  for (const fn of ["setBadge", "setThemeColor", "getDesktopSettings", "setDesktopSettings", "setVoiceKeys", "voiceActive", "onVoiceToggle", "onSystemIdle", "onDeepLink", "onUpdate"]) {
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
  for (const l of ["Open Snug at login", "Start minimised", "Minimise to the tray", "Check for a newer Snug"]) assert.ok(labels.includes(l), l);

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

  // A newer Snug: a strip with its version; the same version, or a failure, says nothing.
  updateReply = { status: 200, body: { tag_name: "v9.9.9", html_url: "https://github.com/DominicsUSE/Claude-apps/releases/tag/v9.9.9" } };
  assert.equal((await app.evaluate(() => globalThis.snugCheckUpdate())).version, "9.9.9");
  await page.locator('.update-strip:has-text("Snug 9.9.9 is out")').waitFor();
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  updateReply = { status: 200, body: { tag_name: `v${version}`, html_url: "https://github.com/x" } };
  assert.equal(await app.evaluate(() => globalThis.snugCheckUpdate()), null, "the same version is not news");
  updateReply = { status: 0 };
  assert.equal(await app.evaluate(() => globalThis.snugCheckUpdate()), null, "a failed check is silent");
  updateReply = { status: 500, body: {} };
  assert.equal(await app.evaluate(() => globalThis.snugCheckUpdate()), null);
  await page.click('.update-strip [aria-label="Dismiss"]');
  await page.locator(".update-strip").waitFor({ state: "detached" });

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
  assert.deepEqual({ w: b.width, h: b.height }, { w: 900, h: 700 }, "size kept");
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
  t.after(() => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
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
  // With a registry, signing in starts with GitHub (js/views/auth.js); password accounts are one link away.
  assert.equal((await page.locator("#auth-github").textContent()).trim(), "Continue with GitHub");
  await page.waitForSelector("#auth-use-password");
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
