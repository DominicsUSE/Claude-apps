// The owner's local row for a registry account (u_<uid>), shared by GitHub sign-in (ghauth.js) and
// keypair accounts (keyauth.js). Moved here unchanged from ghauth.js in v0.12.
import { HUES } from '../js/lib/util.js';

export function createOwnerRows({ db, M, hub, identity, log = () => {} }) {
  const self = () => identity.self();
  const userRow = (id) => (id ? M.userRow(id) : null);
  // A password account on this PC (local only, never on the registry) doesn't block a Snug username:
  // claiming the name moves that account aside to <name>-old. Friends' and the owner's rows do block.
  const holder = (handle, id) => db.get('SELECT id, remote, pass FROM users WHERE handle = ? AND id != ?', handle, id || '');
  const movable = (h) => !!h && h.remote !== 1 && h.pass !== '!';
  const handleFree = (handle, id) => { const h = holder(handle, id); return !h || movable(h); };
  function clearHandle(handle, id) {
    const h = holder(handle, id);
    if (!movable(h)) return;
    let next;
    for (let n = 1; ; n++) { next = `${handle}-old${n > 1 ? n : ''}`; if (!db.get('SELECT 1 FROM users WHERE handle = ?', next)) break; }
    db.run('UPDATE users SET handle = ? WHERE id = ?', next, h.id);
    hub.userChanged(h.id);
    log('gh', 'moved a local account aside for its username');
  }
  // The owner's local row for a registry account: u_<uid>, created on first sign-in. `reuse`: a row of this
  // PC to keep instead (its account was lost when the registry was reset).
  function ensureOwnerRow(uid, username, reuse = null) {
    const s = self();
    const id = reuse && userRow(reuse) ? reuse : s?.uid === uid && s.user && userRow(s.user) ? s.user : `u_${uid}`;
    clearHandle(username, id);
    if (!userRow(id)) {
      const handle = handleFree(username, id) ? username : `${username}.${uid.slice(0, 4)}`.slice(0, 32);
      const hue = HUES[Math.floor(Math.random() * HUES.length)][0];
      db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES (?, ?, ?, '!', ?, ?)", id, handle, username, hue, Date.now());
    } else if (userRow(id).deleted) {
      // Deleted here without freeing the name (no GitHub check then): signing in again starts the row afresh.
      const handle = handleFree(username, id) ? username : `${username}.${uid.slice(0, 4)}`.slice(0, 32);
      db.run('UPDATE users SET deleted = NULL, deactivated = NULL, handle = ?, name = ?, presence = ? WHERE id = ?', handle, username, 'around', id);
      hub.userChanged(id);
    } else if (userRow(id).deactivated) {
      db.run('UPDATE users SET deactivated = NULL WHERE id = ?', id);
      hub.userChanged(id);
    } else if (reuse) {
      clearHandle(username, id);
      if (handleFree(username, id)) db.run('UPDATE users SET handle = ? WHERE id = ?', username, id);
      hub.userChanged(id);
    }
    return id;
  }
  return { userRow, handleFree, clearHandle, ensureOwnerRow };
}
