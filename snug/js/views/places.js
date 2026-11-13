// Places, structure and community in the browser: the rail's folders, forum
// rooms, stage rooms, per-house names and pictures, role colours and icons,
// the welcome for newcomers, and the room details' extra controls. The
// server decides every rule (server/places.js); this only draws them.
import { html, useState } from '../../vendor/preact-htm.js';
import {
  S, emit, toast, openModal, closeModal, openMenu, openThread, openConv, person, resync, subscribe,
} from '../store.js';
import { call, on, loadHistory } from '../server.js';
import { can } from '../lib/perms.js';
import { plural, fmtWhen, HUES, hueOf, fold } from '../lib/util.js';
import { plain } from '../lib/format.js';
import {
  railItems, sortPosts, nameRole, iconRole, PLACE_LIMITS as L,
} from '../lib/places.js';
import { Icon, addIcons } from '../ui/icons.js';
import { Avatar, Tile, Seg, Empty, RoomIcon } from '../ui/kit.js';
import { joinVoice, leaveVoice, toggleMute } from '../voice.js';

addIcons({
  forum: 'M3.5 5.5A1.5 1.5 0 0 1 5 4h7a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 12 11H8l-3 2.500V11H5a1.5 1.5 0 0 1-1.5-1.5Z|M15.5 7.500h.5A1.5 1.5 0 0 1 17.5 9v4a1.5 1.5 0 0 1-1.5 1.5h-.5V17l-3-2.500H9',
  stage: 'M10 3a2 2 0 0 0-2 2v3a2 2 0 0 0 4 0V5a2 2 0 0 0-2-2Z|M6.500 8a3.500 3.500 0 0 0 7 0|M10 11.500V14|M4 17h12|M6 14h8',
  folder: 'M3 6a1.5 1.5 0 0 1 1.5-1.5h3.5l1.5 2h6A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5Z',
  hand: 'M7 10V4.500a1 1 0 0 1 2 0V9|M9 9V3.500a1 1 0 0 1 2 0V9|M11 9V4.500a1 1 0 0 1 2 0V10|M13 10V7a1 1 0 0 1 2 0v4.500a5 5 0 0 1-5 5h-.5a5 5 0 0 1-4-2L4 12a1 1 0 0 1 1.500-1.300L7 12V10',
  hook: 'M8 4.500a3 3 0 1 1 3.500 3|M11.500 7.500l-3 5|M5.500 12.500a3 3 0 1 0 3 3h5|M13.500 15.500a3 3 0 1 0 0-6',
  chart: 'M4 16V9|M8 16V5|M12 16v-5|M16 16V7|M3 16.500h14',
  grid: 'M4 4h5v5H4z|M11 4h5v5h-5z|M4 11h5v5H4z|M11 11h5v5h-5z',
  rows: 'M4 5h12|M4 10h12|M4 15h12',
  lock: 'M5.500 9h9v7.500h-9z|M7.500 9V6.500a2.500 2.500 0 0 1 5 0V9',
  grip: 'f:M7.500 5a1 1 0 1 0 0 .1Z|f:M12.500 5a1 1 0 1 0 0 .1Z|f:M7.500 10a1 1 0 1 0 0 .1Z|f:M12.500 10a1 1 0 1 0 0 .1Z|f:M7.500 15a1 1 0 1 0 0 .1Z|f:M12.500 15a1 1 0 1 0 0 .1Z',
});

// ---------- State that comes with every snapshot, and its live changes ----------
export const places = () => S.places || (S.places = { rail: { items: [] } });
on('places', (d) => { Object.assign(places(), d); });
on('stage', ({ room, ...st }) => { if (S.rooms[room]) S.rooms[room].stage = st; });
on('forum.thread', ({ id, conv, root }) => { if (!S.threads[id]) S.threads[id] = { conv, root }; if (!S.msgs[id]) S.msgs[id] = []; });

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPHA[b % 36]).join('');
const msgId = () => `m_${rand(16)}`;
// An action that changes something: say why if the server refuses, and fetch the truth again.
export function act(op, d, done) {
  return call(op, d).then((r) => { if (done) toast(done); return r; }, (e) => {
    toast(e.offline ? 'You’re offline, so that change wasn’t saved.' : e.message);
    if (!e.offline) resync();
    return null;
  });
}

// ---------- People in a house: every role, name colour, icon, nickname ----------
export const rolesOf = (house, uid) => {
  const h = S.houses[house];
  if (!h) return [];
  return [h.members[uid], ...(h.extra?.[uid] || [])].filter(Boolean);
};
export const colourRole = (house, uid) => (S.houses[house] ? nameRole(S.houses[house].roles, rolesOf(house, uid)) : null);
export const roleIcon = (house, uid) => (S.houses[house] ? iconRole(S.houses[house].roles, rolesOf(house, uid))?.icon || null : null);
// A person as they look in one house: their nickname and picture there.
export function houseFace(u, house) {
  const p = house && S.houses[house]?.profiles?.[u.id];
  if (!p) return u;
  return { ...u, name: p.nick || u.name, emoji: p.emoji || u.emoji, hue: p.hue ?? u.hue, realName: u.name };
}
// The author of a message: a bot's own name for webhooks and followed notices.
export function msgFace(m, house) {
  const u = person(m.author);
  if (m.bot) return { ...u, name: m.bot.name || u.name, emoji: '🤖' };
  return houseFace(u, house);
}
export const BotBadge = ({ m }) => m?.bot && html`<span class="bot-badge" data-tip=${m.bot.follow ? `Copied from ${m.bot.follow.room} in ${m.bot.follow.house}` : 'Posted by a webhook'}>${m.bot.follow ? 'Notice' : 'Bot'}</span>`;
export const PostTitle = ({ m }) => m?.post && html`<div class="post-title">${m.post.title}</div>`;
export const RoleIconMark = ({ house, uid }) => {
  const icon = roleIcon(house, uid);
  return icon && html`<span class="role-icon" role="img" aria-label=${`${S.houses[house].roles.find((r) => r.icon === icon)?.name || 'Role'} icon`}>${icon}</span>`;
};

// ---------- The rail: folders and order ----------
const railNow = () => railItems(places().rail, S.houseOrder);
function setRail(items) {
  places().rail = { items };
  emit();
  return call('rail.set', { items }).then((r) => { places().rail = r.rail; emit(); }, (e) => {
    toast(e.offline ? 'You’re offline, so the new order wasn’t saved.' : e.message);
    if (!e.offline) resync();
  });
}
const clone = (items) => items.map((it) => (typeof it === 'string' ? it : { ...it, houses: [...it.houses] }));
function without(items, id) {
  return clone(items).map((it) => (typeof it === 'string' ? it : { ...it, houses: it.houses.filter((h) => h !== id) }))
    .filter((it) => it !== id && (typeof it === 'string' || it.houses.length));
}
function placeNear(items, id, ref, after) {
  const out = without(items, id);
  for (let i = 0; i < out.length; i++) {
    const it = out[i];
    if (it === ref || it.id === ref) { out.splice(after ? i + 1 : i, 0, id); return out; }
    if (typeof it !== 'string' && it.houses.includes(ref)) { it.houses.splice(it.houses.indexOf(ref) + (after ? 1 : 0), 0, id); return out; }
  }
  out.push(id);
  return out;
}
function groupWith(items, id, target) {
  if (id === target) return items;
  const out = without(items, id);
  for (let i = 0; i < out.length; i++) {
    const it = out[i];
    if (typeof it !== 'string' && (it.id === target || it.houses.includes(target))) { it.houses.push(id); return out; }
    if (it === target) { out[i] = { id: `fd_${rand(10)}`, name: '', hue: null, open: true, houses: [target, id] }; return out; }
  }
  return out;
}
function moveBy(items, id, step) {
  const out = clone(items);
  const box = out.find((it) => typeof it !== 'string' && it.houses.includes(id));
  const list = box ? box.houses : out;
  const i = list.findIndex((x) => x === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= list.length) return null;
  [list[i], list[j]] = [list[j], list[i]];
  return out;
}
function outOfFolder(items, id) {
  const out = clone(items);
  const i = out.findIndex((it) => typeof it !== 'string' && it.houses.includes(id));
  if (i < 0) return null;
  out[i].houses = out[i].houses.filter((h) => h !== id);
  out.splice(i + 1, 0, id);
  return out.filter((it) => typeof it === 'string' || it.houses.length);
}
const folderName = (f) => f.name || f.houses.map((h) => S.houses[h]?.name).filter(Boolean).slice(0, 2).join(', ') || 'Folder';

let dragging = null;
function dropZone(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'into';
}
function dndProps(key, onDrop) {
  return {
    onDragOver: (e) => { if (!dragging || dragging === key) return; e.preventDefault(); e.currentTarget.dataset.drop = dropZone(e); },
    onDragLeave: (e) => { delete e.currentTarget.dataset.drop; },
    onDrop: (e) => { e.preventDefault(); delete e.currentTarget.dataset.drop; if (dragging && dragging !== key) onDrop(dragging, dropZone(e)); dragging = null; },
  };
}

function railKeys(id, inFolder) {
  return (e) => {
    if (!e.altKey) return;
    let next = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') next = moveBy(railNow(), id, e.key === 'ArrowUp' ? -1 : 1);
    else if (e.key === 'ArrowLeft' && inFolder) next = outOfFolder(railNow(), id);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    setRail(next).then(() => document.querySelector(`[data-rail-id="${id}"] .rail-btn`)?.focus());
  };
}

function folderMenu(f, pos) {
  const items = railNow();
  const change = (patch) => setRail(items.map((it) => (typeof it !== 'string' && it.id === f.id ? { ...it, ...patch } : it)));
  openMenu({
    anchor: pos.anchor, x: pos.x, y: pos.y,
    items: [
      { label: f.open ? 'Close folder' : 'Open folder', icon: 'folder', onSelect: () => change({ open: !f.open }) },
      { label: 'Rename folder', icon: 'edit', onSelect: () => openModal(FolderForm, { folder: f }) },
      { sep: true },
      { heading: 'Colour' },
      { label: 'No colour', checked: f.hue == null, onSelect: () => change({ hue: null }) },
      ...HUES.map(([v, name]) => ({ label: name, checked: f.hue === v, onSelect: () => change({ hue: v }) })),
      { sep: true },
      { label: 'Take the houses out', icon: 'leave', onSelect: () => setRail(items.flatMap((it) => (typeof it !== 'string' && it.id === f.id ? it.houses : [it]))) },
    ],
  });
}
function FolderForm({ folder }) {
  const [name, setName] = useState(folder.name || '');
  const save = (e) => {
    e.preventDefault();
    setRail(railNow().map((it) => (typeof it !== 'string' && it.id === folder.id ? { ...it, name: name.trim() } : it)));
    closeModal();
  };
  return html`<form class="form" onSubmit=${save} novalidate>
    <h2>Name this folder</h2>
    <div><label class="label" for="folder-name">Name</label>
      <input id="folder-name" class="field" data-autofocus maxlength=${L.folderName} value=${name} placeholder=${folderName({ ...folder, name: '' })} onInput=${(e) => setName(e.target.value)} />
      <div class="hint">Leave it empty to show the houses’ names.</div></div>
    <div class="modal-foot"><button type="button" class="btn" onClick=${closeModal}>Cancel</button><button class="btn primary">Save</button></div>
  </form>`;
}

// The houses part of the rail, with folders. nav.js passes its own pieces in.
export function RailHouses({ sp, RailItem, houseMenu, openSpace, houseAttention }) {
  const items = railNow();
  const house = (id, inFolder) => {
    const h = S.houses[id];
    if (!h) return null;
    return html`<div key=${id} class=${`rail-dnd${inFolder ? ' in-folder' : ''}`} data-rail-id=${id} draggable="true"
      onDragStart=${(e) => { dragging = id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', h.name); } catch { /* old browsers */ } }}
      onDragEnd=${() => { dragging = null; }} onKeyDown=${railKeys(id, inFolder)}
      ...${dndProps(id, (from, zone) => setRail(zone === 'into' ? groupWith(items, from, id) : placeNear(items, from, id, zone === 'after')))}>
      <${RailItem} label=${h.name} cls="rail-house" sel=${sp === id} attn=${houseAttention(S, id)}
        onClick=${() => openSpace(id)} onMenu=${(pos) => houseMenu(id, pos)}>
        <${Tile} house=${h} />
      <//>
    </div>`;
  };
  return items.map((it) => {
    if (typeof it === 'string') return house(it, false);
    const label = folderName(it);
    const needs = it.houses.reduce((n, h) => n + (houseAttention(S, h).needs || 0), 0);
    const soft = it.houses.some((h) => houseAttention(S, h).soft);
    const toggle = () => setRail(items.map((x) => (typeof x !== 'string' && x.id === it.id ? { ...x, open: !x.open } : x)));
    return html`<div key=${it.id} class=${`rail-folder-wrap${it.open ? ' open' : ''}`} style=${it.hue != null ? `--hue:${hueOf(it.hue)}` : ''}>
      <div class="rail-dnd" data-rail-id=${it.id} ...${dndProps(it.id, (from, zone) => setRail(zone === 'into' ? groupWith(items, from, it.id) : placeNear(items, from, it.id, zone === 'after')))}>
        <${RailItem} label=${`${label} folder, ${plural(it.houses.length, 'house')}, ${it.open ? 'open' : 'closed'}`} cls=${`rail-folder${it.hue != null ? ' hued' : ''}`}
          attn=${it.open ? { needs: 0 } : { needs, soft }} onClick=${toggle} onMenu=${(pos) => folderMenu(it, pos)}>
          ${it.open
            ? html`<${Icon} name="folder" size=${20} />`
            : html`<span class="folder-minis">${it.houses.slice(0, 4).map((h) => html`<${Tile} key=${h} house=${S.houses[h]} />`)}</span>`}
        <//>
      </div>
      ${it.open && it.houses.map((h) => house(h, true))}
    </div>`;
  });
}

// ---------- Forum rooms ----------
const FORUM_KEY = 'snug.forum';
const forumPrefs = (() => { try { return JSON.parse(localStorage.getItem(FORUM_KEY)) || {}; } catch { return {}; } })();
const keepForum = () => { try { localStorage.setItem(FORUM_KEY, JSON.stringify(forumPrefs)); } catch { /* blocked */ } };

const postFacts = (m) => {
  const thread = S.msgs[`t:${m.id}`] || [];
  const last = Math.max(m.post.last || m.ts, thread.length ? thread[thread.length - 1].ts : 0);
  return { ...m, last, replies: Math.max(m.post.replies || 0, thread.length) };
};
const TagChip = ({ tag, on, onClick }) => (onClick
  ? html`<button type="button" class="chip tag-chip" aria-pressed=${String(!!on)} onClick=${onClick}>${tag.emoji && html`<span aria-hidden="true">${tag.emoji} </span>`}${tag.name}</button>`
  : html`<span class="tag-chip static">${tag.emoji && html`<span aria-hidden="true">${tag.emoji} </span>`}${tag.name}</span>`);

export function ForumView({ conv }) {
  const room = S.rooms[conv];
  const pref = forumPrefs[conv] || {};
  const [filter, setFilter] = useState([]);
  const [loading, setLoading] = useState(false);
  const set = (k, v) => { forumPrefs[conv] = { ...pref, [k]: v }; keepForum(); emit(); };
  const sort = pref.sort || 'activity';
  const layout = pref.layout || 'list';
  const tags = room.tags || [];
  const tagOf = (tid) => tags.find((t) => t.id === tid);
  const all = (S.msgs[conv] || []).filter((m) => m.post && !m.state).map(postFacts);
  const posts = sortPosts(all.filter((m) => filter.every((t) => m.post.tags.includes(t))), sort);
  const mayPost = room.perms ? room.perms.send : can(S, room.house, 'post');
  const older = async () => {
    setLoading(true);
    try { await loadHistory(conv, { before: (S.msgs[conv] || [])[0]?.seq }); } catch (e) { toast(e.message); }
    setLoading(false);
  };
  return html`<div class="forum" role="region" aria-label=${`${room.name} posts`}>
    <div class="forum-bar">
      ${mayPost
        ? html`<button class="btn primary" onClick=${() => openModal(PostForm, { room: conv })}><${Icon} name="plus" size=${16} />New post</button>`
        : html`<span class="faint">You can read and follow posts here.</span>`}
      <span class="grow"></span>
      <${Seg} label="Sort posts" value=${sort} options=${[['activity', 'Latest activity'], ['newest', 'Newest']]} onChange=${(v) => set('sort', v)} />
      <div class="seg" role="group" aria-label="Show posts as">
        <button type="button" aria-pressed=${String(layout === 'list')} aria-label="List" data-tip="List" onClick=${() => set('layout', 'list')}><${Icon} name="rows" size=${16} /></button>
        <button type="button" aria-pressed=${String(layout === 'grid')} aria-label="Grid" data-tip="Grid" onClick=${() => set('layout', 'grid')}><${Icon} name="grid" size=${16} /></button>
      </div>
    </div>
    ${tags.length > 0 && html`<div class="forum-tags" role="group" aria-label="Show posts tagged">
      ${tags.map((t) => html`<${TagChip} key=${t.id} tag=${t} on=${filter.includes(t.id)} onClick=${() => setFilter(filter.includes(t.id) ? filter.filter((x) => x !== t.id) : [...filter, t.id])} />`)}
    </div>`}
    ${posts.length
      ? html`<ul class=${`forum-posts ${layout}`}>
          ${posts.map((m) => {
            const u = msgFace(m, room.house);
            const following = !!S.followed[`t:${m.id}`];
            const editable = m.author === S.me || !!room.perms?.manage; // the server checks again (forum.edit)
            return html`<li key=${m.id} class=${`post-card${editable ? ' editable' : ''}`}>
              <button class="post-open" onClick=${() => openThread(conv, m.id)} aria-label=${`${m.post.title}, by ${u.name}, ${plural(m.replies, 'reply', 'replies')}`}>
                <span class="post-head"><b class="post-name">${m.post.title}</b></span>
                ${m.post.tags.length > 0 && html`<span class="post-tags">${m.post.tags.map(tagOf).filter(Boolean).map((t) => html`<${TagChip} key=${t.id} tag=${t} />`)}</span>`}
                ${m.text && m.text !== m.post.title && html`<span class="post-body">${plain(m.text).slice(0, 220)}</span>`}
                <span class="post-meta"><${Avatar} user=${u} size=${20} /><span class="trunc">${u.name}</span>
                  <span aria-hidden="true">·</span><${Icon} name="thread" size=${14} /><span class="num">${m.replies}</span>
                  <span aria-hidden="true">·</span><span>${sort === 'newest' ? fmtWhen(m.ts) : `Active ${fmtWhen(m.last)}`}</span></span>
              </button>
              <span class="post-acts">
                ${editable && html`<button class="ib sm post-edit" aria-label=${`Edit the title and tags of ${m.post.title}`} data-tip="Edit title and tags"
                  onClick=${() => openModal(PostForm, { room: conv, edit: m.id })}><${Icon} name="edit" size=${16} /></button>`}
                <button class=${`ib sm post-follow${following ? ' on' : ''}`} aria-pressed=${String(following)} aria-label=${following ? `Stop following ${m.post.title}` : `Follow ${m.post.title}`}
                  data-tip=${following ? 'Following' : 'Follow'} onClick=${() => followPost(conv, m.id, !following)}><${Icon} name=${following ? 'bell' : 'bell-off'} size=${16} /></button>
              </span>
            </li>`;
          })}
        </ul>`
      : html`<${Empty} icon="forum" title=${all.length ? 'No posts with those tags' : 'No posts yet'}
          text=${all.length ? 'Clear a tag to see more.' : mayPost ? 'Start the first one. Each post gets its own thread for replies.' : 'Posts will show here when people start them.'} />`}
    ${S.more[conv] && html`<div class="forum-more"><button class="btn" disabled=${loading} aria-busy=${String(loading)} onClick=${older}>${loading ? 'Loading…' : 'Show older posts'}</button></div>`}
  </div>`;
}
function followPost(conv, root, on) {
  const tid = `t:${root}`;
  if (!S.threads[tid]) S.threads[tid] = { conv, root };
  if (on) S.followed[tid] = true; else delete S.followed[tid];
  emit();
  act('follow.set', { thread: tid, on });
}

// A new post, or (edit: a post's id) a new title and tags for one. The body
// is the post's first message, edited like any other in its thread.
export function PostForm({ room: conv, edit }) {
  const room = S.rooms[conv];
  const tags = room.tags || [];
  const was = edit ? (S.msgs[conv] || []).find((m) => m.id === edit)?.post : null;
  const [title, setTitle] = useState(was?.title || '');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState(was ? was.tags.filter((t) => tags.some((x) => x.id === t)) : []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fail = (err) => { setBusy(false); setError(err.offline ? 'You’re offline. Try again when you’re back.' : err.message); };
  const submit = (e) => {
    e.preventDefault();
    if (!title.trim()) { setError('Give your post a title.'); document.getElementById('post-title')?.focus(); return; }
    if (room.tagRequired && !picked.length) { setError(`Pick at least one tag. ${room.name} asks for one.`); return; }
    setBusy(true);
    if (edit) {
      call('forum.edit', { id: edit, title: title.trim(), tags: picked }).then(() => { closeModal(); toast('Post updated.'); }, fail);
      return;
    }
    call('forum.post', { room: conv, id: msgId(), title: title.trim(), text, tags: picked }).then((r) => {
      const list = (S.msgs[conv] ||= []);
      if (!list.some((m) => m.id === r.m.id)) list.push(r.m);
      S.threads[`t:${r.m.id}`] ||= { conv, root: r.m.id };
      S.msgs[`t:${r.m.id}`] ||= [];
      S.followed[`t:${r.m.id}`] = true;
      closeModal();
      openThread(conv, r.m.id);
    }, fail);
  };
  if (edit && !was) return html`<p>That post is gone.</p><div class="modal-foot"><button class="btn" onClick=${closeModal}>Close</button></div>`;
  return html`<form class="form" onSubmit=${submit} novalidate>
    <h2>${edit ? 'Edit post' : `New post in ${room.name}`}</h2>
    <div><label class="label" for="post-title">Title</label>
      <input id="post-title" class=${`field${error && !title.trim() ? ' bad' : ''}`} data-autofocus maxlength=${L.postTitle} value=${title} placeholder="One question or idea per post"
        aria-invalid=${String(!!error && !title.trim())} aria-describedby="post-msg" onInput=${(e) => { setTitle(e.target.value); setError(''); }} /></div>
    ${!edit && html`<div><label class="label" for="post-body">Details <span class="faint">(optional)</span></label>
      <textarea id="post-body" class="field" rows="4" maxlength="4000" value=${text} onInput=${(e) => setText(e.target.value)}></textarea></div>`}
    ${tags.length > 0 && html`<div><span class="label" id="post-tags">Tags${room.tagRequired ? html` <span class="faint">(pick at least one)</span>` : html` <span class="faint">(up to ${L.postTags})</span>`}</span>
      <div class="topic-chips" role="group" aria-labelledby="post-tags">
        ${tags.map((t) => html`<${TagChip} key=${t.id} tag=${t} on=${picked.includes(t.id)} onClick=${() => { setError(''); setPicked(picked.includes(t.id) ? picked.filter((x) => x !== t.id) : picked.length < L.postTags ? [...picked, t.id] : picked); }} />`)}
      </div></div>`}
    ${error ? html`<div class="err" id="post-msg" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`
      : html`<div class="hint" id="post-msg">${edit ? 'To change the details, edit the first message in the post’s thread.' : 'Replies go in the post’s own thread. You’ll follow it.'}</div>`}
    <div class="modal-foot"><button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button class="btn primary" disabled=${busy} aria-busy=${String(busy)}>${edit ? (busy ? 'Saving…' : 'Save') : busy ? 'Posting…' : 'Post'}</button></div>
  </form>`;
}

// ---------- Stage rooms ----------
export function StageRoom({ conv }) {
  const room = S.rooms[conv];
  const st = room.stage || { topic: '', speakers: [], hands: [] };
  const ids = (S.voice[conv] || []).filter((id) => S.users[id]);
  const vs = S.voiceState[conv] || {};
  const isSpeaker = (id) => st.speakers.includes(id) || (vs[id] && !vs[id].smute);
  const speakers = ids.filter(isSpeaker);
  const audience = ids.filter((id) => !isSpeaker(id));
  const inCall = S.call?.room === conv;
  const live = inCall && S.call.status === 'live';
  const mine = room.perms || {};
  const manage = !!mine.manage;
  const amSpeaker = live && isSpeaker(S.me);
  const handUp = st.hands.includes(S.me);
  const [topic, setTopic] = useState(null);
  const face = (id, big) => {
    const u = houseFace(S.users[id], room.house);
    const quiet = id === S.me ? S.call?.muted : vs[id]?.muted;
    const talking = !!S.speaking[id] && !quiet;
    return html`<li key=${id} class=${`stage-who${talking ? ' talking' : ''}`}>
      <${Avatar} user=${u} size=${big ? 56 : 32} speaking=${talking} />
      <span class="trunc">${id === S.me ? 'You' : u.name.split(' ')[0]}</span>
      ${st.hands.includes(id) && html`<span class="hand-up" role="img" aria-label="Hand raised"><${Icon} name="hand" size=${14} /></span>`}
      ${manage && id !== S.me && (big
        ? html`<button class="btn sm" onClick=${() => act('stage.audience', { room: conv, user: id })}>Move to audience</button>`
        : html`<button class="btn sm" onClick=${() => act('stage.invite', { room: conv, user: id })}>Invite to speak</button>`)}
    </li>`;
  };
  const saveTopic = (e) => { e.preventDefault(); act('stage.topic', { room: conv, topic: topic.trim() }); setTopic(null); };
  return html`<div class=${`stage-room${ids.length ? '' : ' empty'}`} role="region" aria-label="Stage">
    <div class="stage-room-top">
      <span class="stage-count"><${Icon} name="stage" size=${16} />${ids.length ? `${plural(speakers.length, 'speaker')} · ${audience.length} listening` : 'Stage'}</span>
      ${topic === null
        ? html`<span class="stage-topic trunc">${st.topic || (ids.length ? 'No topic set' : '')}</span>
            ${manage && live && html`<button class="ib sm" aria-label="Set the topic" data-tip="Set the topic" onClick=${() => setTopic(st.topic || '')}><${Icon} name="edit" size=${16} /></button>`}`
        : html`<form class="stage-topic-form" onSubmit=${saveTopic}>
            <input class="field" data-autofocus aria-label="Stage topic" maxlength=${L.stageTopic} value=${topic} onInput=${(e) => setTopic(e.target.value)} />
            <button class="btn sm primary">Save</button><button type="button" class="btn sm" onClick=${() => setTopic(null)}>Cancel</button>
          </form>`}
    </div>
    ${ids.length
      ? html`<div class="stage-sections">
          <div><h3 class="stage-h">Speakers</h3>${speakers.length ? html`<ul class="stage-list big">${speakers.map((id) => face(id, true))}</ul>` : html`<p class="faint">Nobody is speaking yet.</p>`}</div>
          <div><h3 class="stage-h">Audience <span class="num faint">${audience.length}</span></h3>${audience.length ? html`<ul class="stage-list">${audience.map((id) => face(id, false))}</ul>` : html`<p class="faint">Nobody is listening yet.</p>`}</div>
        </div>`
      : html`<p class="stage-empty">The stage is quiet. ${manage || mine.speak ? 'Join and start speaking; people can listen and raise a hand to ask a question.' : 'Join to listen when it starts.'}</p>`}
    <div class="stage-acts">
      ${!inCall
        ? html`<button class="btn primary" disabled=${mine.connect === false} onClick=${() => joinVoice(conv)}><${Icon} name="stage" size=${16} />${mine.connect === false ? 'You can’t join this stage' : 'Join the stage'}</button>`
        : !live ? html`<button class="btn" disabled aria-busy="true">Joining…</button>`
          : html`
            ${amSpeaker && html`<button class=${`ib vc${S.call.muted ? ' on' : ''}`} aria-pressed=${String(S.call.muted)} aria-label=${S.call.muted ? 'Unmute' : 'Mute'} data-tip=${S.call.muted ? 'Unmute' : 'Mute'} onClick=${toggleMute}><${Icon} name=${S.call.muted ? 'mic-off' : 'mic'} /></button>
              <button class="btn" onClick=${() => act('stage.audience', { room: conv })}>Move to audience</button>`}
            ${!amSpeaker && (mine.speak
              ? html`<button class="btn primary" onClick=${() => act('stage.speak', { room: conv })}><${Icon} name="mic" size=${16} />Speak</button>`
              : html`<button class=${`btn${handUp ? ' on' : ''}`} aria-pressed=${String(handUp)} onClick=${() => act('stage.hand', { room: conv, up: !handUp })}><${Icon} name="hand" size=${16} />${handUp ? 'Lower your hand' : 'Raise your hand'}</button>`)}
            <button class="btn danger" onClick=${leaveVoice}><${Icon} name="leave" size=${16} />Leave</button>`}
    </div>
  </div>`;
}

// ---------- Per-house name and picture ----------
export function NickForm({ house, user = S.me }) {
  const h = S.houses[house];
  const u = person(user);
  const p = h.profiles?.[user] || {};
  const [nick, setNick] = useState(p.nick || '');
  const [emoji, setEmoji] = useState(p.emoji || '');
  const [hue, setHue] = useState(p.hue ?? null);
  const [error, setError] = useState('');
  const save = (e) => {
    e.preventDefault();
    call('member.profile', { house, ...(user === S.me ? {} : { user }), nick: nick.trim() || null, emoji: emoji.trim() || null, hue })
      .then(() => { closeModal(); toast(user === S.me ? `Your name in ${h.name} is saved.` : 'Saved.'); }, (err) => setError(err.message));
  };
  const preview = { ...u, name: nick.trim() || u.name, emoji: emoji.trim() || u.emoji, hue: hue ?? u.hue };
  return html`<form class="form" onSubmit=${save} novalidate>
    <h2>${user === S.me ? `Your name in ${h.name}` : `${u.name} in ${h.name}`}</h2>
    <div class="house-name-row"><${Avatar} user=${preview} size=${48} />
      <div class="grow"><label class="label" for="nick">Nickname</label>
        <input id="nick" class="field" data-autofocus maxlength=${L.nick} placeholder=${u.name} value=${nick} aria-describedby="nick-msg" onInput=${(e) => { setNick(e.target.value); setError(''); }} />
        ${error ? html`<div class="err" id="nick-msg" role="alert"><${Icon} name="alert" size=${14} />${error}</div>` : html`<div class="hint" id="nick-msg">Only in this house. Leave it empty to use ${u.name}.</div>`}</div></div>
    <div><label class="label" for="nick-emoji">Picture <span class="faint">(one emoji, optional)</span></label>
      <input id="nick-emoji" class="field" style="width:96px" maxlength="16" value=${emoji} onInput=${(e) => setEmoji(e.target.value)} /></div>
    <div><span class="label" id="nick-hue">Colour</span>
      <div class="swatches" role="group" aria-labelledby="nick-hue">
        <button type="button" class="swatch" style="--hue:0;--tile-c:0" aria-pressed=${String(hue == null)} aria-label="Same as everywhere" onClick=${() => setHue(null)}></button>
        ${HUES.map(([v, name]) => html`<button type="button" key=${v} class="swatch strong" style=${`--hue:${v}`} aria-pressed=${String(hue != null && hueOf(hue) === v)} aria-label=${name} onClick=${() => setHue(v)}></button>`)}
      </div></div>
    <div class="modal-foot"><button type="button" class="btn" onClick=${closeModal}>Cancel</button><button class="btn primary">Save</button></div>
  </form>`;
}

// ---------- Welcome and interests for newcomers ----------
const SEEN_KEY = 'snug.welcomed';
const seen = (() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; } })();
export function Onboarding({ house }) {
  const h = S.houses[house];
  const [picked, setPicked] = useState(h?.picks || []);
  const [busy, setBusy] = useState(false);
  if (!h) return null;
  const done = () => {
    seen[`${S.me}:${house}`] = true;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* blocked */ }
  };
  const save = () => {
    setBusy(true);
    const go = h.interests.length ? call('onboard.pick', { house, interests: picked }) : Promise.resolve();
    go.then(() => { done(); closeModal(); if (h.starter[0]) openConv(h.starter[0]); }, (e) => { setBusy(false); toast(e.message); });
  };
  return html`<div class="onboard">
    <div class="welcome-head"><${Tile} house=${h} lg /><div><span class="welcome-kicker">Welcome</span><h2>${h.name}</h2></div></div>
    ${h.welcome ? html`<p class="onboard-text">${h.welcome}</p>` : h.about && html`<p class="onboard-text">${h.about}</p>`}
    ${h.interests.length > 0 && html`<div><span class="label" id="ob-int">What are you into? <span class="faint">Pick any. It sets which roles you have here.</span></span>
      <div class="topic-chips" role="group" aria-labelledby="ob-int">
        ${h.interests.map((i) => html`<button type="button" key=${i.id} class="chip" aria-pressed=${String(picked.includes(i.id))} onClick=${() => setPicked(picked.includes(i.id) ? picked.filter((x) => x !== i.id) : [...picked, i.id])}>${i.emoji ? `${i.emoji} ` : ''}${i.label}</button>`)}
      </div></div>`}
    ${h.starter.length > 0 && html`<div><span class="label">Good places to start</span>
      <div class="welcome-rooms">${h.starter.filter((id) => S.rooms[id]).map((id) => html`<button type="button" class="welcome-room" key=${id} onClick=${() => { done(); closeModal(); openConv(id); }}>
        <${RoomIcon} kind=${S.rooms[id].kind} /><span><b>${S.rooms[id].name}</b> <span>${S.rooms[id].topic}</span></span></button>`)}</div></div>`}
    <div class="modal-foot"><button type="button" class="btn" onClick=${() => { done(); closeModal(); }}>Skip</button>
      <button type="button" class="btn primary" disabled=${busy} aria-busy=${String(busy)} onClick=${save}>${h.interests.length ? 'Save and start' : 'Start'}</button></div>
  </div>`;
}
// A house just joined that has a welcome opens it once, on this device.
subscribe(() => {
  if (!S.ready || S.ui.modal || S.ui.layer || !S.me) return;
  for (const id of S.houseOrder) {
    const h = S.houses[id];
    if (h?.joined && h.newcomer && (h.welcome || h.interests?.length) && !seen[`${S.me}:${id}`]) { openModal(Onboarding, { house: id }); return; }
  }
});

// ---------- Room details: the extra controls ----------
export function RoomPlaces({ conv }) {
  const room = S.rooms[conv];
  if (!room) return null;
  const h = S.houses[room.house];
  const mayNick = can(S, room.house, 'nick');
  const followTargets = room.kind === 'news' && !room.private && !room.restricted
    ? Object.values(S.rooms).filter((r) => r.house !== room.house && S.houses[r.house]?.joined && r.perms?.manage && ['text', 'news'].includes(r.kind))
    : [];
  return html`<div class="detail places-detail">
    ${(room.private || room.restricted) && html`<p class="faint access-note"><${Icon} name="lock" size=${14} />${room.private ? 'Private: only the roles and people allowed in see it.' : 'Some roles or people have their own access here.'}</p>`}
    <div class="places-acts">
      ${room.perms?.manage && html`<button class="btn" onClick=${() => import('./places-access.js').then((m) => openModal(m.RoomAccess, { room: conv }))}><${Icon} name="lock" size=${16} />Access and webhooks</button>`}
      ${followTargets.length > 0 && html`<button class="btn" onClick=${() => openModal(FollowForm, { source: conv, targets: followTargets.map((r) => r.id) })}><${Icon} name="news" size=${16} />Follow in another house</button>`}
      ${mayNick && html`<button class="btn" onClick=${() => openModal(NickForm, { house: room.house })}><${Icon} name="user" size=${16} />Your name in ${h.name}</button>`}
    </div>
  </div>`;
}
function FollowForm({ source, targets }) {
  const [target, setTarget] = useState(targets[0]);
  const [error, setError] = useState('');
  const src = S.rooms[source];
  const save = (e) => {
    e.preventDefault();
    call('news.follow', { source, target }).then(() => { closeModal(); toast(`New notices from ${src.name} will show in ${S.rooms[target].name}.`); }, (err) => setError(err.message));
  };
  return html`<form class="form" onSubmit=${save} novalidate>
    <h2>Follow ${src.name}</h2>
    <p class="modal-lead">New notices posted here are copied into a room you look after in another house, with where they came from.</p>
    <div><label class="label" for="follow-target">Into</label>
      <select id="follow-target" class="field" value=${target} onChange=${(e) => setTarget(e.target.value)}>
        ${targets.map((r) => html`<option key=${r} value=${r}>${S.houses[S.rooms[r].house].name}: ${S.rooms[r].name}</option>`)}
      </select>
      ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}</div>
    <div class="modal-foot"><button type="button" class="btn" onClick=${closeModal}>Cancel</button><button class="btn primary">Follow</button></div>
  </form>`;
}

export { fold };

// The server mutes stage audiences and people who may not speak (smute). The
// mute can arrive before this device counts the call as live, so check on
// every change: if the server says I'm muted, my microphone goes off too.
subscribe(() => {
  const c = S.call;
  if (!c || c.status !== 'live' || c.muted) return;
  if (S.voiceState[c.room]?.[S.me]?.smute) toggleMute();
});
