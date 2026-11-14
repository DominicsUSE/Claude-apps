// Voice and calls on screen, beyond the basic stage: the activity tile (a
// shared whiteboard, tic-tac-toe, Connect Four) in the focus slot, the
// Activities and reactions buttons, reactions floating up from tiles, the
// "You're muted" note, the call clock, "Voice connected" with each person's
// real connection quality, and ringing people again in a group call.
// State and server calls: js/activities.js and js/voice.js.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, person, openPop, openMenu, toast } from '../store.js';
import { call } from '../server.js';
import { Icon, addIcons } from '../ui/icons.js';
import { Avatar } from '../ui/kit.js';
import { can } from '../lib/perms.js';
import { toggleMute, dismissMutedWarn } from '../voice.js';
import { act, startActivity, stopActivity, react } from '../activities.js';
import { BOARD_COLOURS, BOARD_WIDTHS, BOARD_LIMITS, VOICE_REACTIONS, GAMES } from '../lib/games.js';
import { QUALITY_LABEL, callClock, callClockWords } from '../lib/netquality.js';

addIcons({
  'act-play': 'M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 13.5Z|M8 8.5v3|M6.5 10h3|M12 9v.2|M13.5 11v.2',
  'act-board': 'M3.5 4.5h13v9h-13z|M10 13.5V16|M7 16h6|M6.5 10.5l2-2 2 1.5 3-3',
  'act-download': 'M10 3.5v9|M6.5 9l3.5 3.5L13.5 9|M4 16h12',
  'act-ring': 'M6 3.5h2l1 3-1.5 1a8 8 0 0 0 5 5l1-1.5 3 1v2A1.5 1.5 0 0 1 15 16 11.5 11.5 0 0 1 4.5 5.5 1.5 1.5 0 0 1 6 3.5Z|M12.5 3.5a4 4 0 0 1 4 4|M12.5 6a1.5 1.5 0 0 1 1.5 1.5',
});

const first = (id) => (id === S.me ? 'You' : person(id).name.split(' ')[0]);
const rectOf = (e) => e.currentTarget.getBoundingClientRect();
const ACT_NAME = { board: 'Whiteboard', ttt: GAMES.ttt.name, c4: GAMES.c4.name };

// ---------- Stage controls: Activities and reactions ----------
function activitiesMenu(e) {
  const room = S.call?.room;
  const a = S.activity[room];
  openMenu({
    anchor: rectOf(e), align: 'start',
    items: [
      { heading: 'Do something together' },
      { label: 'Whiteboard', icon: 'act-board', checked: a?.kind === 'board', onSelect: () => a?.kind !== 'board' && startActivity('board') },
      { label: 'Tic-tac-toe', checked: a?.kind === 'ttt', onSelect: () => a?.kind !== 'ttt' && startActivity('ttt') },
      { label: 'Connect Four', checked: a?.kind === 'c4', onSelect: () => a?.kind !== 'c4' && startActivity('c4') },
      ...(a ? [{ sep: true }, { label: `Stop ${ACT_NAME[a.kind].toLowerCase()}`, icon: 'x', onSelect: stopActivity }] : []),
    ],
  });
}

function ReactPicker({ room }) {
  const house = S.rooms[room]?.house;
  const custom = house ? (S.emoji?.[house] || []).slice(0, 8) : [];
  const send = (emoji) => { react(emoji); };
  return html`<div class="act-react" role="group" aria-label="Send a reaction to everyone in the call">
    <div class="act-react-grid">
      ${VOICE_REACTIONS.map((e, i) => html`<button key=${e} class="act-react-btn" data-autofocus=${i === 0 ? '' : undefined} aria-label=${`React ${e}`} onClick=${() => send(e)}>${e}</button>`)}
      ${custom.map((e) => html`<button key=${e.id} class="act-react-btn" aria-label=${`React :${e.name}:`} onClick=${() => send(`<:${e.name}:${e.id}>`)}><img src=${`/api/files/${e.file}`} alt="" width="24" height="24" /></button>`)}
    </div>
    <p class="act-note">Everyone in the call sees it float up from your tile.</p>
  </div>`;
}

export function ActivityButtons({ compact }) {
  const c = S.call;
  if (!c || c.status !== 'live' || compact) return null;
  const a = S.activity[c.room];
  return html`
    <button class=${`ib vc act-btn${a ? ' running' : ''}`} aria-label=${a ? `Activities: ${ACT_NAME[a.kind]} is running` : 'Activities'} data-tip="Activities" aria-haspopup="menu" onClick=${activitiesMenu}><${Icon} name="act-play" size=${20} /></button>
    <button class="ib vc act-react-open" aria-label="React" data-tip="React" aria-haspopup="dialog"
      onClick=${(e) => openPop({ anchor: rectOf(e), label: 'React', C: ReactPicker, props: { room: c.room } })}><${Icon} name="smile" size=${20} /></button>`;
}

// ---------- Reactions floating up ----------
export function ReactionFloat({ id, room }) {
  const list = (S.vreacts || []).filter((r) => r.user === id && r.place === room);
  if (!list.length) return null;
  return html`<span class="act-floats" aria-hidden="true">
    ${list.map((r, i) => html`<span key=${r.id} class="act-float" style=${`--i:${i % 4}`}>${r.custom ? html`<img src=${`/api/files/${r.custom.file}`} alt="" width="28" height="28" />` : r.emoji}</span>`)}
  </span>`;
}
// One polite live region for the stage: moves, reactions, an activity starting.
export function ActivityAnnouncer() {
  return html`<span class="sr" role="status" aria-live="polite">${S.actSay || ''}</span>`;
}

// ---------- "You're muted" ----------
export function MutedBanner() {
  const c = S.call;
  const show = !!(c && c.muted && S.mutedWarn);
  return html`<div class="act-muted-live" aria-live="polite">${show && html`<div class="act-muted" role="status">
    <${Icon} name="mic-off" size=${16} />
    <span class="grow"><b>You’re muted.</b> Nobody can hear you.</span>
    <button class="btn act-unmute" onClick=${() => { dismissMutedWarn(); if (S.call?.muted) toggleMute(); }}>Unmute</button>
    <button class="ib sm" aria-label="Dismiss" data-tip="Dismiss" onClick=${dismissMutedWarn}><${Icon} name="x" size=${16} /></button>
  </div>`}</div>`;
}

// ---------- The call clock ----------
// When the call started: a direct call's answer (or start), else when I joined the room.
export function callStart(room) {
  const meta = S.calls[room];
  if (meta) return meta.answered || meta.started || null;
  return S.call?.room === room ? S.call.joinedAt || null : null;
}
export function CallTimer({ room }) {
  const [, tick] = useState(0);
  const start = callStart(room);
  useEffect(() => {
    if (!start) return undefined;
    // Ticks only while the page is visible.
    let t = null;
    const run = () => { clearInterval(t); t = null; if (document.visibilityState === 'visible') t = setInterval(() => tick((n) => n + 1), 1000); };
    run();
    document.addEventListener('visibilitychange', run);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', run); };
  }, [start]);
  if (!start) return null;
  const ms = Date.now() - start;
  return html`<span class="act-timer num" role="timer" aria-live="off" aria-label=${`In the call for ${callClockWords(ms)}`}><span aria-hidden="true">${callClock(ms)}</span></span>`;
}

// ---------- Connection quality ----------
const RANK = { good: 0, fair: 1, poor: 2 };
// The bars beside one person: measured quality once connected, else the connection's state.
export function qualityOf(id) {
  const st = S.peers[id];
  if (S.voiceState[S.call?.room]?.[id]?.reconnecting) return 'wait';
  if (st === 'failed') return 'poor';
  if (st === 'disconnected') return 'fair';
  if (st !== 'connected') return 'wait';
  return S.netq?.[id]?.quality || 'good';
}
export const QLABEL = { ...QUALITY_LABEL, wait: 'Connecting' };
export function Bars({ q, label }) {
  return html`<span class=${`stage-q act-q ${q}`} role="img" aria-label=${label || QLABEL[q]} data-tip=${label || QLABEL[q]}><i></i><i></i><i></i></span>`;
}

function QualityPop({ room }) {
  const ids = (S.voice[room] || []).filter((id) => id !== S.me && S.users[id]);
  const mine = S.netq?.[S.me] || {};
  const n = (v, unit) => (v == null ? '…' : `${v}${unit}`);
  return html`<div class="act-qpop">
    <b class="act-qpop-title">Connection</b>
    ${ids.length
      ? html`<table class="act-qtable">
          <thead><tr><th scope="col">Person</th><th scope="col">Ping</th><th scope="col">Loss</th><th scope="col">Jitter</th><th scope="col">Route</th></tr></thead>
          <tbody>${ids.map((id) => {
            const q = S.netq?.[id] || {};
            return html`<tr key=${id}>
              <th scope="row"><span class="act-qwho"><${Bars} q=${qualityOf(id)} /><span class="trunc">${first(id)}</span></span></th>
              <td class="num">${n(q.rtt, ' ms')}</td><td class="num">${n(q.loss, '%')}</td><td class="num">${n(q.jitter, ' ms')}</td>
              <td>${q.relay == null ? '…' : q.relay ? 'Relayed' : 'Direct'}</td>
            </tr>`;
          })}</tbody>
        </table>`
      : html`<p class="act-note">Nobody else is here yet, so there’s nothing to measure.</p>`}
    <p class="act-note">You’re sending <span class="num">${mine.sendKbps == null ? '…' : `${mine.sendKbps} kbit/s`}</span>.</p>
    ${mine.uplinkPoor && html`<p class="act-hint" role="note">Your connection is struggling, so others may hear you break up. Turning your camera off, or moving closer to your router, can help.</p>`}
  </div>`;
}
// "Voice connected", with the worst connection's bars; click for everyone's numbers.
export function ConnHeader({ room }) {
  const ids = (S.voice[room] || []).filter((id) => id !== S.me);
  const qs = ids.map(qualityOf).filter((q) => q in RANK);
  const worst = qs.length ? qs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : null;
  const poorMe = S.netq?.[S.me]?.uplinkPoor;
  const label = `Voice connected${worst ? `. ${QUALITY_LABEL[worst]}` : ''}. Show connection details`;
  return html`<button class=${`stage-conn ok act-conn${worst ? ` q-${worst}` : ''}`} aria-haspopup="dialog" aria-label=${label}
    onClick=${(e) => openPop({ anchor: rectOf(e), label: 'Connection', C: QualityPop, props: { room } })}>
    <i aria-hidden="true"></i>Voice connected${worst && html`<${Bars} q=${worst} />`}
    ${poorMe && html`<span class="act-uplink">Your connection is weak</span>`}
  </button>`;
}

// ---------- Ringing people again ----------
// In a group call: the people in the conversation who aren't in the call and
// aren't being rung (they declined, or didn't answer) get a Ring button.
export function RingAgain({ room }) {
  const dm = S.dms[room];
  const meta = S.calls[room];
  if (!dm || !meta?.group || S.call?.room !== room || S.call.status !== 'live') return null;
  const inCall = S.voice[room] || [];
  const away = dm.members.filter((id) => id !== S.me && S.users[id] && !inCall.includes(id) && !meta.ringing.includes(id));
  if (!away.length) return null;
  const ring = (id) => call('call.ring', { dm: room, user: id }).catch((e) => toast(e.offline ? 'You’re offline, so the ring didn’t go.' : e.message));
  return html`<div class="act-away" role="group" aria-label="Not in the call">
    <span class="act-away-label">Not in the call</span>
    ${away.map((id) => html`<span class="act-away-person" key=${id}>
      <${Avatar} user=${S.users[id]} size=${24} dim />
      <span class="trunc">${first(id)}</span>
      <button class="btn act-ring" aria-label=${`Ring ${S.users[id].name} again`} onClick=${() => ring(id)}><${Icon} name="act-ring" size=${16} />Ring</button>
    </span>`)}
  </div>`;
}

// ---------- The activity tile ----------
export function ActivityTile({ room }) {
  const a = S.activity?.[room];
  if (!a || S.call?.room !== room || S.call.status !== 'live') return null;
  return html`<section class=${`act-tile act-${a.kind}`} aria-label=${ACT_NAME[a.kind]}>
    <header class="act-head">
      <${Icon} name=${a.kind === 'board' ? 'act-board' : 'act-play'} size=${16} />
      <b>${ACT_NAME[a.kind]}</b>
      <span class="faint trunc">Started by ${first(a.by)}</span>
      <button class="ib sm act-stop" aria-label=${`Stop the ${ACT_NAME[a.kind].toLowerCase()}`} data-tip="Stop" onClick=${stopActivity}><${Icon} name="x" size=${16} /></button>
    </header>
    ${a.kind === 'board' ? html`<${Board} a=${a} />` : html`<${Game} a=${a} />`}
  </section>`;
}

// ---------- Whiteboard ----------
const TOKEN = { ink: '--text-1', mint: '--mint', amber: '--amber', cyan: '--cyan', rose: '--rose' };
const COLOUR_NAME = { ink: 'Ink', mint: 'Mint', amber: 'Amber', cyan: 'Cyan', rose: 'Rose' };
const tokenColour = (name) => getComputedStyle(document.documentElement).getPropertyValue(TOKEN[name] || '--text-1').trim() || '#ddd';
let tool = { colour: 'ink', width: 2 }; // kept between openings

// Down to at most 256 points, keeping the first and last.
export function thin(points, max = BOARD_LIMITS.points) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

function paint(canvas, strokes, extra = [], background = null) {
  const w = canvas.width, h = canvas.height;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (background) { g.fillStyle = background; g.fillRect(0, 0, w, h); }
  g.lineCap = 'round'; g.lineJoin = 'round';
  const scale = w / 640;
  const colours = {};
  for (const s of [...strokes, ...extra]) {
    g.strokeStyle = colours[s.colour] ||= tokenColour(s.colour);
    g.lineWidth = Math.max(1, s.width * 2 * scale);
    g.beginPath();
    s.points.forEach(([x, y], i) => (i ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h)));
    if (s.points.length === 1) g.lineTo(s.points[0][0] * w + 0.01, s.points[0][1] * h);
    g.stroke();
  }
}

function Board({ a }) {
  const canvas = useRef();
  const live = useRef(null);      // the stroke being drawn
  const pending = useRef([]);     // sent, not yet back from the server
  const [, rerender] = useState(0);
  const draw = () => {
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ids = new Set(a.strokes.map((s) => s.key).filter(Boolean));
    paint(c, a.strokes, [...pending.current.filter((p) => !ids.has(p.key)), ...(live.current ? [live.current] : [])]);
  };
  useEffect(draw);
  useEffect(() => {
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
    ro?.observe(canvas.current);
    return () => ro?.disconnect();
  }, []);
  const at = (e) => {
    const r = canvas.current.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const down = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    canvas.current.setPointerCapture?.(e.pointerId);
    live.current = { colour: tool.colour, width: tool.width, points: [at(e)] };
    draw();
  };
  const move = (e) => {
    const s = live.current;
    if (!s) return;
    const p = at(e), q = s.points[s.points.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.003) return;
    s.points.push(p);
    draw();
  };
  const up = async () => {
    const s = live.current;
    live.current = null;
    if (!s) return;
    const stroke = { ...s, points: thin(s.points), key: Math.random().toString(36).slice(2) };
    pending.current.push(stroke);
    draw();
    await act('board.stroke', { points: stroke.points, colour: stroke.colour, width: stroke.width });
    pending.current = pending.current.filter((p) => p !== stroke);
    draw();
  };
  const exportPng = () => {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    paint(c, a.strokes, [], getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim() || '#1b1c1e');
    c.toBlob((blob) => {
      if (!blob) { toast('Couldn’t make the picture.'); return; }
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), { href: url, download: 'snug-whiteboard.png' });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  };
  const setTool = (patch) => { tool = { ...tool, ...patch }; rerender((n) => n + 1); };
  const room = S.rooms[S.call?.room];
  const mayClear = a.by === S.me || !(S.voice[S.call?.room] || []).includes(a.by) || (!!room && (can(S, room.house, 'voicemod') || !!room.perms?.manage));
  const n = a.strokes.length;
  return html`<div class="act-board-body">
    <div class="act-tools" role="toolbar" aria-label="Whiteboard tools">
      <div class="act-swatches" role="radiogroup" aria-label="Colour">
        ${BOARD_COLOURS.map((c) => html`<button key=${c} class=${`act-swatch sw-${c}`} role="radio" aria-checked=${String(tool.colour === c)} aria-label=${COLOUR_NAME[c]} data-tip=${COLOUR_NAME[c]} onClick=${() => setTool({ colour: c })}><span></span></button>`)}
      </div>
      <div class="act-widths" role="radiogroup" aria-label="Pen size">
        ${BOARD_WIDTHS.map((w) => html`<button key=${w} class="act-width" role="radio" aria-checked=${String(tool.width === w)} aria-label=${`Pen size ${w}`} data-tip=${`Size ${w}`} onClick=${() => setTool({ width: w })}><span style=${`--w:${w * 2 + 1}px`}></span></button>`)}
      </div>
      <span class="grow"></span>
      <button class="ib act-tool" aria-label="Undo your last stroke" data-tip="Undo" onClick=${() => act('board.undo')}><${Icon} name="undo" size=${18} /></button>
      ${mayClear && html`<button class="ib act-tool" aria-label="Clear the whiteboard" data-tip="Clear" disabled=${!n} onClick=${() => act('board.clear')}><${Icon} name="trash" size=${18} /></button>`}
      <button class="ib act-tool" aria-label="Save the whiteboard as a picture" data-tip="Export PNG" disabled=${!n} onClick=${exportPng}><${Icon} name="act-download" size=${18} /></button>
    </div>
    <div class="act-canvas-wrap">
      <canvas class="act-canvas" ref=${canvas} role="img" aria-roledescription="whiteboard"
        aria-label=${n ? `Shared whiteboard with ${n} ${n === 1 ? 'stroke' : 'strokes'}. Draw with a mouse, finger or pen.` : 'Shared whiteboard, empty. Draw with a mouse, finger or pen.'}
        data-strokes=${n}
        onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}></canvas>
      ${!n && !pending.current.length && html`<p class="act-empty" aria-hidden="true">Nothing here yet. Draw, and everyone in the call sees it.</p>`}
    </div>
    ${n >= BOARD_LIMITS.strokes && html`<p class="act-hint" role="status">The whiteboard is full. Clear it to keep drawing.</p>`}
  </div>`;
}

// ---------- Games ----------
function Seat({ g, seat }) {
  const id = g.seats[seat];
  const turn = !g.result && !g.seats.includes(null) && g.turn === seat;
  const won = g.result?.winner === seat;
  const piece = g.kind === 'ttt' ? (seat ? 'O' : 'X') : '';
  if (!id) {
    const mine = g.seats.includes(S.me);
    return html`<span class="act-seat empty">
      <span class="act-seat-face" aria-hidden="true"></span>
      ${mine ? html`<span class="faint">Waiting for a player</span>` : html`<button class="btn act-sit" onClick=${() => act('game.join')}>Take this seat</button>`}
    </span>`;
  }
  return html`<span class=${`act-seat${turn ? ' turn' : ''}${won ? ' won' : ''}`}>
    <span class="act-seat-face"><${Avatar} user=${person(id)} size=${32} /></span>
    <span class="act-seat-name trunc">${first(id)}</span>
    <span class=${`act-piece p${seat}`} aria-label=${g.kind === 'ttt' ? `plays ${piece}` : seat ? 'rose' : 'cyan'}>${piece}</span>
    ${turn && html`<span class="act-turn">${id === S.me ? 'Your turn' : 'Their turn'}</span>`}
  </span>`;
}

function resultText(g) {
  const r = g.result;
  if (!r) return null;
  if (r.draw) return 'It’s a draw.';
  if (r.left) return `${first(r.left)} left the call. ${g.seats[r.winner] ? `${first(g.seats[r.winner])} wins.` : ''}`;
  if (r.resigned) return `${first(r.resigned)} resigned. ${first(g.seats[r.winner])} wins.`;
  return `${first(g.seats[r.winner])} ${g.seats[r.winner] === S.me ? 'win' : 'wins'}!`;
}

function Game({ a }) {
  const g = a.game;
  const spec = GAMES[g.kind];
  const mySeat = g.seats.indexOf(S.me);
  const myTurn = mySeat >= 0 && !g.result && !g.seats.includes(null) && g.turn === mySeat;
  const [focus, setFocus] = useState(g.kind === 'c4' ? 3 : 4);
  const grid = useRef();
  const win = new Set(g.result?.line || []);
  const move = (m) => { if (myTurn) act('game.move', g.kind === 'c4' ? { col: m } : { cell: m }); };
  const count = g.kind === 'c4' ? spec.cols : spec.cols * spec.rows;
  const key = (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: g.kind === 'c4' ? 0 : -spec.cols, ArrowDown: g.kind === 'c4' ? 0 : spec.cols, Home: -count, End: count }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(count - 1, focus + step));
    setFocus(next);
    grid.current?.querySelector(`[data-i="${next}"]`)?.focus();
  };
  const cellLabel = (i) => {
    const v = g.board[i];
    const r = Math.floor(i / spec.cols), c = i % spec.cols;
    const where = `${['Top', 'Middle', 'Bottom'][r]} ${['left', 'centre', 'right'][c]}`.replace('Middle centre', 'Centre');
    return `${where}, ${v == null ? 'empty' : v ? 'O' : 'X'}`;
  };
  const colLabel = (c) => {
    const free = g.board.filter((v, i) => i % spec.cols === c && v == null).length;
    return `Column ${c + 1}, ${free ? `${free} ${free === 1 ? 'space' : 'spaces'} left` : 'full'}`;
  };
  const status = g.result ? resultText(g) : g.seats.includes(null) ? 'Waiting for a second player.' : myTurn ? 'Your turn.' : `${first(g.seats[g.turn])}’s turn.`;
  return html`<div class="act-game-body">
    <div class="act-seats"><${Seat} g=${g} seat=${0} /><span class="act-vs faint">vs</span><${Seat} g=${g} seat=${1} /></div>
    <p class=${`act-status${g.result ? ' over' : ''}`}>${status}</p>
    ${g.kind === 'ttt'
      ? html`<div class="act-grid ttt" ref=${grid} role="group" aria-label="Board" onKeyDown=${key}>
          ${g.board.map((v, i) => html`<button key=${i} data-i=${i} class=${`act-cell${v != null ? ` p${v}` : ''}${win.has(i) ? ' win' : ''}${g.last === i ? ' last' : ''}`}
            tabindex=${focus === i ? 0 : -1} aria-label=${cellLabel(i)} aria-disabled=${String(!myTurn || v != null)}
            onFocus=${() => setFocus(i)} onClick=${() => v == null && move(i)}>${v == null ? '' : v ? 'O' : 'X'}</button>`)}
        </div>`
      : html`<div class="act-c4">
          <div class="act-drops" ref=${grid} role="group" aria-label="Drop a piece" onKeyDown=${key}>
            ${Array.from({ length: spec.cols }, (_, c) => html`<button key=${c} data-i=${c} class="act-drop" tabindex=${focus === c ? 0 : -1}
              aria-label=${colLabel(c)} aria-disabled=${String(!myTurn || g.board[c] != null)} onFocus=${() => setFocus(c)} onClick=${() => g.board[c] == null && move(c)}>
              <${Icon} name="down" size=${16} /></button>`)}
          </div>
          <div class="act-grid c4" role="img" aria-label=${`Connect Four board, ${g.moves} ${g.moves === 1 ? 'piece' : 'pieces'} played`}>
            ${g.board.map((v, i) => html`<span key=${i} class=${`act-hole${v != null ? ` p${v}` : ''}${win.has(i) ? ' win' : ''}${g.last === i ? ' last' : ''}`} onClick=${() => move(i % spec.cols)}></span>`)}
          </div>
        </div>`}
    <div class="act-game-acts">
      ${mySeat >= 0 && !g.result && g.moves > 0 && html`<button class="btn quiet" onClick=${() => act('game.resign')}>Resign</button>`}
      ${mySeat >= 0 && g.result && html`<button class="btn live" onClick=${() => act('game.rematch')}>Rematch</button>`}
    </div>
  </div>`;
}
