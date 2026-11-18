// v0.10 xfer sockets: two device keys of the SAME account (current, pending move, or the key before the
// current one for 30 days) exchange opaque E2E boxes, so the old PC can send its data file to the new one.
// Mixed into Hub.prototype (hub.js). Banned accounts and outdated apps may use it (it is their own data).
// An xfer socket never closes or replaces normal sockets and accepts only `xfer` frames (+ "ping").
import { verifyEd25519 } from './crypto.js';
import { isKey, ID_RE } from './common.js';
import { DAY } from './limits.js';

const OLD_KEY_DAYS = 30 * DAY;
const MAX_XFER_BOX = 65536;
const PER_KEY = 2;

export const XferMixin = {
  async onXferAuth(ws, a, f) {
    const uid = a.uid;
    const acc = this.accountByUid(uid);
    if (!acc) return this.closeWs(ws, 4003, 'revoked');
    const msg = `snug-reg-v1\nsignal-xfer\n${uid}\n${a.n}`;
    const cands = [{ role: 'cur', ik: acc.ik, xk: acc.xk }];
    const p = this.pending(uid);
    if (p) cands.push({ role: 'pending', ik: p.ik, xk: p.xk });
    const old = this.row('SELECT ik, xk FROM keys WHERE uid=? AND kver=?', uid, acc.kver - 1);
    if (old && this.xferRole(acc, old.ik) === 'old') cands.push({ role: 'old', ik: old.ik, xk: old.xk });
    let hit = null;
    for (const c of cands) {
      if (await verifyEd25519(c.ik, f.sig, msg)) {
        hit = c;
        break;
      }
    }
    if (!hit) return this.closeWs(ws, 4001, 'bad auth');
    // --- synchronous from here ---
    if (ws.readyState !== 1 || this.gone.has(ws)) return undefined;
    const cur = this.accountByUid(uid);
    if (!cur) return this.closeWs(ws, 4003, 'revoked');
    const role = this.xferRole(cur, hit.ik);
    if (!role) return this.closeWs(ws, 4001, 'bad auth');
    // sec-registry REG-M1: per key and apart from signaling, so no xfer key can lock another key out.
    if (!this.budgets.take(`${uid}|${hit.ik}`, 'connectX', this.L.connectXfer)) return this.closeWs(ws, 4029, 'rate limited');
    // At most PER_KEY sockets per (uid, ik): a new one pushes out the oldest.
    const same = this.sockets(uid, (x) => x.mode === 'xfer' && x.ik === hit.ik).map((w) => [this.att(w).at, w]).sort((x, y) => x[0] - y[0]);
    while (same.length >= PER_KEY) this.closeWs(same.shift()[1], 4002, 'replaced');
    this.countFrame();
    const att = { uid, authed: true, mode: 'xfer', role, ik: hit.ik, xk: hit.xk, at: this.now() };
    ws.serializeAttachment(att);
    const p2 = this.pending(uid);
    const chain = this.rows('SELECT kver, ik, xk FROM keys WHERE uid=? ORDER BY kver', uid).map((k) => ({ kver: k.kver, ik: k.ik, xk: k.xk }));
    const others = [];
    const seen = new Set([hit.ik]);
    for (const w of this.sockets(uid, (x) => x.mode === 'xfer')) {
      if (w === ws) continue;
      const o = this.att(w);
      this.send(w, { t: 'xfer-peer', ik: att.ik, xk: att.xk, role, on: true });
      if (!seen.has(o.ik)) {
        seen.add(o.ik);
        others.push({ ik: o.ik, xk: o.xk, role: o.role });
      }
    }
    this.send(ws, {
      t: 'ready', mode: 'xfer', role, kver: cur.kver, now: this.now(), ping: Number(this.env.PING_SECONDS) || 90,
      keys: { chain, pending: p2 ? { ik: p2.ik, xk: p2.xk } : null }, others,
    });
    return undefined;
  },

  /** The role key `ik` has for account `acc` right now, or null when it may not use xfer. */
  xferRole(acc, ik) {
    if (acc.ik === ik) return 'cur';
    const p = this.pending(acc.uid);
    if (p && p.ik === ik) return 'pending';
    const old = this.row('SELECT ik FROM keys WHERE uid=? AND kver=?', acc.uid, acc.kver - 1);
    if (old && old.ik === ik && this.now() - acc.key_at <= OLD_KEY_DAYS
      && !this.row('SELECT 1 AS x FROM forced_old WHERE uid=? AND ik=?', acc.uid, ik)) return 'old'; // REG-M2: not a forced-out key
    return null;
  },

  onXfer(ws, a, f, raw) {
    if (f.t !== 'xfer') return undefined;
    const id = typeof f.id === 'string' && ID_RE.test(f.id) ? f.id : null;
    const err = (code) => this.send(ws, { t: 'err', id, code });
    if (!isKey(f.to) || typeof f.box !== 'string') return err('bad_request');
    if (f.box.length > MAX_XFER_BOX || raw.length > MAX_XFER_BOX + 1024) return err('too_big');
    const off = Number(this.env.RELAY_OFF_AT) || 60000;
    if (this.budgets.value('*', 'req20', DAY) > off * 20) return err('unavailable');
    const uid = a.uid;
    if (f.to === a.ik) return err('unavailable');
    // Re-check the sender's key is still allowed (a finished move or a cancel may have changed it).
    const acc = this.accountByUid(uid);
    const myRole = acc && this.xferRole(acc, a.ik);
    if (!myRole) {
      this.closeWs(ws, 4003, 'revoked');
      return undefined;
    }
    const to = this.sockets(uid, (x) => x.mode === 'xfer' && x.ik === f.to);
    if (!to.length) return err('unavailable');
    // The key from before a move (maybe a lost or stolen PC) talks only with the current key: it may hand
    // its data over and hear the replies, but never gets a file from a pending key (security review 0.10 #2).
    const toRole = this.xferRole(acc, f.to);
    if ((myRole === 'old' && toRole !== 'cur') || (toRole === 'old' && myRole !== 'cur')) return err('unavailable');
    if (this.win.hit(`xfer|${uid}`, this.L.xferBurst) || !this.budgets.take(uid, 'xfer', this.L.xferDay)
      || !this.budgets.take(uid, 'xferB', this.L.xferBytesDay, f.box.length)) {
      return err('rate_limited');
    }
    this.countFrame();
    const out = { t: 'xfer', from: a.ik, box: f.box };
    for (const w of to) this.send(w, out);
    return undefined;
  },

  /** An xfer socket closed: the others hear "off" once no socket of that key is left. */
  xferGone(a) {
    const rest = this.sockets(a.uid, (x) => x.mode === 'xfer');
    if (rest.some((w) => this.att(w).ik === a.ik)) return;
    for (const w of rest) this.send(w, { t: 'xfer-peer', ik: a.ik, xk: a.xk, role: a.role, on: false });
  },

  /** A move completed (oldIk -> newIk): xfer sockets stay open, their roles move, everyone hears the new roles. */
  xferRoles(uid, oldIk, newIk) {
    const socks = this.sockets(uid, (x) => x.mode === 'xfer');
    if (!socks.length) return;
    for (const w of socks) {
      const a = this.att(w);
      const role = a.ik === newIk ? 'cur' : a.ik === oldIk ? 'old' : null;
      if (!role) {
        this.closeWs(w, 4003, 'revoked');
        continue;
      }
      if (role !== a.role) {
        a.role = role;
        w.serializeAttachment(a);
      }
    }
    const live = this.sockets(uid, (x) => x.mode === 'xfer');
    for (const w of live) {
      for (const o of live) {
        if (o === w) continue;
        const b = this.att(o);
        if (b.ik !== this.att(w).ik) this.send(w, { t: 'xfer-peer', ik: b.ik, xk: b.xk, role: b.role, on: true });
      }
    }
  },
};
