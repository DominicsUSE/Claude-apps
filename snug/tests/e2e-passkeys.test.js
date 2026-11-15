// v0.12 sign-in without email: passkeys (Chromium's virtual authenticator over CDP) and the
// recovery key for a forgotten password, driven against the real server with seeded data.
// The same server is opened as http://localhost:<port> (passkeys work there) and as
// http://127.0.0.1:<port> (an IP address: passkeys can't, and the page says why).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-passkeys-'));
let srv, browser, LOCAL, IP;
const errors = [];

test.before(async () => {
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  LOCAL = `http://localhost:${srv.port}`;
  IP = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); await srv.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function page(base, { phone = false } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await p.goto(base);
  await p.waitForSelector('.auth-form');
  return p;
}
async function signIn(p, handle, password = PASSWORD) {
  await p.fill('#auth-handle', handle);
  await p.fill('#auth-pass', password);
  await p.click('.auth-form button[type=submit]');
  await p.waitForSelector('.nav, .tabs');
}
async function signOut(p) {
  await p.evaluate(() => fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  await p.reload();
  await p.waitForSelector('.auth-form');
}
async function accountSettings(p) {
  await p.click('.me-row [aria-label="Settings"]');
  await p.click('.layer-nav .row:has-text("Account")');
  await p.locator('.layer-body h1:has-text("Account and security")').waitFor();
}
async function authenticator(p) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { cdp, authenticatorId };
}
const keyText = async (p) => (await p.locator('#rk-key span').allTextContents()).join('-');
const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('passkeys: add one in Settings, sign out, then sign in with it from the username field and with the button (no password, no code)', async () => {
  const p = await page(LOCAL);
  const { cdp, authenticatorId } = await authenticator(p);
  assert.equal(await p.getAttribute('#auth-handle', 'autocomplete'), 'username webauthn', 'the username field offers passkeys too');
  await signIn(p, 'robin');
  await accountSettings(p);
  await p.click('#pk-add');
  await p.fill('#pk-pw', PASSWORD);
  await p.fill('#pk-name', 'Test laptop');
  await p.click('#pk-go');
  await p.locator('#pk-list .pk-name:has-text("Test laptop")').waitFor();
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true, 'a discoverable passkey: no username needed');
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM passkeys p JOIN users u ON u.id = p.user WHERE u.handle = 'robin'").n, 1);
  await p.keyboard.press('Escape');
  const passkeyLogins = () => srv.db.get("SELECT COUNT(*) n FROM auth_events e JOIN users u ON u.id = e.user WHERE u.handle = 'robin' AND e.event = 'login' AND e.why = 'passkey' AND e.ok = 1").n;
  // The username field's autofill (conditional mediation): the virtual authenticator answers it at once,
  // as a person picking their passkey from the list would.
  await signOut(p);
  await p.waitForSelector('.nav');
  assert.equal(passkeyLogins(), 1, 'signed in from the autofill');
  // The button: the authenticator waits (no autofill answer) until it is pressed.
  const presence = (enabled) => cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled });
  await presence(false);
  await signOut(p);
  await p.locator('#auth-passkey').waitFor();
  await presence(true);
  await p.click('#auth-passkey');
  await p.waitForSelector('.nav');
  assert.equal(await p.evaluate(() => window.snug.S.users[window.snug.S.me].handle), 'robin');
  assert.equal(passkeyLogins(), 2, 'and with the button');
  // Remove it (password again); then the passkey no longer signs in.
  await accountSettings(p);
  await p.click('#pk-list button:has-text("Remove")');
  await p.fill('#pk-pw', PASSWORD);
  await p.click('#pk-rm-go');
  await p.locator('#pk-list').waitFor({ state: 'detached' });
  await p.keyboard.press('Escape');
  await presence(false);
  await signOut(p);
  await presence(true);
  assert.equal(srv.db.get("SELECT COUNT(*) n FROM passkeys p JOIN users u ON u.id = p.user WHERE u.handle = 'robin'").n, 0);
  // Settings also told the browser the passkey is gone (signalUnknownCredential), so it stops offering it.
  assert.equal((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length, 0);
  await p.click('#auth-passkey');
  await p.locator('#auth-passkey-err').waitFor();
  assert.match(await p.textContent('#auth-passkey-err'), /wasn’t used|isn’t set up/);
  await p.context().close();
});

test('passkeys: a browser with no passkey for the site shows the button and no error from the background offer', async () => {
  const p = await page(LOCAL);
  await p.locator('#auth-passkey').waitFor();
  await p.waitForTimeout(800); // the username field's autofill request has started (or failed) by now
  assert.equal(await p.locator('#auth-passkey-err').count(), 0);
  await p.context().close();
});

test('passkeys: opened by IP address, no passkey button, and Settings says why', async () => {
  const p = await page(IP);
  await signIn(p, 'ines');
  await accountSettings(p);
  await p.locator('.set-row:has-text("Sign in with a passkey")').waitFor();
  assert.match(await p.textContent('.set-row:has-text("Sign in with a passkey")'), /HTTPS with a domain name/);
  assert.equal(await p.locator('#pk-add').count(), 0, 'nothing to press that can’t work');
  await p.keyboard.press('Escape');
  await signOut(p);
  await p.waitForTimeout(300); // the config answer has come back by now
  assert.equal(await p.locator('#auth-passkey').count(), 0);
  await p.context().close();
});

test('recovery key: made from Home after sign-up, then "Forgot your password?" sets a new one; the key works once', async () => {
  const p = await page(IP);
  await p.click('.auth-link:has-text("Create an account")');
  await p.fill('#auth-handle', 'rosa');
  await p.fill('#auth-name', 'Rosa Lind');
  await p.fill('#auth-pass', 'a quiet garden path');
  await p.click('.auth-form button[type=submit]');
  await p.waitForSelector('.nav');
  await p.locator('.rk-remind').waitFor();
  await p.click('#rk-remind-go');
  await p.locator('#rk-key').waitFor();
  const key = await keyText(p);
  assert.match(key, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){8}$/);
  // A wrong last group is caught before anything is saved.
  await p.fill('#rk-last', 'ZZZZ' === key.slice(-4) ? 'YYYY' : 'ZZZZ');
  await p.click('#rk-saved');
  await p.locator('#rk-last-err').waitFor();
  await p.fill('#rk-last', key.slice(-4).toLowerCase());
  await p.click('#rk-saved');
  await p.locator('.toast:has-text("recovery key is saved")').waitFor();
  await p.locator('.rk-remind').waitFor({ state: 'detached' });
  await accountSettings(p);
  await p.locator('.set-row:has-text("Saved")').waitFor();
  await p.keyboard.press('Escape');
  await signOut(p);

  // Forgot: username and key; the request carries only a proof derived from the key.
  const bodies = [];
  p.on('request', (r) => { if (r.url().endsWith('/api/recover')) bodies.push(r.postDataJSON()); });
  await p.click('#auth-forgot');
  await p.fill('#rk-handle', 'rosa');
  await p.fill('#rk-key-in', `${key.slice(0, -1)}${key.slice(-1) === 'A' ? 'B' : 'A'}`); // one character wrong
  await p.click('#rk-check');
  await p.locator('#rk-key-err').waitFor(); // the check characters catch it here
  assert.equal(bodies.length, 0, 'a typo never reaches the server');
  await p.fill('#rk-key-in', key.replace(/-/g, ' ').toLowerCase());
  await p.click('#rk-check');
  await p.locator('#rk-new-pass').waitFor();
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['handle', 'proof']);
  assert.ok(!JSON.stringify(bodies[0]).includes(key.replace(/-/g, '').slice(0, 12)), 'the key itself is not sent');
  await p.fill('#rk-new-pass', 'a brand new garden gate');
  await p.click('#rk-set-pass');
  // The old key is used up: a new one is required before going on.
  await p.locator('#rk-recovered').waitFor();
  await p.locator('#rk-key').waitFor();
  const next = await keyText(p);
  assert.notEqual(next, key);
  await p.fill('#rk-last', next.slice(-4));
  await p.click('#rk-saved');
  await p.waitForSelector('.nav');
  await signOut(p);
  await signIn(p, 'rosa', 'a brand new garden gate');
  await signOut(p);
  // The first key is spent.
  await p.click('#auth-forgot');
  await p.fill('#rk-handle', 'rosa');
  await p.fill('#rk-key-in', key);
  await p.click('#rk-check');
  await p.locator('#rk-form-err:has-text("works once")').waitFor();
  await p.context().close();
});

test('phone: the reminder, the key and "Forgot your password?" fit a 390 px screen', async () => {
  const p = await page(IP, { phone: true });
  await signIn(p, 'bex');
  await p.locator('.rk-remind').waitFor();
  assert.ok(await noSideScroll(p), 'Home fits');
  await p.click('#rk-remind-go');
  await p.locator('#rk-key').waitFor();
  const box = await p.locator('#rk-key').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'the key fits');
  await p.keyboard.press('Escape');
  await signOut(p);
  await p.click('#auth-forgot');
  await p.locator('#rk-key-in').waitFor();
  assert.ok(await noSideScroll(p), 'the forgot screen fits');
  await p.context().close();
});
