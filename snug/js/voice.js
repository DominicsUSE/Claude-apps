// Voice over WebRTC, for a house's voice rooms and for calls in direct
// conversations and groups alike: both are a "voice place" (S.call.room is a
// room id or a conversation id) with the same membership on the server.
// Audio goes directly between people (a full mesh, up to 12 in a place); the
// Snug server only passes the connection offers, answers and network
// candidates between them, and only between people in the same place.
//
// Whoever joins calls everyone already there; the people already there answer.
// After that, either side may renegotiate (a camera or a screen share added or
// taken away). Offers can then cross, so each pair follows the "perfect
// negotiation" pattern: the person with the larger id is polite and gives way
// when two offers collide, the other one ignores the colliding offer.
//
// Camera and screen go on the same connections as the voice. Each kind of
// media travels in its own stream, and each person tells the others which
// stream id is their microphone, camera and screen, so a tile can show the
// right picture.
import { S, emit, toast, subscribe, convMeta } from './store.js';
import { call, on } from './server.js';
// Devices, input mode, processing, per-person volume, soundboard mixing (js/voiceopts.js).
import {
  getMic, outgoing, swapMic, stopOutgoing, gate, micOpen, tuneAudio, forgetAudio, boostOf, onRetune, cue, vp,
  cameraConstraints, screenConstraints, screenBitrate, roomBitrate, audioCtx, meter, cameraBase,
} from './voiceopts.js';
// Connection quality from WebRTC's statistics (js/lib/netquality.js).
import { summarize, uplinkPoor } from './lib/netquality.js';
// Send caps, adaptive steps, the relay choice, new connection or renegotiation (js/lib/callnet.js).
import {
  sendCaps, adaptStep, hasTurn, relayWanted, relayInsisted, sdpSession, callCode, screenPref,
  relayMode, relayCandidate, relayOnlySdp, sdpFingerprints, sdpUfrag, fpStatement, readFpAttr, withFpAttr, deviceCode,
} from './lib/callnet.js';
// Call keys sealed to each person's devices, and offers and answers signed by this device (calls C1, C2).
import { callKeysReady, e2eeOffered, myDevice, sealCallKey, openCallKey, signFingerprint, parseFpAttr, verifyFingerprint, identityKeys } from './e2ee/callkeys.js';

// user -> { pc, audio, screenAudio, queue, stopLevel, polite, makingOffer,
//           ignoreOffer, settingAnswer, chain, kinds, video, tx, id, relay,
//           adapt, wantCamera, restarts, graceTimer }
const peers = new Map();
const pendingKinds = new Map(); // user -> what their streams are, heard before the connection
const pendingWant = new Map();  // user -> whether they want my camera (their data saver), heard before the connection
let mic = null;
let micLost = false; // both captures failed in restartMic: muted until a microphone works again
let send = null;     // what the others receive for my voice: the processed microphone (js/voiceopts.js)
let cam = null;      // my camera stream, while it is on
let screen = null;   // my screen stream, while I share
// What the others receive: one stream per kind for the whole call, so its id
// (which tells them camera from screen) stays the same when a camera goes off and on.
let out = null;
let ctx = null;
let watching = 0; // level watchers using ctx
let stopMyLevel = null;

const errText = (e) => ({
  NotAllowedError: 'Snug needs your microphone to join. Allow it in your browser’s site settings, then try again.',
  NotFoundError: 'No microphone found. Connect one and try again.',
  NotReadableError: 'Another app is using your microphone. Close it and try again.',
}[e?.name] || 'Couldn’t start your microphone.');
// Joined without a microphone: why, and how to talk later.
const listenText = (e, dm) => {
  const why = e === 'insecure' ? 'This page can’t use a microphone (it needs https)'
    : { NotAllowedError: 'Snug may not use your microphone', NotFoundError: 'No microphone found', NotReadableError: 'Another app is using your microphone' }[e?.name]
    || 'Your microphone didn’t start';
  return `${why}, so you joined ${dm ? 'the call' : 'voice'} to listen. Others can’t hear you. Use the microphone button to talk once it works.`;
};

function setPeerState(user, state) {
  S.peers = { ...S.peers, [user]: state };
  emit();
}

// Who is speaking, from the actual audio level, with a little hold so the ring
// doesn't flicker between words.
function watchLevel(user, stream) {
  try {
    ctx ||= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let quietFor = 0;
    const tick = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      const loud = Math.sqrt(sum / buf.length) > 6 && !(user === S.me && (S.call?.muted || !micOpen()));
      quietFor = loud ? 0 : quietFor + 1;
      const speaking = quietFor < 3;
      if (!!S.speaking[user] !== speaking) {
        S.speaking = { ...S.speaking };
        if (speaking) S.speaking[user] = true; else delete S.speaking[user];
        emit();
      }
    }, 120);
    watching++;
    // With no one left to watch, the context is suspended: a running one keeps the audio thread busy.
    let done = false;
    return () => { if (done) return; done = true; clearInterval(tick); src.disconnect(); if (--watching === 0) ctx.suspend().catch(() => {}); };
  } catch { return () => {}; }
}

function signal(to, data) { call('rtc', { to, data }).catch(() => {}); }

// ---------- End-to-end encryption of the media (calls C1) ----------
// On top of WebRTC's own DTLS-SRTP, every encoded frame of every sender and
// receiver goes through the call's worker (js/callcrypt-worker.js), which
// seals what I send with my key and opens what others send with theirs
// (js/lib/callcrypt.js). Each person's device makes its own key, and a new
// one whenever someone joins or leaves; it goes to each other person sealed
// to their devices (js/e2ee/callkeys.js), and is used for them once they
// acknowledge it. Someone who can't (an older Snug, no encryption keys, a
// browser without encoded transforms) gets the media as before, and the call
// says so. Everything is forgotten when the call ends.
const crypt = { worker: null, mode: null, why: null, key: null, req: 0, waits: new Map(), refused: new Set() };
const ckOf = new Map(); // user -> { acked, keyed, ckSeen, ckDev, unsigned, stripped, recheck, heard, why }
const ckState = (u) => { let x = ckOf.get(u); if (!x) ckOf.set(u, (x = { acked: null, keyed: false, ckSeen: false, ckDev: null, unsigned: false, stripped: false, recheck: null, heard: false, why: null })); return x; };
// Connected this long without a word about call keys from them (no key, no "can't"): an older Snug (0.13 and before).
const CK_WAIT_MS = 10_000;
const transformMode = () => (typeof RTCRtpScriptTransform === 'function' ? 'script'
  : typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.prototype.createEncodedStreams === 'function' ? 'streams' : null);
// Called before joining (so before any connection of the call): whether its
// media can be end-to-end encrypted, and how. The worker must answer first: a
// page whose policy doesn't allow it (or a broken one) would otherwise stop
// every frame, so the call goes on as before and says why.
async function startCrypt() {
  stopCrypt();
  const mode = transformMode();
  crypt.why = !mode ? 'browser' : !e2eeOffered() ? 'off' : !callKeysReady() ? 'keys' : !S.callE2ee ? 'server' : null;
  if (crypt.why) return;
  let worker;
  try {
    worker = new Worker(new URL('./callcrypt-worker.js', import.meta.url), { type: 'module' });
  } catch { crypt.why = 'browser'; return; }
  worker.onmessage = ({ data: m }) => { if (m?.t === 'stats' || m?.t === 'done') { crypt.waits.get(m.req)?.(m.t === 'stats' ? m.stats : !m.failed); crypt.waits.delete(m.req); } };
  const req = ++crypt.req;
  const alive = await new Promise((r) => {
    crypt.waits.set(req, r);
    worker.onerror = () => { crypt.waits.delete(req); r(false); };
    worker.postMessage({ t: 'ping', req });
    setTimeout(() => { if (crypt.waits.delete(req)) r(false); }, 3000);
  });
  if (alive !== true) { worker.terminate(); crypt.why = 'browser'; return; }
  worker.onerror = null;
  crypt.worker = worker;
  crypt.mode = mode;
  newCallKey();
}
function stopCrypt() {
  if (crypt.worker) { try { crypt.worker.postMessage({ t: 'wipe' }); } catch { /* gone */ } crypt.worker.terminate(); }
  crypt.key?.raw.fill(0);
  for (const done of crypt.waits.values()) done({});
  Object.assign(crypt, { worker: null, mode: null, key: null, waits: new Map() });
  ckOf.clear();
}
// A new key of mine: made here, never sent anywhere but sealed to the others' devices.
function newCallKey() {
  if (!crypt.worker) return;
  const id = crypt.key ? (crypt.key.id + 1) & 255 : crypto.getRandomValues(new Uint8Array(1))[0];
  crypt.key?.raw.fill(0);
  crypt.key = { id, raw: crypto.getRandomValues(new Uint8Array(32)) };
  const copy = crypt.key.raw.slice();
  crypt.worker.postMessage({ t: 'send', id, raw: copy.buffer }, [copy.buffer]);
  for (const u of peers.keys()) sendKeyTo(u);
}
function sendKeyTo(user) {
  if (!S.callE2ee) return;
  // A friend on another PC (P2P): their devices aren't on this server, so no keys to seal to.
  if (S.users[user]?.remote) { ckState(user).why = 'p2p'; return; }
  if (!crypt.worker || !crypt.key) { signal(user, { ck: { v: 1, t: 'no', why: crypt.why === 'keys' || crypt.why === 'off' ? 'keys' : 'browser' } }); return; }
  const { id, raw } = crypt.key;
  sealCallKey({ place: S.call.room, to: user, id, raw }).then((m) => {
    if (!m) { const st = ckState(user); st.why ||= 'their-keys'; emit(); return; }
    if (crypt.key?.id === id && peers.has(user)) signal(user, { ck: m });
  }).catch(() => { const st = ckState(user); st.why ||= 'their-keys'; emit(); });
}
function onCallKey(from, m) {
  const st = ckState(from);
  st.heard = true;
  if (m.t === 'no') { st.why = m.why === 'keys' ? 'their-keys' : 'their-browser'; emit(); return; }
  if (m.t === 'ack') { if (crypt.worker && crypt.key) { crypt.worker.postMessage({ t: 'use', peer: from, id: m.id }); st.acked = m.id; } return; }
  if (m.t !== 'key' || !crypt.worker) return;
  const place = S.call.room;
  openCallKey(from, m, place).then(async ({ id, raw }) => {
    if (!crypt.worker || S.call?.room !== place) { raw.fill(0); return; }
    const req = ++crypt.req;
    const installed = new Promise((r) => crypt.waits.set(req, r));
    crypt.worker.postMessage({ t: 'recv', peer: from, id, raw: raw.buffer, req }, [raw.buffer]);
    st.ckSeen = true;
    st.ckDev = m.d;
    // A device that signs its keys signs its offers too (calls C2): an offer from them without it, or signed by another device, was changed on the way.
    const p = peers.get(from);
    if (p?.fp && p.fp.d !== m.d) { refusePeer(from); return undefined; }
    if (st.unsigned) {
      // An offer signed by a device not in their list when it came (they may have just turned encryption
      // on) is checked again now that their list opened this key: it must be this device's signature.
      const list = st.stripped ? [] : st.recheck || [];
      let ok = list.length > 0;
      for (const r of list) ok = ok && r.p === p && r.d === m.d && (await verifyFingerprint(from, r.d, r.stmt, r.sig).catch(() => null)) === true;
      if (!ok || peers.get(from) !== p) { refusePeer(from); return undefined; }
      const r = list.at(-1);
      st.unsigned = false;
      st.recheck = null;
      p.fp = { d: r.d, fingerprint: r.fingerprint, ufrag: r.ufrag };
      if (p.pc.connectionState === 'connected') { p.code = null; readCode(from, p); }
    }
    return installed.then((ok) => {
      if (!ok || !crypt.worker || !peers.has(from)) return;
      st.keyed = true;
      st.why = null;
      // Acknowledged only once the worker holds it: they encrypt to me with it from then on.
      signal(from, { ck: { v: 1, t: 'ack', id } });
    });
  }).catch(() => { st.why = 'their-keys'; emit(); });
}
// Every sender and receiver of a connection goes through the worker, the
// ones a renegotiation adds included: with createEncodedStreams a sender left
// out would send nothing at all.
const piped = new WeakSet();
function attachCrypt(p, user = p.user) {
  if (!crypt.worker || !user) return;
  for (const t of p.pc.getTransceivers()) {
    if (t.stopped || t.currentDirection === 'stopped') continue;
    const kind = t.receiver.track?.kind;
    if (!kind) continue;
    // VP8 first: its header is known, so the rest of each frame can be sealed (js/lib/callcrypt.js clearBytes).
    if (kind === 'video' && !piped.has(t) && t.setCodecPreferences && typeof RTCRtpReceiver?.getCapabilities === 'function') {
      piped.add(t);
      try {
        const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
        const vp8 = codecs.filter((c) => /vp8$/i.test(c.mimeType));
        if (vp8.length) t.setCodecPreferences([...vp8, ...codecs.filter((c) => !/vp8$/i.test(c.mimeType))]);
      } catch { /* the browser picks */ }
    }
    for (const [x, dir] of [[t.sender, 'send'], [t.receiver, 'recv']]) {
      if (piped.has(x)) continue;
      piped.add(x);
      const opts = { dir, peer: user, kind };
      try {
        if (crypt.mode === 'script') x.transform = new RTCRtpScriptTransform(crypt.worker, opts);
        else {
          const { readable, writable } = x.createEncodedStreams();
          crypt.worker.postMessage({ t: 'streams', readable, writable, opts }, [readable, writable]);
        }
      } catch { /* already piped */ }
    }
  }
}
function cryptStats() {
  if (!crypt.worker) return Promise.resolve({});
  const req = ++crypt.req;
  return new Promise((r) => {
    crypt.waits.set(req, r);
    crypt.worker.postMessage({ t: 'stats', req });
    setTimeout(() => { if (crypt.waits.delete(req)) r({}); }, 3000);
  });
}
// Whether the media with one person is end-to-end encrypted, and if not, why.
function e2eeOf(user, p, stats) {
  const st = ckOf.get(user);
  if (crypt.why) return { on: false, why: crypt.why };
  if (st?.why) return { on: false, why: st.why };
  if (!st?.heard && p.upSince && Date.now() - p.upSince > CK_WAIT_MS) return { on: false, why: 'their-app' };
  return { on: !!(stats?.e2ee && st?.keyed && st.acked != null), why: stats?.e2ee ? null : 'waiting' };
}
// The whole call, for the label in it (js/views/activities.js): on only when every connection is.
export function callSecurity() {
  const list = [...peers.entries()].filter(([u]) => !crypt.refused.has(u));
  if (!S.call) return null;
  if (crypt.why) return { on: false, why: crypt.why, who: null };
  if (!list.length) return null; // nobody to talk to: nothing to label
  const off = list.find(([, p]) => !p.e2ee?.on);
  return off ? { on: false, why: off[1].e2ee?.why || 'waiting', who: off[0] } : { on: true, why: null, who: null };
}

// ---------- The connection's certificate, signed (calls C2) ----------
// Every offer and answer I send carries a=x-snug-fp: my device's signature
// over who it's from and for, the call, and its certificate fingerprint and
// ICE username. Each one I receive is checked against the sender's signed
// device list before it is used; one that doesn't match ends that
// connection with a warning, never a quiet fallback.
async function sdpOut(user, desc) {
  let sdp = desc.sdp;
  const p = peers.get(user);
  if (p?.relay) sdp = relayOnlySdp(sdp);
  const fingerprint = sdpFingerprints(sdp), ufrag = sdpUfrag(sdp);
  if (fingerprint && S.call && callKeysReady()) {
    const stmt = fpStatement({ place: S.call.room, fromUser: S.me, fromDevice: myDevice(), toUser: user, fingerprint, ufrag });
    const attr = await signFingerprint(stmt).catch(() => null);
    if (attr) { sdp = withFpAttr(sdp, attr); if (p) p.signed = true; }
  }
  return { type: desc.type, sdp };
}
async function sendSdp(user, desc) { signal(user, { sdp: await sdpOut(user, desc) }); }
// 'ok' to go on, or 'refuse'.
async function checkSdp(from, p, desc) {
  const st = ckState(from);
  const unsigned = (recheck = null) => {
    if (st.ckSeen) return 'refuse';
    st.unsigned = true;
    if (recheck) (st.recheck ||= []).push(recheck);
    else st.stripped = true; // no signature at all: nothing can make up for it
    p.fp = null;
    return 'ok';
  };
  const attr = readFpAttr(desc.sdp);
  if (!attr) return unsigned();
  const a = parseFpAttr(attr);
  const fingerprint = sdpFingerprints(desc.sdp), ufrag = sdpUfrag(desc.sdp);
  if (!a || !fingerprint) return 'refuse';
  // The device that sealed their call key is the one in this call.
  if (st.ckDev && st.ckDev !== a.d) return 'refuse';
  const stmt = fpStatement({ place: S.call.room, fromUser: from, fromDevice: a.d, toUser: S.me, fingerprint, ufrag });
  const ok = await verifyFingerprint(from, a.d, stmt, a.sig).catch(() => null);
  if (ok === false) return 'refuse';
  // A signature from a device they don't have (or no longer have) can't be checked: the same as none,
  // unless their key, when it opens, comes from that device and the signature then checks (onCallKey).
  if (ok !== true) return unsigned({ p, d: a.d, stmt, sig: a.sig, fingerprint, ufrag });
  p.fp = { d: a.d, fingerprint, ufrag };
  return 'ok';
}
export const callAlarm = () => S.callAlarm || null;
function refusePeer(user) {
  if (!S.call || crypt.refused.has(user)) return;
  crypt.refused.add(user);
  dropPeer(user);
  S.callAlarm = { user, room: S.call.room, at: Date.now() };
  toast(`Snug stopped the connection to ${S.users[user]?.name || 'someone'}: the security details that arrived don’t match what their device signed. Someone may be trying to listen in. Don’t continue this call; check with them another way.`);
  emit();
}

// Which of my streams is which. Sent before any track is added, so it reaches
// the other person before the offer that carries the track.
const myKinds = () => ({
  mic: (send || mic)?.id || null,
  camera: cam && out ? out.camera.id : null,
  screen: screen && out ? out.screen.id : null,
  screenAudio: screen && out ? out.screenAudio.id : null,
});
const tellKinds = (user) => signal(user, { kinds: myKinds() });

// What each connection may send (js/lib/callnet.js sendCaps): the room's
// bitrate for the voice, lower ceilings as the mesh grows so twelve cameras
// still fit, data saver, the steps adaptive quality took on this line, and
// whether that person wants my camera at all (their data saver).
const encView = (e, slot) => (slot === 'voice' ? [e.maxBitrate] : [e.maxBitrate, e.scaleResolutionDownBy || 1, e.maxFramerate || null, e.active !== false]);
const voiceSenderOf = (p) => p.pc.getSenders().find((x) => x.track && x.track.kind === 'audio' && send && send.getAudioTracks().includes(x.track));
function capBitrate(p) {
  const v = vp();
  const caps = sendCaps({
    roomBps: roomBitrate(), screenBps: screenBitrate(peers.size > 3), many: peers.size > 3,
    lowData: !!v.lowData, level: p.adapt?.level || 0, cameraWanted: p.wantCamera !== false,
  });
  for (const slot of ['camera', 'screen', 'voice']) {
    const s = slot === 'voice' ? voiceSenderOf(p) : p.tx[slot]?.sender;
    if (!s?.track) continue;
    try {
      const prm = s.getParameters();
      const enc = prm.encodings?.[0];
      if (!enc) continue;
      const want = caps[slot];
      // A screen share of text keeps its resolution when the line is tight; one of motion its frame rate.
      const keep = slot === 'screen' ? screenPref(v.screenHint).degradationPreference : null;
      if (JSON.stringify(encView(enc, slot)) === JSON.stringify(encView(want, slot)) && (!keep || prm.degradationPreference === keep)) continue;
      if (keep) prm.degradationPreference = keep;
      enc.maxBitrate = want.maxBitrate;
      if (slot !== 'voice') {
        // Keys a cap leaves out go back to the browser's choice (data saver off, a step back up).
        enc.scaleResolutionDownBy = want.scaleResolutionDownBy || 1;
        if (want.maxFramerate) enc.maxFramerate = want.maxFramerate; else delete enc.maxFramerate;
        enc.active = want.active !== false;
      }
      s.setParameters(prm).catch(() => {
        // A browser that refuses the preference still gets the caps.
        if (!keep) return;
        try {
          const again = s.getParameters();
          if (!again.encodings?.[0]) return;
          Object.assign(again.encodings[0], enc);
          if (enc.maxFramerate == null) delete again.encodings[0].maxFramerate;
          s.setParameters(again).catch(() => {});
        } catch { /* the browser picks */ }
      });
    } catch { /* not supported here: the browser picks */ }
  }
}
// The mesh crossing 3 others changes everyone's ceilings, not just the newest connection's.
let wasMany = false;
function recapIfMeshChanged() {
  const many = peers.size > 3;
  if (many === wasMany) return;
  wasMany = many;
  for (const p of peers.values()) capBitrate(p);
}

// Start sending a track in one of the slots (camera, screen, screenAudio).
// A slot keeps its transceiver for the life of the connection: turning the
// camera off and on again reuses it instead of adding a new media section each time.
function sendOn(p, slot, track, stream) {
  const t = p.tx[slot];
  if (t && !t.stopped && t.currentDirection !== 'stopped') {
    t.sender.replaceTrack(track).catch(() => {});
    try { t.sender.setStreams?.(stream); } catch { /* older browsers keep the first stream */ }
    t.direction = 'sendrecv';
    return;
  }
  const sender = p.pc.addTrack(track, stream);
  p.tx[slot] = p.pc.getTransceivers().find((x) => x.sender === sender) || null;
  attachCrypt(p);
}
function stopOn(p, slot) {
  const t = p.tx[slot];
  if (!t || t.stopped || t.currentDirection === 'stopped') return;
  t.sender.replaceTrack(null).catch(() => {});
  t.direction = 'recvonly';
}

// A remote video stream arrived, or lost its track.
function addRemoteVideo(p, stream) {
  p.video[stream.id] = stream;
  stream.onremovetrack = () => {
    if (!stream.getVideoTracks().length) delete p.video[stream.id];
    emit();
  };
  emit();
}

// Should my connection to this person go only through the relay (hiding my
// IP address from them)? Voice rooms and people who aren't friends do by
// default, when the server has a relay (js/lib/callnet.js relayWanted).
function relayFor(user) {
  const opts = { mode: relayMode(vp()), p2pHide: !!S.p2p?.hideIp, room: !S.call?.dm, friend: S.friends?.[user]?.state === 'friends' };
  return { want: relayWanted(opts), insist: relayInsisted(opts) };
}
let refreshingIce = null;
function refreshIce() {
  refreshingIce ||= call('ice.refresh').then((r) => {
    if (Array.isArray(r?.ice)) { S.ice = r.ice; S.iceExp = r.iceExp || null; }
  }).catch(() => {}).finally(() => { refreshingIce = null; });
  return refreshingIce;
}
let noRelayToast = 0;
// calls C3: with no relay on this server, a call connects straight to the
// other people's devices, so they can see my IP address. Said before joining:
// a note on the voice room and the incoming call, and once per device before
// starting a call (js/calls.js). Not for the desktop app's PC-to-PC calls: the
// registry's relay is fetched only when a call starts (server/peer.js
// turnFor), so beforehand there is no telling; without one they go direct
// unless "Hide my IP from friends" is on. Nothing says so yet (README, SECURITY.md).
export const connectsDirectly = () => !hasTurn(S.ice) && !(S.p2p?.enabled && S.p2p.owner) && relayMode(vp()) !== 'all';
const DIRECT_OK = 'snug.directOk';
export function directAcknowledged() { try { return localStorage.getItem(DIRECT_OK) === '1'; } catch { return false; } }
export function acknowledgeDirect() { try { localStorage.setItem(DIRECT_OK, '1'); } catch { /* private window: asked again next time */ } }

let pcSeq = 0;
function peer(user, offering) {
  let p = peers.get(user);
  if (p) return p;
  // p2p: registry TURN credentials near their end are refreshed for the next connection (F10).
  if (S.iceExp && S.iceExp - Date.now() < 600_000) refreshIce();
  const turn = hasTurn(S.ice);
  const relay = relayFor(user);
  // Asked outright to hide my IP and no relay is known: relay-only all the
  // same, which can't connect, rather than quietly going direct (S14).
  const relayOnly = relay.want && (turn || relay.insist);
  const pc = new RTCPeerConnection({ iceServers: S.ice, ...(relayOnly ? { iceTransportPolicy: 'relay' } : {}), ...(crypt.mode === 'streams' ? { encodedInsertableStreams: true } : {}) });
  p = {
    pc, audio: null, screenAudio: null, queue: [], stopLevel: null,
    polite: String(S.me) > String(user), makingOffer: false, ignoreOffer: false, settingAnswer: false,
    chain: Promise.resolve(), kinds: pendingKinds.get(user) || {}, video: {}, tx: {},
    user, id: ++pcSeq, relay: relayOnly, noRelay: relayOnly && !turn, adapt: { level: 0, bad: 0, good: 0 }, wantCamera: pendingWant.get(user) ?? true, restarts: [], graceTimer: null,
  };
  pendingKinds.delete(user);
  pendingWant.delete(user);
  peers.set(user, p);
  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      attachCrypt(p, user);
      await pc.setLocalDescription();
      await sendSdp(user, pc.localDescription);
    } catch { /* a newer negotiation replaced this one */ } finally { p.makingOffer = false; }
  };
  tellKinds(user);
  // Data saver: ask for no camera from them (a tile offers to show it).
  if (vp().lowData && !S.call?.showCam?.[user]) signal(user, { want: { camera: false } });
  if (send || mic) (send || mic).getTracks().forEach((t) => pc.addTrack(t, send || mic));
  // Listening without a microphone: receive their voice all the same. When I
  // offer, a receive-only line asks for it; when I answer, their offer has one.
  else if (offering) p.tx.voice = pc.addTransceiver('audio', { direction: 'recvonly' });
  // Late joiners get whatever I am already showing.
  if (cam) sendOn(p, 'camera', cam.getVideoTracks()[0], out.camera);
  if (screen) {
    sendOn(p, 'screen', screen.getVideoTracks()[0], out.screen);
    if (screen.getAudioTracks()[0]) sendOn(p, 'screenAudio', screen.getAudioTracks()[0], out.screenAudio);
  }
  attachCrypt(p, user);
  // Relay-only: nothing but relay candidates leaves this device (calls C3).
  pc.onicecandidate = (e) => { if (e.candidate && (!p.relay || relayCandidate(e.candidate.candidate))) signal(user, { candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    attachCrypt(p, user);
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (e.track.kind === 'video') {
      addRemoteVideo(p, stream);
      e.track.onunmute = () => emit();
      return;
    }
    // Audio: the microphone, or the sound of a shared screen.
    const isScreen = p.kinds.screenAudio === stream.id || (p.audio && p.audio.srcObject !== stream && p.kinds.mic !== stream.id);
    if (!isScreen && p.audio) return;
    if (isScreen && p.screenAudio?.srcObject === stream) return;
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    tuneAudio(user, audio, heard(user));
    audio.play().catch(() => {});
    if (isScreen) { if (p.screenAudio) p.screenAudio.srcObject = null; p.screenAudio = audio; return; }
    p.audio = audio;
    p.stopLevel = watchLevel(user, stream);
  };
  pc.onconnectionstatechange = () => onLineState(user, p);
  // Some browsers report trouble on the ICE state before the connection state.
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') onLineState(user, p, pc.iceConnectionState); };
  if (p.noRelay) {
    setPeerState(user, 'norelay');
    if (Date.now() - noRelayToast > 30_000) {
      noRelayToast = Date.now();
      toast('Snug found no relay to hide your IP address, so it didn’t connect you directly. Turn off “Hide my IP address” in Voice and video settings to connect without one.');
    }
    // A relay may be on its way (PC to PC, fetched at the start of a call): try again with it.
    refreshIce().then(() => { if (peers.get(user) === p && hasTurn(S.ice)) { dropPeer(user); peer(user, true); } });
  } else setPeerState(user, 'connecting');
  sendKeyTo(user);
  recapIfMeshChanged();
  return p;
}

// ---------- A line in trouble ----------
// 'disconnected' often heals by itself (a Wi-Fi blip): after a short grace,
// restart ICE (new network paths over the same connection, no new call).
// 'failed' restarts at once. Either side may restart; crossing offers settle
// as any other renegotiation. After three restarts in a minute the side that
// isn't polite builds a new connection, and the other side drops its old one
// when the new connection's offer arrives (a new SDP session).
export let ICE_GRACE_MS = 4000;
const RESTARTS = 3;
function onLineState(user, p, state = p.pc.connectionState) {
  if (peers.get(user) !== p) return;
  const { pc } = p;
  setPeerState(user, state);
  if (state === 'connected') {
    p.upSince ||= Date.now();
    clearTimeout(p.graceTimer);
    p.graceTimer = null;
    capBitrate(p);
    readCode(user, p);
    return;
  }
  if (state === 'disconnected') {
    if (p.graceTimer) return;
    p.graceTimer = setTimeout(() => {
      p.graceTimer = null;
      if (peers.get(user) === p && ['disconnected', 'failed'].includes(p.simulated || pc.connectionState)) restartLine(user, p);
    }, ICE_GRACE_MS);
    return;
  }
  if (state === 'failed') { clearTimeout(p.graceTimer); p.graceTimer = null; restartLine(user, p); }
}
// The security code for this connection (js/lib/callnet.js callCode), from
// both certificates' fingerprints as this side sees them; the same for one
// connection's life, ICE restarts included.
// When both devices signed their certificates (calls C2), the code is longer
// and comes from both devices' identity keys as well: "Verified device".
async function codeFor(user, p) {
  const local = p.pc.currentLocalDescription, remote = p.pc.currentRemoteDescription;
  if (p.fp && p.signed) {
    const keys = await identityKeys(user, p.fp.d).catch(() => null);
    const mine = sdpFingerprints(local);
    if (keys && mine) {
      const code = await deviceCode({ key: keys.mine, fp: mine }, { key: keys.theirs, fp: p.fp.fingerprint });
      if (code) return { code, verified: true };
    }
  }
  const code = await callCode(local, remote);
  return code ? { code, verified: false } : null;
}
function readCode(user, p) {
  if (p.code) return;
  codeFor(user, p).then((r) => {
    if (r && peers.get(user) === p && !p.code) { p.code = r.code; p.verified = r.verified; emit(); }
  }).catch(() => {});
}
// The code to compare with one person, or null while there is none yet.
export const codeOf = (user) => peers.get(user)?.code || null;
// Whether that code is the longer one: both devices signed their certificates and the signatures checked.
export const verifiedDevice = (user) => !!peers.get(user)?.verified;

function restartLine(user, p) {
  if (p.noRelay) return;
  const now = Date.now();
  p.simulated = null;
  // The connection and ICE states both report one failure: restart once for it.
  if (now - (p.restarts.at(-1) || 0) < 1000) return;
  p.restarts = p.restarts.filter((t) => now - t < 60_000);
  if (p.restarts.length >= RESTARTS) {
    if (p.polite) return; // the other side builds the new connection
    dropPeer(user);
    peer(user, true);
    return;
  }
  p.restarts.push(now);
  p.restarted = (p.restarted || 0) + 1;
  try { p.pc.restartIce(); } catch { /* old browser: wait for the other side */ }
  setPeerState(user, p.pc.connectionState === 'connected' ? 'connected' : 'reconnecting');
}

function dropPeer(user) {
  const p = peers.get(user);
  if (!p) return;
  peers.delete(user);
  clearTimeout(p.graceTimer);
  p.stopLevel?.();
  if (p.audio) { forgetAudio(p.audio); p.audio.srcObject = null; }
  if (p.screenAudio) { forgetAudio(p.screenAudio); p.screenAudio.srcObject = null; }
  p.pc.close();
  // Their keys go, and what they sent is judged afresh on a new connection.
  crypt.worker?.postMessage({ t: 'drop', peer: user });
  ckOf.delete(user);
  const next = { ...S.peers };
  delete next[user];
  S.peers = next;
  if (S.speaking[user]) { S.speaking = { ...S.speaking }; delete S.speaking[user]; }
  recapIfMeshChanged();
  emit();
}

// Signals from one person are handled one at a time, in the order they came.
async function handleSignal(from, p, data) {
  const { pc } = p;
  if (peers.get(from) !== p) return; // they left while this waited
  try {
    if (data.sdp) {
      const desc = data.sdp;
      // calls C2: checked first, so the collision below is judged on the state after this wait.
      if ((await checkSdp(from, p, desc)) === 'refuse') { refusePeer(from); return; }
      if (peers.get(from) !== p) return;
      const ready = !p.makingOffer && (pc.signalingState === 'stable' || p.settingAnswer);
      const collision = desc.type === 'offer' && !ready;
      if (collision) p.glare = (p.glare || 0) + 1;
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      p.settingAnswer = desc.type === 'answer';
      await pc.setRemoteDescription({ type: desc.type, sdp: withFpAttr(desc.sdp, null) }); // a polite peer rolls its own offer back here
      p.settingAnswer = false;
      // What the browser took is what was signed.
      if (p.fp && sdpFingerprints(pc.remoteDescription?.sdp) !== p.fp.fingerprint) { refusePeer(from); return; }
      attachCrypt(p, from);
      for (const c of p.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      // Listening: their voice's line is the one a microphone joins later.
      if (!send && !p.tx.voice) p.tx.voice = pc.getTransceivers().find((t) => t.mid != null && t.receiver.track?.kind === 'audio') || null;
      if (desc.type === 'offer') {
        attachCrypt(p, from);
        await pc.setLocalDescription();
        await sendSdp(from, pc.localDescription);
      }
      capBitrate(p);
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else p.queue.push(data.candidate);
    }
  } catch {
    p.settingAnswer = false;
    if (peers.get(from) === p && pc.connectionState !== 'connected') setPeerState(from, 'failed');
  }
}

on('rtc', ({ from, data }) => {
  if (!S.call || !data || typeof data !== 'object' || crypt.refused.has(from)) return;
  if (data.ck && typeof data.ck === 'object') { onCallKey(from, data.ck); return; }
  if (data.kinds) {
    const k = { mic: data.kinds.mic || null, camera: data.kinds.camera || null, screen: data.kinds.screen || null, screenAudio: data.kinds.screenAudio || null };
    const p = peers.get(from);
    if (p) { p.kinds = k; emit(); } else pendingKinds.set(from, k);
    return;
  }
  // Their data saver: whether they want my camera.
  if (data.want) {
    const p = peers.get(from);
    if (typeof data.want.camera !== 'boolean') return;
    if (p) { p.wantCamera = data.want.camera; capBitrate(p); } else pendingWant.set(from, data.want.camera);
    return;
  }
  if (!data.sdp && !data.candidate) return;
  // A fresh offer on a connection that already failed, or from a brand-new
  // connection of theirs (a new SDP session): they started again, so do I.
  const old = peers.get(from);
  if (old && data.sdp?.type === 'offer') {
    const theirs = old.pc.remoteDescription && sdpSession(old.pc.remoteDescription);
    if (['failed', 'closed'].includes(old.pc.connectionState) || (theirs && sdpSession(data.sdp) && sdpSession(data.sdp) !== theirs)) dropPeer(from);
  }
  const p = peer(from, false);
  p.chain = p.chain.then(() => handleSignal(from, p, data));
});

// Someone left the room: close their connection. Someone whose signalling
// dropped (held by the server, shown as reconnecting) keeps it: their audio
// often still flows. When they are back, anything said while they were away
// (an offer of mine they never got) goes again, and a line that isn't
// connected restarts.
const awayNow = new Set();
let lastUsers = '';
on('voice', ({ room, users, state }) => {
  if (S.call?.room !== room) return;
  for (const u of [...peers.keys()]) if (!users.includes(u)) dropPeer(u);
  for (const u of [...crypt.refused]) if (!users.includes(u)) crypt.refused.delete(u);
  // Someone joined or left: a new key of mine, so newcomers can't open what came before and leavers what comes after.
  const now = [...users].sort().join();
  if (now !== lastUsers) { const had = lastUsers; lastUsers = now; if (had && S.call.status === 'live') newCallKey(); }
  for (const u of [...pendingKinds.keys()]) if (!users.includes(u)) pendingKinds.delete(u);
  for (const u of [...pendingWant.keys()]) if (!users.includes(u)) pendingWant.delete(u);
  for (const u of users) {
    if (u === S.me) continue;
    const away = !!state?.[u]?.reconnecting;
    if (away) { awayNow.add(u); continue; }
    if (!awayNow.delete(u)) continue;
    const p = peers.get(u);
    if (p && S.call.status === 'live') resumeLine(u, p);
  }
  for (const u of [...awayNow]) if (!users.includes(u)) awayNow.delete(u);
});
function resumeLine(user, p) {
  tellKinds(user);
  if (vp().lowData) signal(user, { want: { camera: !!S.call?.showCam?.[user] } });
  if (p.pc.signalingState === 'have-local-offer' && p.pc.localDescription) sendSdp(user, p.pc.localDescription);
  else if (p.pc.connectionState !== 'connected') restartLine(user, p);
}
on('voice.kicked', ({ room, reason } = {}) => {
  if (!S.call || (room && S.call.room !== room)) return;
  const dm = S.call.dm;
  stop();
  if (reason === 'elsewhere') toast(dm ? 'You took this call on another device.' : 'You joined voice on another device.');
  else toast(dm ? 'You were disconnected from the call.' : 'You were disconnected from the voice room.');
});
// A call ended for everyone (hung up, declined, nobody answered): close it here too.
on('call.ended', ({ dm, reason }) => {
  if (S.call?.room !== dm) return;
  stop();
  S.callEnd = { dm, reason, at: Date.now() };
  emit();
});
// ---------- Reconnecting after a dropped connection ----------
// The server holds my place for a while (server/hub.js voiceLost). Here the
// call stays, with my microphone, camera and screen, and so do the
// connections to the others: their media goes directly between us, not
// through the server, so it usually keeps flowing. When the socket is back I
// join the same place again, say again whatever was lost on the way, and
// only connections that aren't working start afresh. If getting back in
// fails, or takes too long, the call ends.
export const RECONNECT_MS = 20_000;
let reconnectTimer = null;
const droppedText = (dm) => (dm ? 'The call dropped because the connection did. Call again when you’re back.' : 'Voice disconnected because the connection dropped. Join again when you’re back.');
on('close', () => {
  if (!S.call) return;
  const c = S.call;
  if (c.status !== 'live' && c.status !== 'reconnecting') { stop(); toast(droppedText(c.dm)); return; }
  c.status = 'reconnecting';
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (S.call === c && c.status === 'reconnecting') { stop(); toast(droppedText(c.dm)); } }, RECONNECT_MS);
  emit();
});
on('open', async () => {
  const c = S.call;
  if (!c || c.status !== 'reconnecting') return;
  try {
    const r = c.dm ? await call('call.join', { dm: c.room }) : await call('voice.join', { room: c.room });
    if (S.call !== c) return;
    clearTimeout(reconnectTimer);
    c.status = 'live';
    if (r.call) c.id = r.call;
    emit();
    pushState();
    for (const u of [...peers.keys()]) if (!r.peers.includes(u)) dropPeer(u);
    for (const u of r.peers) {
      const p = peers.get(u);
      if (!p) { peer(u, true); continue; }
      if (['failed', 'closed'].includes(p.pc.connectionState)) { dropPeer(u); peer(u, true); continue; }
      resumeLine(u, p);
    }
  } catch (e) {
    if (S.call !== c) return;
    if (e.offline) return; // dropped again: the next 'open' tries once more, until the timer runs out
    clearTimeout(reconnectTimer);
    const dm = c.dm;
    stop();
    toast(dm ? `Couldn’t get back into the call. ${e.message}` : `Couldn’t get back into voice. ${e.message}`);
  }
});

function stop() {
  clearTimeout(reconnectTimer);
  stopMutedWatch();
  for (const u of [...peers.keys()]) dropPeer(u);
  stopMyLevel?.();
  stopMyLevel = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  micLost = false;
  stopOutgoing();
  send = null;
  cam?.getTracks().forEach((t) => t.stop());
  cam = null;
  screen?.getTracks().forEach((t) => t.stop());
  screen = null;
  pendingKinds.clear();
  pendingWant.clear();
  awayNow.clear();
  wasMany = false;
  out = null;
  stopCrypt();
  crypt.refused.clear();
  lastUsers = '';
  S.call = null;
  S.peers = {};
  S.speaking = {};
  S.netq = {};
  S.mutedWarn = 0;
  emit();
}

// Join a voice place. For a direct conversation or group this is a call:
// { start: true } starts one (and rings the others) unless one is already
// live there, in which case it joins it; { video: true } turns the camera on
// once connected; { listen: true } joins without a microphone, only hearing.
// Without a working microphone (none, refused, busy, or a page that can't
// use one) it joins to listen too and says why; the microphone button adds
// one later. Resolves to how it went: 'ok' (in, or already in), 'offline' or
// 'error' (already said in a toast).
export async function joinVoice(room, { start = false, video = false, listen = false } = {}) {
  if (S.call?.room === room) { if (video && !S.call.camera && S.call.status === 'live') toggleCamera(); return 'ok'; }
  const dm = !!S.dms[room];
  if (S.call) leaveVoice();
  const what = dm ? 'call' : 'join voice';
  if (S.conn.socket !== 'open') { toast(`You’re offline, so you can’t ${what} right now.`); return 'offline'; }
  if (S.callEnd?.dm === room) S.callEnd = null;
  if (iceSoon()) await refreshIce();
  const c = { room, dm, muted: false, deaf: false, camera: false, screen: false, status: 'mic', video: !!video, listen: false };
  S.call = c;
  // The screen's sound goes in its own stream, so adding it never restarts the picture.
  out = { camera: new MediaStream(), screen: new MediaStream(), screenAudio: new MediaStream() };
  emit();
  let why = listen ? 'chosen' : !navigator.mediaDevices?.getUserMedia ? 'insecure' : null;
  if (!why) {
    try {
      mic = await getMic();
      send = await outgoing(mic);
    } catch (e) {
      mic?.getTracks().forEach((t) => t.stop());
      mic = null;
      stopOutgoing();
      send = null;
      why = e || 'failed';
    }
  }
  if (S.call !== c) { mic?.getTracks().forEach((t) => t.stop()); return 'ok'; } // left while the microphone started
  if (why) {
    c.listen = true;
    c.muted = true;
    if (why !== 'chosen') toast(listenText(why, dm));
  } else {
    stopMyLevel = watchLevel(S.me, mic);
    watchMic(mic);
  }
  // calls C1: the media encryption worker, ready before any connection exists.
  await startCrypt();
  if (S.call !== c) { stopCrypt(); mic?.getTracks().forEach((t) => t.stop()); return 'ok'; }
  try {
    c.status = 'joining';
    emit();
    const r = dm
      ? await call(start ? 'call.start' : 'call.join', { dm: room, video: !!video })
      : await call('voice.join', { room });
    if (S.call !== c) return 'ok';
    c.status = 'live';
    c.id = r.call || null;
    c.joinedAt = Date.now(); // the call clock in a voice room (js/views/activities.js CallTimer)
    emit();
    cue('join');
    if (c.listen) pushState();
    lastUsers = [S.me, ...r.peers].sort().join();
    for (const u of r.peers) peer(u, true);
    // Data saver keeps the camera off until you turn it on.
    if (video && vp().lowData) toast('Data saver is on, so your camera stays off. Turn it on with the camera button if you want it.');
    else if (video && !c.listen) toggleCamera();
    return 'ok';
  } catch (e) {
    stop();
    toast(e.offline ? `You’re offline, so you can’t ${what} right now.` : e.message);
    return 'error';
  }
}

// Listening, then a microphone: capture it and start sending it on every
// connection (on the line that already carries their voice, so each
// connection renegotiates once). If it still won't start, keep listening.
let addingMic = false;
async function addMic() {
  const c = S.call;
  if (!c?.listen || addingMic) return false;
  if (!navigator.mediaDevices?.getUserMedia) { toast(listenText('insecure', c.dm)); return false; }
  addingMic = true;
  let m = null, outStream = null;
  try {
    m = await getMic();
    outStream = await outgoing(m);
  } catch (e) {
    m?.getTracks().forEach((t) => t.stop());
    stopOutgoing();
    toast(`${errText(e).replace(/ to join\./, ' to talk.')} You’re still listening.`);
    return false;
  } finally { addingMic = false; }
  if (S.call !== c || !c.listen) { m.getTracks().forEach((t) => t.stop()); if (!mic) stopOutgoing(); return false; }
  mic = m;
  send = outStream;
  c.listen = false;
  c.muted = false;
  const track = send.getAudioTracks()[0];
  for (const [u, p] of peers) {
    tellKinds(u);
    const t = p.tx.voice;
    if (t && !t.sender.track && t.currentDirection !== 'stopped') {
      t.sender.replaceTrack(track).catch(() => {});
      try { t.sender.setStreams?.(send); } catch { /* older browsers: the kinds signal still names it */ }
      t.direction = 'sendrecv';
    } else p.pc.addTrack(track, send);
    attachCrypt(p, u);
  }
  stopMyLevel = watchLevel(S.me, mic);
  watchMic(mic);
  gate();
  cue('unmute');
  emit();
  pushState();
  for (const p of peers.values()) capBitrate(p);
  return true;
}

export function leaveVoice() {
  if (!S.call) return;
  const live = S.call.status === 'live';
  call('voice.leave').catch(() => {});
  stop();
  if (live) cue('leave');
}

// ---------- The screen kept on, and the system's call controls ----------
// While in a call or voice, the screen stays on (Screen Wake Lock), asked for
// again when the page comes back in front (the system lets go of it while
// hidden). The system's own call controls (Media Session: a phone's lock
// screen, a headset's button, the desktop's media controls, where the
// browser offers them) mute, turn the camera on and off, and hang up. Both
// follow the state, so every way in or out of a call is covered; a browser
// without either just goes without.
let wake = null;        // the wake lock held while in a call
let wakeAsking = false;
async function holdWake() {
  if (!S.call || wake || wakeAsking || document.visibilityState !== 'visible' || !navigator.wakeLock?.request) return;
  wakeAsking = true;
  try {
    const w = await navigator.wakeLock.request('screen');
    if (!S.call) { w.release?.().catch?.(() => {}); return; }
    wake = w;
    w.addEventListener?.('release', () => { if (wake === w) wake = null; });
  } catch { /* not allowed here (battery saver, no screen): the call goes on */ } finally { wakeAsking = false; }
}
function dropWake() {
  const w = wake;
  wake = null;
  try { w?.release?.().catch?.(() => {}); } catch { /* already gone */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') holdWake(); });

const CALL_ACTIONS = { togglemicrophone: () => toggleMute(), togglecamera: () => toggleCamera(), hangup: () => leaveVoice() };
let controls = null; // what the media session was last told: { title, mic, cam }
function callTitle(c) {
  if (!c.dm) return `Voice in ${S.rooms[c.room]?.name || 'a voice room'}`;
  const meta = convMeta(c.room);
  return meta?.kind === 'group' ? `Call in ${meta.title}` : `Call with ${meta?.title || 'someone'}`;
}
function syncControls() {
  const ms = navigator.mediaSession;
  const c = S.call?.status === 'live' || S.call?.status === 'reconnecting' ? S.call : null;
  if (!ms || (!c && !controls)) return;
  if (!c) {
    controls = null;
    for (const a of Object.keys(CALL_ACTIONS)) { try { ms.setActionHandler(a, null); } catch { /* not offered here */ } }
    try { ms.metadata = null; } catch { /* read-only here */ }
    return;
  }
  const next = { title: callTitle(c), mic: !c.muted, cam: !!c.camera };
  if (!controls) for (const [a, fn] of Object.entries(CALL_ACTIONS)) { try { ms.setActionHandler(a, fn); } catch { /* this action isn't offered here */ } }
  if (controls?.title !== next.title) {
    try { ms.metadata = typeof MediaMetadata === 'function' ? new MediaMetadata({ title: next.title, artist: 'Snug' }) : null; } catch { /* no metadata here */ }
  }
  if (controls?.mic !== next.mic) { try { ms.setMicrophoneActive?.(next.mic); } catch { /* not offered */ } }
  if (controls?.cam !== next.cam) { try { ms.setCameraActive?.(next.cam); } catch { /* not offered */ } }
  controls = next;
}
let wakeFor = null; // the call the wake lock was asked for: once per call, then on coming back in front
subscribe(() => {
  if (S.call && wakeFor !== S.call) { wakeFor = S.call; holdWake(); } else if (!S.call && wakeFor) { wakeFor = null; dropWake(); }
  syncControls();
});

function pushState() {
  if (!S.call) return;
  call('voice.state', { muted: S.call.muted, deaf: S.call.deaf, camera: !!S.call.camera, screen: !!S.call.screen, listen: !!S.call.listen }).catch(() => {});
}

// Whether I should hear this person: not while I'm deafened, and never while a
// moderator has server-muted them (js/views/safety.js, server/safety.js).
const heard = (user) => !S.call?.deaf && !S.voiceState[S.call?.room]?.[user]?.smute;
export function applyHearing() {
  // Also each person's volume and a mute only I hear (js/voiceopts.js).
  for (const [user, p] of peers) {
    if (p.audio) tuneAudio(user, p.audio, heard(user));
    if (p.screenAudio) tuneAudio(user, p.screenAudio, heard(user));
  }
}
onRetune(applyHearing);

export function toggleMute() {
  if (!S.call) return;
  // A moderator's mute (or deafen) can't be lifted from here.
  const mod = S.voiceState[S.call.room]?.[S.me];
  if (S.call.muted && (mod?.smute || mod?.sdeaf)) { toast('A moderator muted you here.'); return; }
  // Listening without a microphone: unmuting adds one.
  if (S.call.listen) { addMic(); return; }
  // The microphone was lost: unmuting tries to capture again first.
  if (S.call.muted && micLost) { restartMic().then((ok) => { if (ok && S.call?.muted) toggleMute(); }); return; }
  S.call.muted = !S.call.muted;
  const wasDeaf = S.call.deaf;
  if (!S.call.muted) S.call.deaf = false;
  mic?.getAudioTracks().forEach((t) => { t.enabled = !S.call.muted; });
  gate();
  applyHearing();
  cue(wasDeaf && !S.call.deaf ? 'undeafen' : S.call.muted ? 'mute' : 'unmute');
  emit();
  pushState();
}

export function toggleDeaf() {
  if (!S.call) return;
  if (S.call.deaf && S.voiceState[S.call.room]?.[S.me]?.sdeaf) { toast('A moderator deafened you here.'); return; }
  S.call.deaf = !S.call.deaf;
  // Deafening mutes too, unless turned off in settings; hearing again puts the mute back how it was.
  if (S.call.deaf) { S.call.mutedBeforeDeaf = S.call.muted; if (vp().deafMutes) S.call.muted = true; }
  else if (S.call.mutedBeforeDeaf === false && !S.voiceState[S.call.room]?.[S.me]?.smute) S.call.muted = false;
  mic?.getAudioTracks().forEach((t) => { t.enabled = !S.call.muted; });
  gate();
  applyHearing();
  cue(S.call.deaf ? 'deafen' : 'undeafen');
  emit();
  pushState();
}

// A new microphone, or new processing (noise suppression, echo cancellation,
// automatic gain): capture again and swap it in under the same outgoing track,
// so nobody's connection is renegotiated.
export async function restartMic() {
  const c = S.call;
  if (!c || !mic) return false;
  // Chromium gives a second capture of a device the processing of the first
  // one still open, so the old capture stops first (a moment of silence).
  const before = mic.getAudioTracks()[0]?.getConstraints?.() || {};
  // The muted-note listener holds a copy of the old capture: let it go too, or
  // the new capture would inherit the old one's processing.
  stopMutedWatch();
  mic.getTracks().forEach((t) => t.stop());
  let next;
  try { next = await getMic(); } catch (e) {
    toast(errText(e));
    // Back to how it was, if that still works.
    try { next = await navigator.mediaDevices.getUserMedia({ audio: before }); } catch {
      // Neither works (the device was unplugged): the old capture is stopped,
      // so say so and show this person as muted rather than silently unmuted.
      if (S.call === c) {
        micLost = true;
        if (!c.muted) { c.muted = true; gate(); emit(); pushState(); }
        toast('Snug lost your microphone, so you’re muted. Pick another one in Voice settings, or unmute to try again.');
      }
      return false;
    }
  }
  micLost = false;
  if (S.call !== c || !mic) { next.getTracks().forEach((t) => t.stop()); return false; }
  const old = mic;
  mic = next;
  mic.getAudioTracks().forEach((t) => { t.enabled = !c.muted; });
  const now = swapMic(mic);
  if (now && now !== send) {
    // No WebAudio here: the raw microphone is what is sent, so its track changes on every connection.
    send = now;
    for (const p of peers.values()) {
      const s = p.pc.getSenders().find((x) => x.track && x.track.kind === 'audio' && old.getAudioTracks().includes(x.track));
      s?.replaceTrack(mic.getAudioTracks()[0]).catch(() => {});
    }
  }
  stopMyLevel?.();
  stopMyLevel = watchLevel(S.me, mic);
  watchMic(mic);
  old.getTracks().forEach((t) => t.stop());
  return true;
}
// A new camera: turn it off and on again with the chosen one.
export async function restartCamera() {
  if (!S.call?.camera) return;
  stopCamera();
  await toggleCamera();
}
// Re-apply bitrate ceilings, after the room's bitrate or the screen quality changed.
export function recapBitrates() { for (const p of peers.values()) capBitrate(p); }
// The screen share's quality or kind changed: apply it to the share already
// running (its resolution and frame rate, what it favours), not only the next one.
export function applyScreen() {
  const track = screen?.getVideoTracks()[0];
  if (track) {
    try { track.contentHint = screenPref(vp().screenHint).contentHint; } catch { /* hint only */ }
    track.applyConstraints?.(screenConstraints().video).catch(() => { /* the browser keeps what it has */ });
  }
  recapBitrates();
}

// How the line to one person goes: asked to be relay-only, and the route measured once connected.
export function lineOf(user) {
  const p = peers.get(user);
  return { relay: !!p?.relay, route: p?.q ? (p.q.relay ? 'relayed' : 'direct') : null };
}

// ---------- Data saver ----------
// Turned on or off (Settings > Voice and video, or the call's options): tell
// everyone whether I want their cameras, and re-apply my own send caps.
export function applyDataSaver() {
  if (!S.call) return;
  const low = !!vp().lowData;
  for (const [u, p] of peers) {
    signal(u, { want: { camera: !low || !!S.call.showCam?.[u] } });
    capBitrate(p);
  }
  if (screen) applyScreen(); // a running share drops to (or back from) 720p and 10 frames a second
  emit();
}
// With data saver on, someone's camera is paused until you ask to see it.
export function cameraPaused(user) {
  if (!S.call || user === S.me || !vp().lowData || S.call.showCam?.[user]) return false;
  // Still arriving (their Snug can't pause it): show it rather than pretend.
  return !((peers.get(user)?.camKbps || 0) > 30);
}
export function showCamera(user) {
  if (!S.call) return;
  S.call.showCam = { ...(S.call.showCam || {}), [user]: true };
  signal(user, { want: { camera: true } });
  emit();
}

// ---------- Camera and screen ----------

const camErrText = (e) => ({
  NotAllowedError: 'Snug needs your camera for that. Allow it in your browser’s site settings, then try again.',
  SecurityError: 'Snug needs your camera for that. Allow it in your browser’s site settings, then try again.',
  NotFoundError: 'No camera found. Connect one and try again.',
  NotReadableError: 'Another app is using your camera. Close it and try again.',
}[e?.name] || 'Couldn’t start your camera.');

const CAMERA = {
  width: { min: 640, ideal: 1280, max: 1280 },
  height: { min: 360, ideal: 720, max: 720 },
  frameRate: { ideal: 24, max: 30 },
};

// Put a captured track into the stream the others receive for that kind.
function fill(stream, tracks) {
  for (const t of stream.getTracks()) stream.removeTrack(t);
  for (const t of tracks) stream.addTrack(t);
}

// Tell everyone which stream is which, then start (or stop) sending the slot.
function shareSlot(slot, track, stream) {
  for (const [u, p] of peers) {
    tellKinds(u);
    if (track) sendOn(p, slot, track, stream); else stopOn(p, slot);
  }
}

export const canShareScreen = () => !!navigator.mediaDevices?.getDisplayMedia;

// A voice room may keep cameras and screens to some people (its "Share camera
// and screen" permission, checked again on the server).
export const videoBlocked = (room = S.call?.room) => (S.rooms[room]?.perms?.video === false ? `You can’t share your camera or screen in ${S.rooms[room].name}.` : null);
on('voice.media.off', ({ room } = {}) => {
  if (!S.call || S.call.room !== room) return;
  const had = S.call.camera || S.call.screen;
  stopCamera(); stopScreen();
  if (had) toast(`Your camera and screen were turned off: sharing them isn’t allowed in ${S.rooms[room]?.name || 'this room'} any more.`);
});

export async function toggleCamera() {
  const c = S.call;
  if (!c || c.status !== 'live' || c.cameraBusy) return;
  if (c.camera) { stopCamera(); return; }
  if (videoBlocked()) { toast(videoBlocked()); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser can’t use a camera here.'); return; }
  c.cameraBusy = true;
  emit();
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(cameraBase(CAMERA)) });
  } catch (e) {
    // A camera that can't do 640x360 still beats no camera.
    if (e?.name === 'OverconstrainedError' || (e?.name === 'NotFoundError' && vp().camera)) {
      stream = await navigator.mediaDevices.getUserMedia({ video: true }).catch((e2) => { toast(camErrText(e2)); return null; });
    } else toast(camErrText(e));
  }
  c.cameraBusy = false;
  if (!stream || S.call !== c) { stream?.getTracks().forEach((t) => t.stop()); emit(); return; }
  cam = stream;
  const track = stream.getVideoTracks()[0];
  try { track.contentHint = 'motion'; } catch { /* hint only */ }
  track.onended = () => { if (cam === stream) { stopCamera(); toast('Your camera stopped.'); } };
  c.camera = true;
  fill(out.camera, [track]);
  shareSlot('camera', track, out.camera);
  emit();
  pushState();
}

function stopCamera() {
  if (!cam) return;
  const was = cam;
  cam = null;
  shareSlot('camera', null);
  if (out) fill(out.camera, []);
  was.getTracks().forEach((t) => t.stop());
  if (S.call) { S.call.camera = false; if (S.call.focus === `${S.me}:camera`) S.call.focus = null; }
  emit();
  pushState();
}

export async function toggleScreen() {
  const c = S.call;
  if (!c || c.status !== 'live' || c.screenBusy) return;
  if (c.screen) { stopScreen(); return; }
  if (videoBlocked()) { toast(videoBlocked()); return; }
  if (!canShareScreen()) { toast('This browser can’t share a screen.'); return; }
  c.screenBusy = true;
  emit();
  let stream = null;
  try {
    // Resolution, frame rate and whether to share sound come from the voice options (js/voiceopts.js).
    stream = await navigator.mediaDevices.getDisplayMedia(screenConstraints());
  } catch (e) {
    // Closing the picker is a choice, not an error. A refusal from the system is.
    if (e?.name === 'NotAllowedError' && /system/i.test(e.message || '')) toast('Your computer isn’t letting the browser share the screen. Allow screen recording for it in your system settings.');
    else if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast('Couldn’t share your screen.');
  }
  c.screenBusy = false;
  if (!stream || S.call !== c) { stream?.getTracks().forEach((t) => t.stop()); emit(); return; }
  screen = stream;
  const track = stream.getVideoTracks()[0];
  try { track.contentHint = screenPref(vp().screenHint).contentHint; } catch { /* hint only */ }
  // The browser's own "Stop sharing" ends the track.
  track.onended = () => { if (screen === stream) stopScreen(); };
  c.screen = true;
  const sound = stream.getAudioTracks()[0];
  fill(out.screen, [track]);
  fill(out.screenAudio, sound ? [sound] : []);
  shareSlot('screen', track, out.screen);
  if (sound) for (const p of peers.values()) sendOn(p, 'screenAudio', sound, out.screenAudio);
  emit();
  pushState();
}

function stopScreen() {
  if (!screen) return;
  const was = screen;
  screen = null;
  shareSlot('screen', null);
  if (out) { fill(out.screen, []); fill(out.screenAudio, []); }
  for (const p of peers.values()) stopOn(p, 'screenAudio');
  was.getTracks().forEach((t) => t.stop());
  if (S.call) { S.call.screen = false; if (S.call.focus === `${S.me}:screen`) S.call.focus = null; }
  emit();
  pushState();
}

// What to show for a person: their camera and screen streams, when they are
// really arriving (or, for me, when they are on).
export function mediaOf(user) {
  if (!S.call) return { camera: null, screen: null };
  if (user === S.me) return { camera: cam, screen };
  const p = peers.get(user);
  if (!p) return { camera: null, screen: null };
  const pick = (id) => {
    const s = id && p.video[id];
    return s && s.getVideoTracks().some((t) => t.readyState === 'live') ? s : null;
  };
  return { camera: cameraPaused(user) ? null : pick(p.kinds.camera), screen: pick(p.kinds.screen) };
}

// For the end-to-end checks: the live connection states and audio bytes received.
export async function voiceStats() {
  const out = {};
  const cs = await cryptStats();
  for (const [u, p] of peers) {
    let bytes = 0, energy = 0;
    const report = await p.pc.getStats();
    const videoCodecs = new Set();
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') { bytes += r.bytesReceived; energy += r.totalAudioEnergy || 0; }
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.codecId) { const c = report.get(r.codecId); if (c?.mimeType) videoCodecs.add(c.mimeType); }
    });
    out[u] = {
      state: p.pc.connectionState, bytes, tx: p.pc.getTransceivers().length, screenSound: !!p.screenAudio?.srcObject?.getAudioTracks().length, glare: p.glare || 0,
      // The remote voice really playing: its element's clock moves on.
      audioTime: p.audio ? p.audio.currentTime : null, audioPaused: p.audio ? p.audio.paused : null,
      // Voice options: what I receive (its energy), and how loud I play it.
      energy, volume: p.audio ? p.audio.volume : null, muted: p.audio ? p.audio.muted : null, boost: p.audio ? boostOf(p.audio) : 0,
      // The ceiling on my voice to this person (the room's bitrate).
      voiceMax: (() => { const s = p.pc.getSenders().find((x) => x.track && x.track.kind === 'audio' && send && send.getAudioTracks().includes(x.track)); try { return s?.getParameters().encodings?.[0]?.maxBitrate ?? null; } catch { return null; } })(),
      // Connection quality, as last measured (js/lib/netquality.js).
      rtt: p.q?.rtt ?? null, loss: p.q?.loss ?? null, jitter: p.q?.jitter ?? null, sendKbps: p.q?.sendKbps ?? null, relay: p.q ? p.q.relay : null, quality: p.q?.quality ?? null,
      // Reconnection: which connection this is, its ICE credentials (they change on a restart), restarts so far.
      pc: p.id, ufrag: /a=ice-ufrag:(\S+)/.exec(p.pc.localDescription?.sdp || '')?.[1] || null, restarts: p.restarted || 0, signaling: p.pc.signalingState,
      // Hiding my IP: relay-only or not; adaptive quality's step; what my sends are capped at; whether they want my camera.
      policy: p.pc.getConfiguration().iceTransportPolicy, level: p.adapt.level, wantCamera: p.wantCamera,
      screenPref: (() => { try { return p.tx.screen?.sender?.track ? p.tx.screen.sender.getParameters().degradationPreference || null : null; } catch { return null; } })(),
      caps: Object.fromEntries(['camera', 'screen'].map((k) => { try { return [k, p.tx[k]?.sender?.track ? p.tx[k].sender.getParameters().encodings?.[0] || null : null]; } catch { return [k, null]; } })),
      sending: p.pc.getSenders().some((x) => x.track && x.track.kind === 'audio' && x.track.readyState === 'live'),
      // calls C1/C2: end-to-end encryption of the media with this person, and why not; the code and whether the device signed.
      e2ee: !!p.e2ee?.on, e2eeWhy: p.e2ee?.why ?? null, videoCodecs: [...videoCodecs], frames: cs[u] || null, code: p.code || null, verified: !!p.verified, fpSigned: !!p.fp,
    };
  }
  return out;
}

// ---------- The microphone going away, and devices coming and going ----------
// The microphone's track ends (unplugged, or taken by the system): capture
// again, falling back to the default device (getMic says so in a toast).
function watchMic(stream) {
  const t = stream?.getAudioTracks()[0];
  if (!t) return;
  t.onended = () => {
    if (mic !== stream || !S.call) return;
    const chosen = !!vp().input;
    restartMic().then((ok) => { if (ok && !chosen) toast('Your microphone stopped, so Snug started it again.'); });
  };
  startMutedWatch(stream);
}
// For the end-to-end checks: a line reported in trouble (as its connection
// state would), a poll's measured quality, and a shorter grace before a restart.
export function simulateLine(user, state) { const p = peers.get(user); if (p) { p.simulated = state; onLineState(user, p, state); } }
export function simulateQuality(user, q) { const p = peers.get(user); if (p) adapt(p, q); }
export function setIceGrace(ms) { ICE_GRACE_MS = ms; }
// Where each remote voice plays (the speaker chosen, through setSinkId).
export const audioSinks = () => [...peers.values()].map((p) => p.audio?.sinkId ?? null).filter((x) => x !== null);
// For the end-to-end checks: the microphone's track ending as if unplugged.
export function simulateMicEnded() { mic?.getAudioTracks()[0]?.dispatchEvent(new Event('ended')); }

let lastDefault = null; // the system default microphone, to notice it changing
async function defaultMic() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const d = list.find((x) => x.kind === 'audioinput' && x.deviceId === 'default');
    return { list, def: d ? `${d.groupId}|${d.label}` : null };
  } catch { return { list: [], def: null }; }
}
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  const { list, def } = await defaultMic();
  const before = lastDefault;
  lastDefault = def;
  const c = S.call;
  if (!c || !mic || c.status !== 'live') return;
  const v = vp();
  // The chosen microphone vanished: back to the default one.
  if (v.input && !list.some((x) => x.kind === 'audioinput' && x.deviceId === v.input)) { restartMic(); return; }
  // Following the system default, and it changed: follow it.
  if (!v.input && before && def && before !== def) { await restartMic(); toast('Snug switched to your new default microphone.'); }
  // The chosen camera vanished while it was on.
  if (c.camera && v.camera && !list.some((x) => x.kind === 'videoinput' && x.deviceId === v.camera)) restartCamera();
});
defaultMic().then(({ def }) => { lastDefault = def; });

// ---------- "You're muted" ----------
// While muted, a copy of the raw microphone (never sent anywhere) is listened
// to; talking over the voice threshold for about 1.5 seconds shows a note
// with Unmute, at most once a minute. Off with the mutedWarning setting.
export const MUTED_TALK_MS = 1500;
export const MUTED_WARN_EVERY = 60_000;
let mw = null; // { track, src, an, buf, timer, talk }
let lastWarn = 0;
function stopMutedWatch() {
  if (!mw) return;
  clearInterval(mw.timer);
  try { mw.src.disconnect(); } catch { /* gone */ }
  mw.track.stop();
  mw = null;
}
function startMutedWatch(stream) {
  stopMutedWatch();
  const raw = stream.getAudioTracks()[0];
  const c = audioCtx();
  if (!raw || !c) return;
  try {
    const track = raw.clone();
    track.enabled = true;
    const src = c.createMediaStreamSource(new MediaStream([track]));
    const an = c.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    mw = { track, src, an, buf: new Float32Array(an.fftSize), talk: 0, timer: null };
    mw.timer = setInterval(mutedTick, 100);
  } catch { mw = null; }
}
function mutedTick() {
  const call = S.call;
  if (!mw || !call) return;
  const mod = S.voiceState[call.room]?.[S.me];
  if (!call.muted || call.status !== 'live' || mod?.smute || mod?.sdeaf || S.prefs.mutedWarning === false) { mw.talk = 0; return; }
  mw.an.getFloatTimeDomainData(mw.buf);
  let sum = 0;
  for (const v of mw.buf) sum += v * v;
  const level = sum > 0 ? 20 * Math.log10(Math.sqrt(sum / mw.buf.length)) : -100;
  mw.level = level;
  // Speech has gaps: quiet only lets the count fall back slowly.
  mw.talk = level > Math.max(-60, meter.threshold) ? mw.talk + 100 : Math.max(0, mw.talk - 50);
  if (mw.talk >= MUTED_TALK_MS && Date.now() - lastWarn >= MUTED_WARN_EVERY) {
    lastWarn = Date.now();
    mw.talk = 0;
    S.mutedWarn = lastWarn;
    emit();
  }
}
export const mutedWatch = () => (mw ? { on: true, talk: mw.talk, level: mw.level ?? null } : { on: false });
export function dismissMutedWarn() { S.mutedWarn = 0; emit(); }
// For the end-to-end checks: allow the note again straight away.
export function resetMutedWarn() { lastWarn = 0; S.mutedWarn = 0; }

// ---------- Connection quality ----------
// Every 2 seconds in a call: each connection's round trip, loss, jitter, what
// I send and whether it is relayed, into S.netq (js/lib/netquality.js).
async function pollQuality() {
  if (S.call?.status === 'live' && peers.size) {
    const cs = await cryptStats();
    let changed = false;
    for (const [u, p] of peers) {
      const e = e2eeOf(u, p, cs[u]);
      if (p.e2ee?.on !== e.on || p.e2ee?.why !== e.why) { p.e2ee = e; changed = true; }
    }
    if (changed) emit();
  }
  if (!S.call || S.call.status !== 'live' || !peers.size) { if (S.netq && Object.keys(S.netq).length) S.netq = {}; return; }
  const next = {};
  for (const [u, p] of peers) {
    if (p.pc.connectionState !== 'connected') continue;
    try {
      const report = await p.pc.getStats();
      p.q = summarize(report, p.q);
      p.camKbps = cameraKbps(p, report);
      next[u] = p.q;
      adapt(p, p.q);
    } catch { /* closed meanwhile */ }
  }
  const sum = (k) => Object.values(next).reduce((n, q) => n + (q[k] || 0), 0);
  next[S.me] = { sendKbps: Object.keys(next).length ? sum('sendKbps') : null, uplinkPoor: uplinkPoor(Object.values(next)) };
  const was = JSON.stringify(S.netq || {});
  S.netq = next;
  if (JSON.stringify(next) !== was) emit();
}
// Adaptive quality: a line losing packets or slow to answer steps its send
// caps down; a steady one steps back up (js/lib/callnet.js adaptStep).
function adapt(p, q) {
  const before = p.adapt.level;
  p.adapt = adaptStep(p.adapt, q);
  if (p.adapt.level !== before) capBitrate(p);
}
// How fast their camera really arrives here (kbit/s): data saver asked for
// none, but an older Snug on their side may send it anyway.
function cameraKbps(p, report) {
  const track = p.kinds.camera && p.video[p.kinds.camera]?.getVideoTracks()[0];
  if (!track) { p.camBytes = null; return 0; }
  let bytes = 0, at = 0;
  report.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === track.id) { bytes = r.bytesReceived || 0; at = r.timestamp || 0; } });
  const prev = p.camBytes;
  p.camBytes = { bytes, at };
  return prev && at > prev.at ? Math.round(((bytes - prev.bytes) * 8) / (at - prev.at)) : 0;
}
setInterval(pollQuality, 2000);

// Short-lived TURN credentials (server/voiceopts.js iceConfig) run out after
// an hour (calls C4). Every socket's hello brings fresh ones with when they
// run out (iceExp); a call fetches new ones before they do, for the
// connections it makes from then on, and before joining.
on('hello', (d) => {
  if (Array.isArray(d?.ice)) { S.ice = d.ice; S.iceExp = d.iceExp || null; }
  S.callE2ee = d?.callE2ee === 1; // the server passes on call keys (calls C1)
});
const iceSoon = () => !!S.iceExp && S.iceExp - Date.now() < 600_000;
setInterval(() => { if (S.call && iceSoon()) refreshIce(); }, 60_000);
// For the end-to-end checks: damage what I send to one person (their side must drop it), and the key ids in use.
export function tamperFrames(user, on = true) { crypt.worker?.postMessage({ t: 'tamper', peer: user, on }); }
export const cryptInfo = () => ({ mode: crypt.mode, why: crypt.why, key: crypt.key?.id ?? null, refused: [...crypt.refused] });
