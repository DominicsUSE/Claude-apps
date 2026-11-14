// Snug global username rules. Pure ESM with no dependencies: the renderer, the
// local server and the registry Worker all import this one file, so the rules
// can never drift apart. The registry is the authority; everyone else uses it
// for instant feedback only.

/** The only one-character names. Claimable only by the owner's GitHub account. */
export const OWNER_NAMES = ['1', 'a'];

export const RESERVED = new Set([
  'admin', 'administrator', 'snug', 'snugapp', 'support', 'system', 'root', 'moderator', 'mod', 'mods',
  'staff', 'official', 'help', 'everyone', 'here', 'null', 'undefined', 'me', 'you', 'owner', 'team',
  'security', 'api', 'www', 'bot', 'anonymous', 'deleted', 'unknown', 'github', 'nobody', 'someone',
  'server', 'status', 'settings',
]);

const NAME_RE = /^[a-z0-9_.]{2,32}$/;
const PUNCT_RE = /^[._]|[._]$|[._]{2}/;

export function normalize(s) {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * Look-alike key: two names with the same skeleton cannot both exist.
 * `.` and `_` vanish, rn->m, vv->w, then 0->o, 1->l, i->l, 3->e, 5->s.
 */
export function skeleton(name) {
  return normalize(name)
    .replace(/[._]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/[01i35]/g, (c) => ({ 0: 'o', 1: 'l', i: 'l', 3: 'e', 5: 's' })[c]);
}

const RESERVED_SKEL = new Set([...RESERVED].map(skeleton));
const PREFIX_SKEL = skeleton('snug');
const CONTAINS_SKEL = ['admin', 'official', 'moderator', 'support', 'staff'].map(skeleton);

/**
 * @returns {null | 'invalid_name' | 'reserved' | 'owner_only'}
 * Never returns 'taken': uniqueness (including skeleton uniqueness) is the registry's job.
 */
export function check(name, { owner = false } = {}) {
  const n = normalize(name);
  if (OWNER_NAMES.includes(n)) return owner ? null : 'owner_only';
  if (!NAME_RE.test(n)) return 'invalid_name';
  if (PUNCT_RE.test(n)) return 'invalid_name';
  const sk = skeleton(n);
  if (RESERVED.has(n) || RESERVED.has(sk) || RESERVED_SKEL.has(sk)) return 'reserved';
  if (sk.startsWith(PREFIX_SKEL)) return 'reserved';
  if (CONTAINS_SKEL.some((w) => sk.includes(w))) return 'reserved';
  return null;
}
