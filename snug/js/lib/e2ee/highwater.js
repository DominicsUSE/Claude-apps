// What this device has seen of its own account, so the server can't take it
// back (review H1, M3). Pure decisions; js/e2ee/manager.js keeps the values,
// sealed under this device's storage key (js/e2ee/store.js).
//   synced settings (meta): the highest version opened here. Lower is a
//     rollback; gone or unreadable after it was seen is an error, never "empty".
//   own device list: the highest version and its hash. Lower is a rollback;
//     the same version with another hash is a fork.

/** local: { ver } or null (never seen here); server: { ver, blob } from e2ee.meta.get. */
export function metaCheck(local, server) {
  if (!local) return 'take';
  if (!server?.blob || !server.ver) return 'missing';
  if (server.ver < local.ver) return 'rollback';
  return server.ver === local.ver ? 'same' : 'take';
}

/** local: { ver, h } or null; list: a signed list whose signature already checked; h: its hash. */
export function listCheck(local, list, h) {
  if (!local) return 'ok';
  if (list.ver < local.ver) return 'rollback';
  if (list.ver === local.ver && local.h && h !== local.h) return 'fork';
  return 'ok';
}
