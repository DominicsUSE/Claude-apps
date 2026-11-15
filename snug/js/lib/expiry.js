// Disappearing messages on this device (0.12). The server gives each message
// in a conversation with a timer its expiry time; this device hides it at
// that time even while offline, and drops it from its own copy.
// The server side is server/expiry.js.

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const TTL_CHOICES = [[0, 'Off'], [HOUR, '1 hour'], [DAY, '1 day'], [7 * DAY, '7 days'], [30 * DAY, '30 days']];

export function ttlLabel(ms) {
  return TTL_CHOICES.find(([v]) => v === ms)?.[1] || (ms ? `${Math.round(ms / HOUR)} hours` : 'Off');
}

export const expired = (m, now = Date.now()) => !!m?.expires && m.expires <= now;

// Remove expired messages from the message lists and the search cache, in
// place. Returns how many went and when the next one is due (or null).
export function dropExpired(S, now = Date.now()) {
  let removed = 0, next = null;
  const due = (t) => { if (next === null || t < next) next = t; };
  for (const [conv, list] of Object.entries(S.msgs || {})) {
    if (!list.some((m) => m.expires)) continue;
    const keep = [];
    for (const m of list) {
      if (expired(m, now)) { removed++; continue; }
      if (m.expires) due(m.expires);
      keep.push(m);
    }
    if (keep.length !== list.length) S.msgs[conv] = keep;
  }
  for (const [id, m] of Object.entries(S.cache || {})) {
    if (expired(m, now)) { delete S.cache[id]; removed++; } else if (m?.expires) due(m.expires);
  }
  return { removed, next };
}
