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

// user -> { pc, audio, screenAudio, queue, stopLevel, polite, makingOffer,
//           ignoreOffer, settingAnswer, chain, kinds, video, tx }
const peers = new Map();
const pendingKinds = new Map(); // user -> what their streams are, heard before the connection
let mic = null;
let cam = null;      // my camera stream, while it is on
let screen = null;   // my screen stream, while I share
// What the others receive: one stream per kind for the whole call, so its id
// (which tells them camera from screen) stays the same when a camera goes off and on.
let out = null;
let ctx = null;
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
      const loud = Math.sqrt(sum / buf.length) > 6 && !(user === S.me && S.call?.muted);
      quietFor = loud ? 0 : quietFor + 1;
      const speaking = quietFor < 3;
      if (!!S.speaking[user] !== speaking) {
        S.speaking = { ...S.speaking };
        if (speaking) S.speaking[user] = true; else delete S.speaking[user];
        emit();
      }
    }, 120);
    return () => { clearInterval(tick); src.disconnect(); };
  } catch { return () => {}; }
}

function signal(to, data) { call('rtc', { to, data }).catch(() => {}); }

// Which of my streams is which. Sent before any track is added, so it reaches
// the other person before the offer that carries the track.
const myKinds = () => ({
  mic: mic?.id || null,
  camera: cam && out ? out.camera.id : null,
  screen: screen && out ? out.screen.id : null,
  screenAudio: screen && out ? out.screenAudio.id : null,
});
const tellKinds = (user) => signal(user, { kinds: myKinds() });

// Bitrate ceilings, lower as the mesh grows, so twelve cameras still fit.
function capBitrate(p) {
  const many = peers.size > 3;
  for (const [slot, max] of [['camera', many ? 450_000 : 900_000], ['screen', many ? 900_000 : 1_800_000]]) {
    const s = p.tx[slot]?.sender;
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
  const pc = new RTCPeerConnection({ iceServers: S.ice });
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
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
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
    audio.muted = !!S.call?.deaf;
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
  if (p.audio) { p.audio.srcObject = null; }
  if (p.screenAudio) { p.screenAudio.srcObject = null; }
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
  const p = peer(from, false);
  p.chain = p.chain.then(() => handleSignal(from, p, data));
});

// Someone left the room: close their connection.
on('voice', ({ room, users }) => {
  if (S.call?.room !== room) return;
  for (const u of [...peers.keys()]) if (!users.includes(u)) dropPeer(u);
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
// The server drops you from voice when the connection goes; say so instead of pretending.
on('close', () => {
  if (!S.call) return;
  const dm = S.call.dm;
  stop();
  toast(dm ? 'The call dropped because the connection did. Call again when you’re back.' : 'Voice disconnected because the connection dropped. Join again when you’re back.');
});

function stop() {
  for (const u of [...peers.keys()]) dropPeer(u);
  stopMyLevel?.();
  stopMyLevel = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  cam?.getTracks().forEach((t) => t.stop());
  cam = null;
  screen?.getTracks().forEach((t) => t.stop());
  screen = null;
  pendingKinds.clear();
  out = null;
  S.call = null;
  S.peers = {};
  S.speaking = {};
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
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    S.call = null;
    emit();
    toast(errText(e));
    return 'mic';
  }
  stopMyLevel = watchLevel(S.me, mic);
  try {
    S.call.status = 'joining';
    emit();
    const r = dm
      ? await call(start ? 'call.start' : 'call.join', { dm: room, video: !!video })
      : await call('voice.join', { room });
    if (S.call?.room !== room) return 'ok';
    S.call.status = 'live';
    S.call.id = r.call || null;
    emit();
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
  call('voice.leave').catch(() => {});
  stop();
}

function pushState() {
  if (!S.call) return;
  call('voice.state', { muted: S.call.muted, deaf: S.call.deaf, camera: !!S.call.camera, screen: !!S.call.screen }).catch(() => {});
}

export function toggleMute() {
  if (!S.call) return;
  S.call.muted = !S.call.muted;
  if (!S.call.muted) S.call.deaf = false;
  mic?.getAudioTracks().forEach((t) => { t.enabled = !S.call.muted; });
  for (const p of peers.values()) {
    if (p.audio) p.audio.muted = S.call.deaf;
    if (p.screenAudio) p.screenAudio.muted = S.call.deaf;
  }
  emit();
  pushState();
}

export function toggleDeaf() {
  if (!S.call) return;
  S.call.deaf = !S.call.deaf;
  if (S.call.deaf) S.call.muted = true;
  mic?.getAudioTracks().forEach((t) => { t.enabled = !S.call.muted; });
  for (const p of peers.values()) {
    if (p.audio) p.audio.muted = S.call.deaf;
    if (p.screenAudio) p.screenAudio.muted = S.call.deaf;
  }
  emit();
  pushState();
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

export async function toggleCamera() {
  const c = S.call;
  if (!c || c.status !== 'live' || c.cameraBusy) return;
  if (c.camera) { stopCamera(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser can’t use a camera here.'); return; }
  c.cameraBusy = true;
  emit();
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA });
  } catch (e) {
    // A camera that can't do 640x360 still beats no camera.
    if (e?.name === 'OverconstrainedError') {
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
  if (!canShareScreen()) { toast('This browser can’t share a screen.'); return; }
  c.screenBusy = true;
  emit();
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: true, // the system or tab sound, where the browser offers it
      systemAudio: 'include',
      surfaceSwitching: 'include',
    });
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
    let bytes = 0;
    (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived; });
    out[u] = {
      state: p.pc.connectionState, bytes, tx: p.pc.getTransceivers().length, screenSound: !!p.screenAudio?.srcObject?.getAudioTracks().length, glare: p.glare || 0,
      // The remote voice really playing: its element's clock moves on.
      audioTime: p.audio ? p.audio.currentTime : null, audioPaused: p.audio ? p.audio.paused : null,
    };
  }
  return out;
}
