// Helpers for the data file tests (server-vault*.test.js, e2e-vault.test.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The debounce the vault waits after a change; read when each server starts.
process.env.SNUG_VAULT_DEBOUNCE_MS = process.env.SNUG_VAULT_DEBOUNCE_MS || '200';

// A stand-in for Electron safeStorage: reversible, but visibly not plain base64 of the key.
export function fakeKeyStore() {
  const ks = {
    calls: 0,
    available: () => true,
    encrypt: (s) => { ks.calls++; return `FAKE:${Buffer.from(String(s), 'utf8').reverse().toString('base64')}`; },
    decrypt: (b) => {
      if (typeof b !== 'string' || !b.startsWith('FAKE:')) throw new Error('not mine');
      return Buffer.from(b.slice(5), 'base64').reverse().toString('utf8');
    },
  };
  return ks;
}

export const liveFile = (srv) => srv.vault._paths.liveFile();
export const readLive = (srv) => readFileSync(liveFile(srv));

// Upload a file to POST /api/vault/import as the given client (cookie).
export async function importFile(srv, cookie, buf, type = 'application/octet-stream') {
  const res = await fetch(`${srv.base}/api/vault/import`, {
    method: 'POST', headers: { 'content-type': type, origin: srv.base, cookie }, body: buf,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function download(srv, cookie) {
  const res = await fetch(`${srv.base}/api/vault/file`, { headers: { cookie } });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

// Counts of what an import can add, to show nothing changed.
export function counts(srv) {
  const one = (sql) => srv.db.get(sql).n;
  return {
    users: one('SELECT COUNT(*) n FROM users'), peers: one('SELECT COUNT(*) n FROM peers'),
    friends: one('SELECT COUNT(*) n FROM friends'), dms: one('SELECT COUNT(*) n FROM dms'),
    messages: one('SELECT COUNT(*) n FROM messages'), reactions: one('SELECT COUNT(*) n FROM reactions'),
    blocks: one('SELECT COUNT(*) n FROM blocks'), files: one('SELECT COUNT(*) n FROM files'),
  };
}

export function flip(buf, at, mask = 0x01) {
  const b = Buffer.from(buf);
  b[at] ^= mask;
  return b;
}

export { assert };
