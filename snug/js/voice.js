// Voice rooms over WebRTC. Audio goes directly between people (a full mesh,
// up to 12 in a room); the Snug server only passes the connection offers,
// answers and network candidates between them, and only between people in
// the same room.
//
// Whoever joins calls everyone already there; the people already there answer.
// That one rule means two people never offer to each other at the same time.
import { S, emit, toast } from './store.js';
import { call, on } from './server.js';

const peers = new Map();   // user -> { pc, audio, queue: [], stopLevel }
let mic = null;
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

function peer(user, offering) {
  let p = peers.get(user);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  p = { pc, audio: null, queue: [], stopLevel: null };
  peers.set(user, p);
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  pc.onicecandidate = (e) => { if (e.candidate) signal(user, { candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    if (p.audio) return;
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.autoplay = true;
    audio.muted = !!S.call?.deaf;
    audio.play().catch(() => {});
    p.audio = audio;
    p.stopLevel = watchLevel(user, e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    setPeerState(user, pc.connectionState);
    if (pc.connectionState === 'failed' && offering) pc.restartIce?.();
  };
  setPeerState(user, 'connecting');
  if (offering) {
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => signal(user, { sdp: pc.localDescription }))
      .catch(() => setPeerState(user, 'failed'));
  }
  return p;
}

function dropPeer(user) {
  const p = peers.get(user);
  if (!p) return;
  peers.delete(user);
  p.stopLevel?.();
  if (p.audio) { p.audio.srcObject = null; }
  p.pc.close();
  const next = { ...S.peers };
  delete next[user];
  S.peers = next;
  if (S.speaking[user]) { S.speaking = { ...S.speaking }; delete S.speaking[user]; }
  emit();
}

on('rtc', async ({ from, data }) => {
  if (!S.call || !mic) return;
  const p = peer(from, false);
  const { pc } = p;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of p.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        signal(from, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else p.queue.push(data.candidate);
    }
  } catch { setPeerState(from, 'failed'); }
});

// Someone left the room: close their connection.
on('voice', ({ room, users }) => {
  if (S.call?.room !== room) return;
  for (const u of [...peers.keys()]) if (!users.includes(u)) dropPeer(u);
});
on('voice.kicked', () => { if (S.call) { stop(); toast('You were disconnected from the voice room.'); } });
// The server drops you from voice when the connection goes; say so instead of pretending.
on('close', () => { if (S.call) { stop(); toast('Voice disconnected because the connection dropped. Join again when you’re back.'); } });

function stop() {
  for (const u of [...peers.keys()]) dropPeer(u);
  stopMyLevel?.();
  stopMyLevel = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  S.call = null;
  S.peers = {};
  S.speaking = {};
  emit();
}

export async function joinVoice(room) {
  if (S.call?.room === room) return;
  if (S.call) leaveVoice();
  if (S.conn.socket !== 'open') { toast('You’re offline, so you can’t join voice right now.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser can’t use a microphone here. Voice needs a secure (https) page.'); return; }
  S.call = { room, muted: false, deaf: false, status: 'mic' };
  emit();
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    S.call = null;
    emit();
    toast(errText(e));
    return;
  }
  stopMyLevel = watchLevel(S.me, mic);
  try {
    S.call.status = 'joining';
    emit();
    const r = await call('voice.join', { room });
    if (!S.call) return;
    S.call.status = 'live';
    emit();
    for (const u of r.peers) peer(u, true);
  } catch (e) {
    stop();
    toast(e.offline ? 'You’re offline, so you can’t join voice right now.' : e.message);
  }
}

export function leaveVoice() {
  if (!S.call) return;
  call('voice.leave').catch(() => {});
  stop();
}

function pushState() { call('voice.state', { muted: S.call.muted, deaf: S.call.deaf }).catch(() => {}); }

export function toggleMute() {
  if (!S.call) return;
  S.call.muted = !S.call.muted;
  if (!S.call.muted) S.call.deaf = false;
  mic?.getAudioTracks().forEach((t) => { t.enabled = !S.call.muted; });
  for (const p of peers.values()) if (p.audio) p.audio.muted = S.call.deaf;
  emit();
  pushState();
}

export function toggleDeaf() {
  if (!S.call) return;
  S.call.deaf = !S.call.deaf;
  if (S.call.deaf) S.call.muted = true;
  mic?.getAudioTracks().forEach((t) => { t.enabled = !S.call.muted; });
  for (const p of peers.values()) if (p.audio) p.audio.muted = S.call.deaf;
  emit();
  pushState();
}

// For the end-to-end checks: the live connection states and audio bytes received.
export async function voiceStats() {
  const out = {};
  for (const [u, p] of peers) {
    let bytes = 0;
    (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived; });
    out[u] = { state: p.pc.connectionState, bytes };
  }
  return out;
}
