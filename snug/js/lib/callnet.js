// The network rules of a call, as pure functions so they are tested on their
// own (tests/logic-callnet.test.js) and js/voice.js only applies them:
// - how much each kind of media may send (the room's bitrate, data saver, the
//   size of the mesh, and how far the line has been stepped down),
// - stepping that down and back up from measured loss and round trip,
// - whether a connection should go only through a relay (to hide my IP),
// - telling a brand-new connection's offer from a renegotiation,
// - how long the desktop app's global push-to-talk key waits between presses,
// - what a screen share favours (sharp text or smooth motion),
// - the short security code two people in a call compare out loud.

// Data saver: what it caps, whatever the room or the quality settings say.
export const LOW_DATA = {
  voice: 24_000,                                                  // Opus stays clear at 16-24 kbit/s
  camera: { maxBitrate: 250_000, scaleResolutionDownBy: 2, maxFramerate: 15 },
  screen: { maxBitrate: 600_000, maxFramerate: 10 },
};
// The floors adaptive stepping never goes under, so a bad line still carries something useful.
export const FLOOR = { voice: 16_000, camera: 150_000, screen: 300_000 };
export const MAX_LEVEL = 3;

// The send settings for one connection's voice, camera and screen.
//   roomBps: the room's audio bitrate; screenBps: the screen share's quality ceiling;
//   many: more than 3 others in the mesh; lowData: data saver on;
//   level: 0 (full) to MAX_LEVEL, from adaptStep; cameraWanted: false when
//   that person asked not to receive my camera (their data saver).
export function sendCaps({ roomBps = 64_000, screenBps = 1_200_000, many = false, lowData = false, level = 0, cameraWanted = true } = {}) {
  const lv = Math.max(0, Math.min(MAX_LEVEL, level | 0));
  const half = (n, floor) => Math.max(floor, Math.round(n / 2 ** lv));
  // Voice steps 1-3 bring it to 32, 24 and 16 kbit/s at most.
  const voiceStep = [Infinity, 32_000, 24_000, FLOOR.voice][lv];
  const voice = Math.max(Math.min(FLOOR.voice, roomBps), Math.min(roomBps, voiceStep, lowData ? LOW_DATA.voice : Infinity));
  const camBase = lowData ? LOW_DATA.camera.maxBitrate : many ? 450_000 : 900_000;
  const camera = { maxBitrate: lv ? half(camBase, FLOOR.camera) : camBase, active: cameraWanted !== false };
  if (lowData || lv >= 2) { camera.scaleResolutionDownBy = 2; camera.maxFramerate = 15; }
  const scrBase = lowData ? Math.min(screenBps, LOW_DATA.screen.maxBitrate) : screenBps;
  const screen = { maxBitrate: lv ? half(scrBase, FLOOR.screen) : scrBase };
  if (lowData || lv >= 2) screen.maxFramerate = LOW_DATA.screen.maxFramerate;
  return { voice: { maxBitrate: voice }, camera, screen };
}

// One poll's verdict moves a connection's level: two bad polls in a row step
// down (more loss than 5%, or a round trip over 400 ms), five good ones in a
// row step back up. Anything in between holds.
export const BAD_POLLS = 2;
export const GOOD_POLLS = 5;
export function adaptStep(state = {}, q = {}) {
  const s = { level: state.level || 0, bad: state.bad || 0, good: state.good || 0 };
  const loss = Number.isFinite(q.loss) ? q.loss : null;
  const rtt = Number.isFinite(q.rtt) ? q.rtt : null;
  if (loss == null && rtt == null) return s;
  const bad = (loss != null && loss > 5) || (rtt != null && rtt > 400);
  const good = (loss == null || loss < 1) && (rtt == null || rtt < 250);
  if (bad) {
    s.good = 0;
    s.bad++;
    if (s.bad >= BAD_POLLS) { s.level = Math.min(MAX_LEVEL, s.level + 1); s.bad = 0; }
  } else if (good) {
    s.bad = 0;
    s.good++;
    if (s.good >= GOOD_POLLS) { s.level = Math.max(0, s.level - 1); s.good = 0; }
  } else {
    s.bad = 0;
    s.good = 0;
  }
  return s;
}

// Whether a list of ICE servers has a relay (TURN) in it.
export const hasTurn = (ice) => (ice || []).some((s) => [].concat(s?.urls || []).some((u) => typeof u === 'string' && /^turns?:/i.test(u)));

// Should the connection to one person go only through the relay?
//   mode: the "Hide my IP address" setting: 'others' (default: voice rooms and
//   people who aren't friends), 'all', or 'off'; p2pHide: the PC-to-PC "Hide
//   my IP from friends" switch; room: a house voice room (not a call);
//   friend: that person is my friend.
export function relayWanted({ mode = 'others', p2pHide = false, room = false, friend = false } = {}) {
  if (p2pHide || mode === 'all') return true;
  if (mode === 'off') return false;
  return room || !friend;
}
// Whether the person asked for it outright (rather than by the default):
// then connecting directly when no relay is known would break a promise.
export const relayInsisted = ({ mode = 'others', p2pHide = false } = {}) => !!p2pHide || mode === 'all';

// The session id on an SDP's o= line. A new connection makes a new one; a
// renegotiation (a camera added, an ICE restart) keeps it.
export function sdpSession(sdp) {
  const m = /^o=\S+ (\d+) /m.exec(typeof sdp === 'string' ? sdp : sdp?.sdp || '');
  return m ? m[1] : null;
}

// The desktop app's global push-to-talk key only reports presses (and the
// system's repeats while held). After the first press the microphone waits out
// the system's repeat delay (up to 1.1 s, which covers the longest Windows
// setting); once repeats come, it closes after three missed repeats.
export const PTT_FIRST_WAIT = 1100;
export function pttGlobalWait(gap) {
  if (!Number.isFinite(gap) || gap <= 0 || gap >= PTT_FIRST_WAIT) return PTT_FIRST_WAIT;
  return Math.max(120, Math.min(PTT_FIRST_WAIT, Math.round(gap * 3)));
}

// A screen share of text and slides keeps its resolution when the line is
// tight (fewer frames); one of motion and games keeps its frame rate (fewer pixels).
export function screenPref(hint) {
  return hint === 'motion'
    ? { contentHint: 'motion', degradationPreference: 'maintain-framerate' }
    : { contentHint: 'detail', degradationPreference: 'maintain-resolution' };
}

// ---------- The call's security code ----------
// WebRTC encrypts a call with DTLS-SRTP keys tied to each side's certificate,
// whose fingerprint travels in the SDP, through the Snug server. A server (or
// anyone on the way) that swapped the offers to sit in the middle would have
// to swap the fingerprints too, and then the two people would see different
// codes. Each side hashes the two fingerprints it sees, sorted so both sides
// hash the same thing, and shows 6 digits to read out loud.
export function sdpFingerprint(sdp) {
  const m = /^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/m.exec(typeof sdp === 'string' ? sdp : sdp?.sdp || '');
  return m ? `${m[1].toLowerCase()} ${m[2].toUpperCase()}` : null;
}
export async function callCode(localSdp, remoteSdp) {
  const a = sdpFingerprint(localSdp), b = sdpFingerprint(remoteSdp);
  if (!a || !b || a === b || !globalThis.crypto?.subtle) return null;
  const data = new TextEncoder().encode(`snug-call-code-v1\n${[a, b].sort().join('\n')}`);
  const h = new DataView(await crypto.subtle.digest('SHA-256', data));
  return String(h.getUint32(0) % 1_000_000).padStart(6, '0');
}
