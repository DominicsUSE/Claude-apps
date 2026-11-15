// Shared helpers for the Hub and its mixins (admin.js, xfer.js, vaultkey.js).
import { fromB64u } from './crypto.js';

export class ApiError extends Error {
  constructor(code, extra) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}
export const fail = (code, extra) => {
  throw new ApiError(code, extra);
};
export const need = (cond) => {
  if (!cond) fail('bad_request');
};

export const UID_RE = /^[a-z2-7]{16}$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RAW_NAME_RE = /^[A-Za-z0-9_.]{1,32}$/;
const SEMVER_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export const isUid = (s) => typeof s === 'string' && UID_RE.test(s);
export const isKey = (s) => typeof s === 'string' && s.length === 43 && fromB64u(s)?.length === 32;
export const isSig = (s) => typeof s === 'string' && s.length === 86 && fromB64u(s)?.length === 64;
export const isTs = (n) => Number.isSafeInteger(n) && n > 0;
export const rawName = (s) => typeof s === 'string' && RAW_NAME_RE.test(s);
export const isUnique = (e) => /UNIQUE/i.test(String(e && e.message));
export const isSemver = (s) => typeof s === 'string' && SEMVER_RE.test(s);

/** Compare "x.y.z" strings; anything malformed sorts lowest. */
export function semverCmp(a, b) {
  const pa = isSemver(a) ? a.split('.').map(Number) : [-1, -1, -1];
  const pb = isSemver(b) ? b.split('.').map(Number) : [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
