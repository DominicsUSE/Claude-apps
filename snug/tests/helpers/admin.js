// v0.10 admin, bans and notices across PCs: small helpers on top of tests/helpers/p2p.js.
import { until } from './p2p.js';

/** Wait until a PC's registry socket is connected (ready). */
export const signalUp = (srv, ms = 8000) => until(() => srv.peer._signal.connected, ms, 'registry socket ready');

/** An admin call straight from a PC's registry client, bypassing the op (tests only: lets a test claim any app version). */
export const regAdmin = (srv, payload) => srv.peer.reg.signedCall('/v1/admin', 'admin', payload);

/** The uid of a PC's signed-in account. */
export const uidOfPc = (srv) => srv.peer.identity.self().uid;

/** Resolve after ms, then return whether the PC's registry socket is still down. */
export const staysDown = async (srv, ms = 2500) => {
  await new Promise((r) => setTimeout(r, ms));
  return !srv.peer._signal.connected;
};
