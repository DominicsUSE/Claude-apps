// Voice options on the server: each house's soundboard, and the per-room
// settings of voice rooms (a user limit and an audio bitrate).
//
// - A house keeps up to 24 sounds. Each is a short WAV file (PCM, mono or
//   stereo, 8 or 16 bit, 8 to 48 kHz), at most 512 KB and 5.2 seconds long.
//   Browsers turn whatever file was chosen into that WAV before uploading
//   (js/views/voiceopts-sounds.js); the length and format are read here from the
//   file's own header, never taken from the browser.
// - Adding, renaming and removing sounds needs the 'sounds' permission.
//   Playing one needs to be in a voice room of that house, not muted or
//   deafened (by yourself or by a moderator), and either the house lets
//   everyone use its soundboard (the default) or your role has 'soundboard'
//   (or 'sounds'). One sound every 3 seconds per person, and at most 6 every
//   10 seconds in a room.
// - The sound itself travels in the player's own voice (mixed into their
//   outgoing track in the browser), so the server only checks the rules and
//   tells the room who played what.
// - A voice room may hold fewer people than the mesh maximum: user_limit
//   (0 = no limit beyond 12). People who can moderate voice may still join a
//   full room. bitrate is the audio ceiling, in kbit/s, that every browser in
//   the room applies to its microphone.
import { writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { newId } from './model.js';
import { limiter } from './auth.js';

export const MAX_SOUNDS = 24;
export const MAX_SOUND_BYTES = 512 * 1024;
export const MAX_SOUND_SECONDS = 5.2;
export const SOUND_COOLDOWN_S = 3;
export const ROOM_SOUND_BURST = 6;        // sounds a room may hear in a burst...
export const ROOM_SOUND_WINDOW_S = 10;    // ...refilled over this many seconds
export const BITRATES = [8, 16, 24, 32, 48, 64, 96, 128]; // kbit/s
export const DEFAULT_BITRATE = 64;
export const MAX_ROOM_LIMIT = 12;         // the mesh maximum (server/hub.js VOICE_MAX)
const FILE_ID = /^f_[a-z0-9]{8,40}$/;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };

// What a WAV file holds, from its header. Null unless it is plain PCM.
export function wavInfo(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === 'fmt ' && size >= 16 && start + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      data = Math.min(size, buf.length - start);
      break;
    }
    off = start + size + (size & 1);
  }
  if (!fmt || data == null || data <= 0) return null;
  if (fmt.format !== 1 || (fmt.channels !== 1 && fmt.channels !== 2) || (fmt.bits !== 8 && fmt.bits !== 16)) return null;
  if (fmt.rate < 8000 || fmt.rate > 48000) return null;
  return { channels: fmt.channels, rate: fmt.rate, bits: fmt.bits, seconds: data / (fmt.rate * fmt.channels * (fmt.bits / 8)) };
}

export const soundView = (s) => s && {
  id: s.id, house: s.house, name: s.name, emoji: s.emoji || null, file: s.file, volume: s.volume, by: s.by, created: s.created,
};

export function soundReads(db) {
  return {
    row: (id) => (typeof id === 'string' ? db.get('SELECT * FROM house_sounds WHERE id = ?', id) : undefined),
    list: (house) => db.all('SELECT * FROM house_sounds WHERE house = ? ORDER BY created', house).map(soundView),
  };
}

export function createVoiceOptsOps({ db, M, hub, fail, ops = {} }) {
  const R = soundReads(db);
  const idOf = (v, name) => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const members = (house) => db.all('SELECT user FROM members WHERE house = ?', house).map((r) => r.user);
  const houseRow = (id) => db.get('SELECT * FROM houses WHERE id = ?', id) || fail('That house doesn’t exist.');
  const need = (user, house, perm, what) => {
    houseRow(house);
    if (!M.isMember(house, user)) fail('You’re not a member of that house.');
    if (!M.can(user, house, perm)) fail(`Your role can’t ${what} in this house.`);
  };
  const nameOf = (v) => {
    if (typeof v !== 'string' || !v.trim()) fail('Give the sound a name.');
    const n = v.trim().replace(/[\u0000-\u001f\u007f]/g, '');
    if (n.length > 32) fail('Sound names can be at most 32 characters.');
    if (!n) fail('Give the sound a name.');
    return n;
  };
  const emojiOf = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 16 || !EMOJI.test(v)) fail('Pick one emoji for the sound, or none.');
    return v;
  };
  const volumeOf = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail('A sound’s volume is between 0 and 100%.');
    return Math.round(v * 100) / 100;
  };
  const changed = (house) => hub.toUsers(members(house), 'sounds', { house, list: R.list(house) });
  const mayUse = (user, house) => {
    const h = db.get('SELECT sound_open FROM houses WHERE id = ?', house);
    return !!h && M.isMember(house, user) && (!!h.sound_open || M.can(user, house, 'soundboard') || M.can(user, house, 'sounds'));
  };

  // Rate limits: reset with the hub's (tests call resetLimits between cases).
  const perUser = limiter({ capacity: 1, perSecond: 1 / SOUND_COOLDOWN_S });
  const perRoom = limiter({ capacity: ROOM_SOUND_BURST, perSecond: ROOM_SOUND_BURST / ROOM_SOUND_WINDOW_S });
  const edits = limiter({ capacity: 20, perSecond: 1 });
  (hub.extraLimits ||= []).push(perUser, perRoom, edits);
  hub.soundLimits = { perUser, perRoom }; // tests reach in to clear one without the other
  const editing = (user) => { if (!edits.take(user)) fail('That’s a lot of changes at once. Wait a moment.'); };

  // Every house view carries its voice rooms' settings and its soundboard rule.
  const baseHouseView = M.houseView;
  M.houseView = (houseId, viewer) => {
    const v = baseHouseView(houseId, viewer);
    if (!v) return v;
    for (const r of db.all("SELECT id, user_limit, bitrate FROM rooms WHERE house = ? AND kind = 'voice'", houseId)) {
      if (v.rooms[r.id]) { v.rooms[r.id].limit = r.user_limit || 0; v.rooms[r.id].bitrate = r.bitrate || DEFAULT_BITRATE; }
    }
    v.house.soundOpen = !!db.get('SELECT sound_open FROM houses WHERE id = ?', houseId)?.sound_open;
    return v;
  };
  // Every snapshot carries the sounds of each house this person is in.
  const baseSnapshot = hub.snapshotFor;
  hub.snapshotFor = (u) => {
    const snap = baseSnapshot(u);
    snap.sounds = Object.fromEntries(M.houseIdsOf(u).map((h) => [h, R.list(h)]));
    return snap;
  };
  // Someone who joins a house gets its sounds along with its rooms.
  const baseContent = hub.sendHouseContent;
  if (baseContent) {
    hub.sendHouseContent = (u, houseId) => {
      baseContent(u, houseId);
      hub.toUser(u, 'sounds', { house: houseId, list: R.list(houseId) });
    };
  }

  const out = {};

  // A full room stays full, checked before anyone is let in.
  const baseJoin = ops['voice.join'];
  if (baseJoin) {
    out['voice.join'] = (c, d) => {
      const room = typeof d?.room === 'string' ? M.room(d.room) : null;
      // Only said to people who may see the room; anyone else gets the usual refusal from the base op.
      if (room && room.kind === 'voice' && room.user_limit > 0 && M.canRead(c.user, room.id)
        && hub.voicePlaceOf?.(c.user) !== room.id && !M.can(c.user, room.house, 'voicemod')
        && hub.inVoice([room.id]) >= room.user_limit) {
        fail(`${room.name} is full. It holds up to ${room.user_limit} ${room.user_limit === 1 ? 'person' : 'people'}.`);
      }
      return baseJoin(c, d);
    };
  }

  // A voice room's user limit and bitrate: people who can manage rooms.
  out['room.voice'] = (c, d) => {
    const room = M.room(idOf(d.room, 'room')) || fail('That room doesn’t exist.');
    need(c.user, room.house, 'rooms', 'change voice rooms');
    if (room.kind !== 'voice') fail('That isn’t a voice room.');
    editing(c.user);
    let limit = room.user_limit || 0, bitrate = room.bitrate || DEFAULT_BITRATE;
    if (d.limit !== undefined) {
      if (!Number.isInteger(d.limit) || d.limit < 0 || d.limit > MAX_ROOM_LIMIT) fail(`A user limit is from 1 to ${MAX_ROOM_LIMIT}, or none.`);
      limit = d.limit;
    }
    if (d.bitrate !== undefined) {
      if (!BITRATES.includes(d.bitrate)) fail('Pick one of the bitrates.');
      bitrate = d.bitrate;
    }
    db.run('UPDATE rooms SET user_limit = ?, bitrate = ? WHERE id = ?', limit, bitrate, room.id);
    hub.houseChanged(room.house);
    return { limit, bitrate };
  };

  // Who may use the soundboard: everyone in the house, or only roles that have it.
  out['house.soundboard'] = (c, d) => {
    const house = idOf(d.house, 'house');
    need(c.user, house, 'sounds', 'manage the soundboard');
    if (typeof d.open !== 'boolean') fail('That choice isn’t valid.');
    editing(c.user);
    db.run('UPDATE houses SET sound_open = ? WHERE id = ?', d.open ? 1 : 0, house);
    hub.houseChanged(house);
    return { open: d.open };
  };

  out['sound.add'] = (c, d) => {
    const house = idOf(d.house, 'house');
    need(c.user, house, 'sounds', 'manage the soundboard');
    editing(c.user);
    const name = nameOf(d.name);
    const emoji = emojiOf(d.emoji);
    const volume = d.volume === undefined ? 1 : volumeOf(d.volume);
    if (db.get('SELECT COUNT(*) n FROM house_sounds WHERE house = ?', house).n >= MAX_SOUNDS) fail(`A house can have up to ${MAX_SOUNDS} sounds. Remove one first.`);
    const file = db.get('SELECT * FROM files WHERE id = ?', idOf(d.file, 'sound file'));
    if (!file || file.owner !== c.user || file.conv !== `sound:${house}` || !json(file.meta, {}).sound) fail('That sound didn’t finish uploading. Choose it again.');
    if (db.get('SELECT 1 FROM house_sounds WHERE file = ?', file.id)) fail('That file is already a sound. Choose it again.');
    const sid = newId('snd');
    db.run('INSERT INTO house_sounds (id, house, name, emoji, file, volume, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      sid, house, name, emoji, file.id, volume, c.user, Date.now());
    changed(house);
    return { sound: soundView(R.row(sid)) };
  };

  out['sound.edit'] = (c, d) => {
    const s = R.row(idOf(d.id, 'sound')) || fail('That sound was removed.');
    need(c.user, s.house, 'sounds', 'manage the soundboard');
    editing(c.user);
    const next = {
      name: d.name === undefined ? s.name : nameOf(d.name),
      emoji: d.emoji === undefined ? s.emoji : emojiOf(d.emoji),
      volume: d.volume === undefined ? s.volume : volumeOf(d.volume),
    };
    db.run('UPDATE house_sounds SET name = ?, emoji = ?, volume = ? WHERE id = ?', next.name, next.emoji, next.volume, s.id);
    changed(s.house);
    return { sound: soundView(R.row(s.id)) };
  };

  out['sound.remove'] = (c, d) => {
    const s = R.row(idOf(d.id, 'sound'));
    if (!s) return {};
    need(c.user, s.house, 'sounds', 'manage the soundboard');
    editing(c.user);
    db.tx(() => {
      db.run('DELETE FROM house_sounds WHERE id = ?', s.id);
      db.run('DELETE FROM files WHERE id = ?', s.file);
    });
    M.soundUnlink?.(s.file);
    changed(s.house);
    return {};
  };

  // Play a sound into the voice room I'm in. The browser mixes it into my
  // voice once this says yes; everyone in the room is told who played what.
  out['sound.play'] = (c, d) => {
    const s = R.row(idOf(d.id, 'sound')) || fail('That sound was removed.');
    const place = hub.voicePlaceOf?.(c.user);
    const room = place && M.room(place);
    if (!room || room.house !== s.house) fail('Join a voice room in this sound’s house to play it.');
    if (!mayUse(c.user, s.house)) fail('Your role can’t use the soundboard in this house.');
    const st = hub.voiceStateOf?.(c.user) || {};
    if (st.smute || st.sdeaf) fail('A moderator muted you here.');
    if (st.muted || st.deaf) fail('Unmute to play sounds.');
    if (!perUser.take(c.user)) fail(`Wait a moment: one sound every ${SOUND_COOLDOWN_S} seconds.`);
    if (!perRoom.take(room.id)) fail('This room has heard a lot of sounds just now. Wait a moment.');
    const ev = { room: room.id, user: c.user, id: s.id, name: s.name, emoji: s.emoji || null, at: Date.now() };
    hub.toUsers(hub.voiceUsers?.(room.id) || [], 'sound.play', ev);
    return { file: s.file, volume: s.volume, cooldown: SOUND_COOLDOWN_S * 1000 };
  };

  return out;
}

// Uploads at POST /api/files?sound=<house>, and the files at GET /api/sounds/<file>.
export function createVoiceOptsHttp({ db, M, filesDir, sendJson, error, body, headers, uploadLimit }) {
  M.soundUnlink = (file) => { if (FILE_ID.test(file)) unlink(join(filesDir, file)).catch(() => {}); };
  return async function voiceOptsHttp(req, res, path, url, user) {
    if (req.method === 'POST' && path === '/api/files' && url.searchParams.has('sound')) {
      const house = url.searchParams.get('sound') || '';
      if (!/^[\w.-]{1,80}$/.test(house) || !db.get('SELECT 1 FROM houses WHERE id = ?', house)) { error(res, 404, 'That house doesn’t exist.'); return true; }
      if (!M.isMember(house, user)) { error(res, 403, 'You’re not a member of that house.'); return true; }
      if (!M.can(user, house, 'sounds')) { error(res, 403, 'Your role can’t manage the soundboard in this house.'); return true; }
      if (uploadLimit && !uploadLimit.take(user)) { error(res, 429, 'Too many uploads at once. Wait a moment.'); return true; }
      const size = Number(req.headers['content-length']);
      if (!size) { error(res, 400, 'That sound is empty.'); return true; }
      if (size > MAX_SOUND_BYTES) { error(res, 413, 'Sounds can be up to 512 KB.'); return true; }
      let data;
      try { data = await body(req, MAX_SOUND_BYTES); } catch (e) {
        if (e.status === 413) { error(res, 413, 'Sounds can be up to 512 KB.'); return true; }
        throw e;
      }
      const info = wavInfo(data);
      if (!info) { error(res, 415, 'Snug couldn’t read that sound. Choose an audio file again.'); return true; }
      if (info.seconds > MAX_SOUND_SECONDS) { error(res, 422, `That sound is ${info.seconds.toFixed(1)} seconds long. Sounds can be up to ${MAX_SOUND_SECONDS} seconds.`); return true; }
      const name = (decodeURIComponent(String(req.headers['x-file-name'] || 'sound')).replace(/[\u0000-\u001f\u007f/\\]/g, '').trim() || 'sound').slice(0, 120);
      const id = newId('f');
      await writeFile(join(filesDir, id), data, { mode: 0o600 });
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, user, `sound:${house}`, name, 'audio/wav', data.length, Date.now(), JSON.stringify({ sound: true, seconds: info.seconds }));
      sendJson(res, 201, { id, name, size: data.length, seconds: Math.round(info.seconds * 100) / 100 });
      return true;
    }
    // A house's sounds: its members only (and the uploader, before the sound is added).
    const m = /^\/api\/sounds\/(f_[a-z0-9]{8,40})$/.exec(path);
    if (req.method === 'GET' && m) {
      const row = db.get('SELECT * FROM files WHERE id = ?', m[1]);
      const house = row?.conv.startsWith('sound:') ? row.conv.slice(6) : null;
      if (!row || !house || !M.isMember(house, user) || !FILE_ID.test(row.id)) { error(res, 404, 'Not found'); return true; }
      headers(res, {
        'Content-Type': 'audio/wav', 'Content-Length': String(row.size), 'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      res.writeHead(200);
      createReadStream(join(filesDir, row.id)).pipe(res);
      return true;
    }
    return false;
  };
}
