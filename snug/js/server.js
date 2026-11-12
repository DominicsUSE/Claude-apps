// The transport. Everything that would cross the network goes through here:
// sending (with latency, queueing while offline, and failure), and everything
// other people do. There is no backend yet, so the other people are simulated.
// A real WebSocket client would replace this file and keep the same exports.
import { S, emit, isOnline, toast, jumpToMsg, welcomeDone, convMeta, membersOf } from './store.js';
import { uid } from './lib/util.js';
import { needsMe, levelOf, isThread } from './lib/attention.js';
import { plain, mentions } from './lib/format.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Outgoing
export function sendMessage(conv, text, { replyTo, files } = {}) {
  const m = { id: uid('m'), author: S.me, ts: Date.now(), text, state: 'sending' };
  if (replyTo) m.replyTo = replyTo;
  if (files?.length) m.files = files;
  (S.msgs[conv] ||= []).push(m);
  if (isThread(conv)) S.followed[conv] = true;
  delete S.ui.hold[conv];
  S.ui.marker[conv] = null;
  S.read[conv] = m.ts;
  delete S.drafts[conv];
  delete S.ui.reply[conv];
  attempt(conv, m);
  return m;
}

function attempt(conv, m) {
  if (!isOnline()) { m.state = 'queued'; emit(); return; }
  m.state = 'sending';
  emit();
  setTimeout(() => {
    if (!isOnline()) m.state = 'queued';
    else if (S.conn.simFail) m.state = 'failed';
    else { delete m.state; delivered(conv, m); }
    emit();
  }, rand(300, 650));
}

export const retry = (conv, m) => attempt(conv, m);

function flushQueue() {
  for (const conv of Object.keys(S.msgs)) for (const m of S.msgs[conv]) if (m.state === 'queued') attempt(conv, m);
}

export function setSimOffline(on) {
  S.conn.simOffline = on;
  emit();
  if (!on) flushQueue();
}
export function setSimFail(on) { S.conn.simFail = on; emit(); }

// Incoming
function visible(conv) {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
  const v = S.ui.view;
  return (v.type === 'conv' && v.id === conv) || S.ui.pane?.id === conv;
}

function receive(conv, author, text, extra = {}) {
  const m = { id: uid('m'), author, ts: Date.now(), text, ...extra };
  (S.msgs[conv] ||= []).push(m);
  const quiet = S.users[S.me].presence === 'focus' || !S.prefs.toasts || levelOf(S, conv) === 'muted';
  if (!visible(conv) && !quiet && needsMe(S, conv, m)) {
    const meta = convMeta(conv);
    const where = meta.kind === 'dm' ? '' : meta.kind === 'thread' ? `in a thread in ${meta.where}` : `in ${meta.title}`;
    toast(plain(text), { note: { user: author, where }, run: () => jumpToMsg(conv, m.id) });
  }
  emit();
  return m;
}

function typingThen(conv, author, ms, fn) {
  S.typing[conv] = [...new Set([...(S.typing[conv] || []), author])];
  emit();
  setTimeout(() => {
    S.typing[conv] = (S.typing[conv] || []).filter((u) => u !== author);
    fn();
    emit();
  }, ms);
}

const REPLIES = {
  ines: ['Wonderful, thank you.', 'I’ll put it on the list.', 'See you at the studio!'],
  tomasz: ['Fine by me.', 'Noted.', 'Before 2, or it waits for Saturday.'],
  priya: ['Ha, same.', 'Yes! I’ll be in from 6.', 'Saving that before I forget.'],
  jonas: ['Good. See you at the clock tower.', 'Noted. Bring lights.'],
  malik: ['Deal.', 'I’ll bring biscuits.'],
};
const GENERIC = ['Sounds good.', 'Got it, thanks.', 'Let me check and get back to you.'];
const ACKS = ['On it.', 'Yes, will do.', 'Good question. Give me a minute.', 'Noted, thanks.'];
const REACTS = ['👍', '❤️', '😂', '🙌', '👀'];
const turn = {};
const reachable = (u) => ['open', 'around', 'focus'].includes(S.users[u]?.presence);

// What happens after one of my messages lands.
function delivered(conv, m) {
  const meta = convMeta(conv);
  if (!meta) return;
  if (meta.house && S.houses[meta.house].newcomer) welcomeDone(meta.house);

  const others = membersOf(conv).filter((u) => u !== S.me && reachable(u));
  if (!others.length) return;

  if (meta.dm) {
    const who = pick(meta.others.filter(reachable));
    if (!who) return;
    const pool = REPLIES[who] || GENERIC;
    turn[who] = (turn[who] || 0) + 1;
    setTimeout(() => typingThen(conv, who, rand(1400, 2600), () => receive(conv, who, pool[turn[who] % pool.length])), rand(900, 1800));
    return;
  }
  const named = others.find((u) => mentions(m.text, S.users[u].handle));
  if (named) {
    setTimeout(() => typingThen(conv, named, rand(1500, 2800), () => receive(conv, named, pick(ACKS), { replyTo: m.id })), rand(1500, 3000));
  } else if (Math.random() < 0.5) {
    setTimeout(() => {
      const who = pick(others);
      const all = (m.reactions ||= {});
      const e = pick(REACTS);
      (all[e] ||= []).push(who);
      emit();
    }, rand(2500, 6000));
  }
}

// Ambient conversation, so the place is alive while you look at it.
const SCRIPT = [
  ['k_floor', 'priya', 'Leaving the Giffin grip on wheel 3 for whoever’s next.'],
  ['r_plans', 'bex', 'What does the café take, card only?'],
  ['k_glaze', 'farid', 'That explains a lot, thank you. So the pyrometer is lying to me?'],
  ['r_plans', 'jonas', 'Card only. And the kitchen closes at 2.'],
  ['k_glaze', 'tomasz', 'It isn’t lying. It measures temperature. Cones measure what the heat actually did.'],
  ['d_priya', 'priya', 'Are you coming in tonight? I’m trimming from 6.'],
  ['k_floor', 'dara', 'Kettle’s on in the back if anyone wants tea.'],
  ['k_firing', 'ines', '@robin can you bring your work by 10 on Saturday? Loading takes a while.'],
  ['k_floor', 'lea', 'Is it normal that my hands are this dry? Asking for my hands.'],
  ['k_floor', 'ines', 'Completely normal. Hand cream by the sink. Welcome to the club.'],
  ['r_workshop', 'callum', 'Every three months? I topped mine up in spring. Which spring, I couldn’t say.'],
  ['k_show', 'dara', 'Moon jar is drying. It has opinions about staying round.'],
];
let step = 0;

function ambient() {
  if (step >= SCRIPT.length) return;
  const delay = step === 0 ? 7000 : rand(11000, 21000);
  setTimeout(() => {
    if (document.visibilityState !== 'visible' || !isOnline()) return ambient();
    const [conv, who, text] = SCRIPT[step++];
    const room = S.rooms[conv];
    const there = room ? S.houses[room.house]?.joined : !!S.dms[conv];
    if (there) typingThen(conv, who, rand(1800, 3200), () => receive(conv, who, text));
    ambient();
  }, delay);
}

function speaking() {
  setInterval(() => {
    const next = {};
    const watching = S.call || (S.ui.view.type === 'conv' && S.rooms[S.ui.view.id]?.kind === 'voice');
    if (watching) {
      for (const room of Object.keys(S.voice)) {
        const people = S.voice[room].filter((u) => u !== S.me);
        if (people.length && Math.random() < 0.7) next[pick(people)] = true;
      }
    }
    const a = Object.keys(S.speaking).join(), b = Object.keys(next).join();
    if (a !== b) { S.speaking = next; emit(); }
  }, 900);
}

function drift() {
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const movable = Object.values(S.users).filter((u) => u.id !== S.me && ['around', 'away'].includes(u.presence));
    const u = pick(movable);
    if (u) { u.presence = u.presence === 'around' ? 'away' : 'around'; emit(); }
  }, 45000);
}

export function startServer() {
  window.addEventListener('online', () => { S.conn.online = true; emit(); flushQueue(); });
  window.addEventListener('offline', () => { S.conn.online = false; emit(); });
  ambient();
  speaking();
  drift();
  if (isOnline()) flushQueue();
}
