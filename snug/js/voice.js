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
import { S, emit, toast } from './store.js';
import { call, on } from './server.js';
// Devices, input mode, processing, per-person volume, soundboard mixing (js/voiceopts.js).
import {
  getMic, outgoing, swapMic, stopOutgoing, gate, micOpen, tuneAudio, forgetAudio, boostOf, onRetune, cue, vp,
  cameraConstraints, screenConstraints, screenBitrate, roomBitrate, audioCtx, meter, cameraBase,
} from './voiceopts.js';
// Connection quality from WebRTC's statistics (js/lib/netquality.js).
import { summarize, uplinkPoor } from './lib/netquality.js';

// user -> { pc, audio, screenAudio, queue, stopLevel, polite, makingOffer,
//           ignoreOffer, settingAnswer, chain, kinds, video, tx }
const peers = new Map();
const pendingKinds = new Map(); // user -> what their streams are, heard before the connection
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

// Which of my streams is which. Sent before any track is added, so it reaches
// the other person before the offer that carries the track.
const myKinds = () => ({
  mic: (send || mic)?.id || null,
  camera: cam && out ? out.camera.id : null,
  screen: screen && out ? out.screen.id : null,
  screenAudio: screen && out ? out.screenAudio.id : null,
});
const tellKinds = (user) => signal(user, { kinds: myKinds() });

// Bitrate ceilings, lower as the mesh grows, so twelve cameras still fit.
function capBitrate(p) {
  const many = peers.size > 3;
  // The voice follows the room's bitrate (js/voiceopts.js); a screen share its chosen quality.
  const voiceSender = p.pc.getSenders().find((x) => x.track && x.track.kind === 'audio' && send && send.getAudioTracks().includes(x.track));
  for (const [slot, max] of [['camera', many ? 450_000 : 900_000], ['screen', screenBitrate(many)], ['voice', roomBitrate()]]) {
    const s = slot === 'voice' ? voiceSender : p.tx[slot]?.sender;
    if (!s?.track) continue;
    try {
      const prm = s.getParameters();
      if (!prm.encodings?.length) continue;
      if (prm.encodings[0].maxBitrate === max) continue;
      prm.encodings[0].maxBitrate = max;
      s.setParameters(prm).catch(() => {});
    } catch { /* not supported here: the browser picks */ }
  }
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

function peer(user, offering) {
  let p = peers.get(user);
  if (p) return p;
  // p2p: registry TURN credentials near their end are refreshed for the next connection (F10), and with
  // "Hide my IP" on and a TURN server known, calls go only through the relay (S14).
  if (S.iceExp && S.iceExp - Date.now() < 600_000) call('ice.refresh').then((r) => { if (Array.isArray(r?.ice)) { S.ice = r.ice; S.iceExp = r.iceExp || null; } }).catch(() => {});
  const hideIp = !!S.p2p?.hideIp && (S.ice || []).some((s) => [].concat(s.urls || []).some((u) => /^turns?:/.test(u)));
  const pc = new RTCPeerConnection({ iceServers: S.ice, ...(hideIp ? { iceTransportPolicy: 'relay' } : {}) });
  p = {
    pc, audio: null, screenAudio: null, queue: [], stopLevel: null,
    polite: String(S.me) > String(user), makingOffer: false, ignoreOffer: false, settingAnswer: false,
    chain: Promise.resolve(), kinds: pendingKinds.get(user) || {}, video: {}, tx: {},
  };
  pendingKinds.delete(user);
  peers.set(user, p);
  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      signal(user, { sdp: pc.localDescription });
    } catch { /* a newer negotiation replaced this one */ } finally { p.makingOffer = false; }
  };
  tellKinds(user);
  (send || mic).getTracks().forEach((t) => pc.addTrack(t, send || mic));
  // Late joiners get whatever I am already showing.
  if (cam) sendOn(p, 'camera', cam.getVideoTracks()[0], out.camera);
  if (screen) {
    sendOn(p, 'screen', screen.getVideoTracks()[0], out.screen);
    if (screen.getAudioTracks()[0]) sendOn(p, 'screenAudio', screen.getAudioTracks()[0], out.screenAudio);
  }
  pc.onicecandidate = (e) => { if (e.candidate) signal(user, { candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
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
  pc.onconnectionstatechange = () => {
    setPeerState(user, pc.connectionState);
    if (pc.connectionState === 'connected') capBitrate(p);
    if (pc.connectionState === 'failed' && offering) pc.restartIce?.();
  };
  setPeerState(user, 'connecting');
  return p;
}

function dropPeer(user) {
  const p = peers.get(user);
  if (!p) return;
  peers.delete(user);
  p.stopLevel?.();
  if (p.audio) { forgetAudio(p.audio); p.audio.srcObject = null; }
  if (p.screenAudio) { forgetAudio(p.screenAudio); p.screenAudio.srcObject = null; }
  p.pc.close();
  const next = { ...S.peers };
  delete next[user];
  S.peers = next;
  if (S.speaking[user]) { S.speaking = { ...S.speaking }; delete S.speaking[user]; }
  emit();
}

// Signals from one person are handled one at a time, in the order they came.
async function handleSignal(from, p, data) {
  const { pc } = p;
  if (peers.get(from) !== p) return; // they left while this waited
  try {
    if (data.sdp) {
      const desc = data.sdp;
      const ready = !p.makingOffer && (pc.signalingState === 'stable' || p.settingAnswer);
      const collision = desc.type === 'offer' && !ready;
      if (collision) p.glare = (p.glare || 0) + 1;
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      p.settingAnswer = desc.type === 'answer';
      await pc.setRemoteDescription(desc); // a polite peer rolls its own offer back here
      p.settingAnswer = false;
      for (const c of p.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        signal(from, { sdp: pc.localDescription });
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
  if (!S.call || !mic || !data || typeof data !== 'object') return;
  if (data.kinds) {
    const k = { mic: data.kinds.mic || null, camera: data.kinds.camera || null, screen: data.kinds.screen || null, screenAudio: data.kinds.screenAudio || null };
    const p = peers.get(from);
    if (p) { p.kinds = k; emit(); } else pendingKinds.set(from, k);
    return;
  }
  if (!data.sdp && !data.candidate) return;
  // A fresh offer on a connection that already failed: they came back, start again.
  const old = peers.get(from);
  if (old && data.sdp?.type === 'offer' && ['failed', 'closed'].includes(old.pc.connectionState)) dropPeer(from);
  const p = peer(from, false);
  p.chain = p.chain.then(() => handleSignal(from, p, data));
});

// Someone left the room: close their connection. Someone whose connection
// dropped (held by the server, shown as reconnecting) is closed too: they
// call everyone again when they are back.
on('voice', ({ room, users, state }) => {
  if (S.call?.room !== room) return;
  for (const u of [...peers.keys()]) if (!users.includes(u) || state?.[u]?.reconnecting) dropPeer(u);
  for (const u of [...pendingKinds.keys()]) if (!users.includes(u)) pendingKinds.delete(u);
});
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
// call stays, with my microphone, camera and screen, while the connections to
// the others close; when the socket is back I join the same place again and
// call everyone afresh. If that fails, or takes too long, the call ends.
export const RECONNECT_MS = 20_000;
let reconnectTimer = null;
const droppedText = (dm) => (dm ? 'The call dropped because the connection did. Call again when you’re back.' : 'Voice disconnected because the connection dropped. Join again when you’re back.');
on('close', () => {
  if (!S.call) return;
  const c = S.call;
  if (c.status !== 'live' && c.status !== 'reconnecting') { stop(); toast(droppedText(c.dm)); return; }
  c.status = 'reconnecting';
  for (const u of [...peers.keys()]) dropPeer(u);
  pendingKinds.clear();
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
    for (const u of r.peers) peer(u, true);
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
  out = null;
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
// once connected. Resolves to how it went: 'ok' (in, or already in),
// 'mic' (no microphone: the server was told nothing), 'offline' or 'error'
// (already said in a toast).
export async function joinVoice(room, { start = false, video = false } = {}) {
  if (S.call?.room === room) { if (video && !S.call.camera && S.call.status === 'live') toggleCamera(); return 'ok'; }
  const dm = !!S.dms[room];
  if (S.call) leaveVoice();
  const what = dm ? 'call' : 'join voice';
  if (S.conn.socket !== 'open') { toast(`You’re offline, so you can’t ${what} right now.`); return 'offline'; }
  if (!navigator.mediaDevices?.getUserMedia) { toast(`This browser can’t use a microphone here. ${dm ? 'Calls need' : 'Voice needs'} a secure (https) page.`); return 'mic'; }
  if (S.callEnd?.dm === room) S.callEnd = null;
  S.call = { room, dm, muted: false, deaf: false, camera: false, screen: false, status: 'mic', video: !!video };
  // The screen's sound goes in its own stream, so adding it never restarts the picture.
  out = { camera: new MediaStream(), screen: new MediaStream(), screenAudio: new MediaStream() };
  emit();
  try {
    mic = await getMic();
    send = await outgoing(mic);
  } catch (e) {
    mic?.getTracks().forEach((t) => t.stop());
    mic = null;
    S.call = null;
    emit();
    toast(errText(e));
    return 'mic';
  }
  stopMyLevel = watchLevel(S.me, mic);
  watchMic(mic);
  try {
    S.call.status = 'joining';
    emit();
    const r = dm
      ? await call(start ? 'call.start' : 'call.join', { dm: room, video: !!video })
      : await call('voice.join', { room });
    if (S.call?.room !== room) return 'ok';
    S.call.status = 'live';
    S.call.id = r.call || null;
    S.call.joinedAt = Date.now(); // the call clock in a voice room (js/views/activities.js CallTimer)
    emit();
    cue('join');
    for (const u of r.peers) peer(u, true);
    if (video) toggleCamera();
    return 'ok';
  } catch (e) {
    stop();
    toast(e.offline ? `You’re offline, so you can’t ${what} right now.` : e.message);
    return 'error';
  }
}

export function leaveVoice() {
  if (!S.call) return;
  const live = S.call.status === 'live';
  call('voice.leave').catch(() => {});
  stop();
  if (live) cue('leave');
}

function pushState() {
  if (!S.call) return;
  call('voice.state', { muted: S.call.muted, deaf: S.call.deaf, camera: !!S.call.camera, screen: !!S.call.screen }).catch(() => {});
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
  try { track.contentHint = 'detail'; } catch { /* hint only */ }
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
  return { camera: pick(p.kinds.camera), screen: pick(p.kinds.screen) };
}

// For the end-to-end checks: the live connection states and audio bytes received.
export async function voiceStats() {
  const out = {};
  for (const [u, p] of peers) {
    let bytes = 0, energy = 0;
    (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') { bytes += r.bytesReceived; energy += r.totalAudioEnergy || 0; } });
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
  if (!S.call || S.call.status !== 'live' || !peers.size) { if (S.netq && Object.keys(S.netq).length && !S.call) S.netq = {}; return; }
  const next = {};
  for (const [u, p] of peers) {
    if (p.pc.connectionState !== 'connected') continue;
    try { p.q = summarize(await p.pc.getStats(), p.q); next[u] = p.q; } catch { /* closed meanwhile */ }
  }
  const sum = (k) => Object.values(next).reduce((n, q) => n + (q[k] || 0), 0);
  next[S.me] = { sendKbps: Object.keys(next).length ? sum('sendKbps') : null, uplinkPoor: uplinkPoor(Object.values(next)) };
  const was = JSON.stringify(S.netq || {});
  S.netq = next;
  if (JSON.stringify(next) !== was) emit();
}
setInterval(pollQuality, 2000);

// Short-lived TURN credentials (server/voiceopts.js iceConfig) run out after
// 12 hours; a long call asks for fresh ones every 6, for the connections it
// makes from then on. Every new socket's hello brings fresh ones too.
setInterval(() => {
  if (!S.call || !(S.ice || []).some((s) => typeof s.username === 'string' && /^\d+:/.test(s.username))) return;
  call('ice.refresh').then((r) => { if (Array.isArray(r?.ice)) S.ice = r.ice; }).catch(() => {});
}, 6 * 3600_000);
