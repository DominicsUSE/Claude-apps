// Snug 0.13: polls with friends on other PCs. A poll, its votes and its end travel
// between the PCs (dm.poll, dm.vote, dm.pollend; in groups the signed items poll,
// vote and pollend), only to PCs whose signed profile says they understand polls.
// Every PC shows the same counts; the latest vote of each person counts. When a
// friend's or member's PC is older (0.12.0 or 0.11), the poll is refused and the
// message names them.
process.env.SNUG_GROUP_FWD_MS = '200';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, startPc, signUp, until, mid } from './helpers/p2p.js';
import { threePcs } from './helpers/groups.js';
import { dmIdFor } from '../server/peercrypto.js';

let registry;
const pcs = [];
const pc = async (o) => { const s = await startPc(registry, o); pcs.push(s); return s; };
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });

let gh = 80_000;
const uidOf = (c) => c.id.slice(2);
async function friends(nameA, nameB) {
  const A = await pc(), B = await pc();
  const a = await signUp(A, registry, ++gh, nameA);
  const b = await signUp(B, registry, ++gh, nameB);
  await a.ok('friend.request', { handle: nameB });
  const req = await b.next('friend', (d) => d.friend?.state === 'incoming');
  await b.ok('friend.accept', { user: req.id });
  await a.next('friend', (d) => d.friend?.state === 'friends');
  await until(() => A.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(a)), 8000, 'presence');
  const dm = dmIdFor(uidOf(a), uidOf(b));
  assert.equal((await a.ok('dm.open', { users: [b.id] })).id, dm);
  return { A, B, a, b, dm };
}
// The counts per answer and who voted, as the poll's PC stores them.
const counts = (s, id) => {
  const p = s.db.get('SELECT answers FROM polls WHERE msg = ?', id);
  if (!p) return null;
  const out = JSON.parse(p.answers).map(() => 0);
  for (const v of s.db.all('SELECT answer FROM poll_votes WHERE msg = ?', id)) out[v.answer]++;
  return out.join(',');
};
const votesOf = (s, id, user) => s.db.all('SELECT answer FROM poll_votes WHERE msg = ? AND user = ? ORDER BY answer', id, user).map((r) => r.answer).join(',');
const ANSWERS = [{ text: 'Pizza' }, { text: 'Noodles' }, { text: 'Salad' }];
const caps = (s, uid) => s.peer.capsOf(uid);

let pair;
test('a poll in a direct conversation reaches the friend’s PC; both votes reach both PCs; ending it ends it there too', async () => {
  pair = await friends('pollann', 'pollben');
  const { A, B, a, b, dm } = pair;
  await until(() => caps(A, uidOf(b)).includes('poll') && caps(B, uidOf(a)).includes('poll'), 8000, 'both PCs say they know polls');
  const id = mid();
  await a.ok('poll.create', { conv: dm, id, question: 'Lunch?', answers: ANSWERS, hours: 24 });
  await until(() => B.db.get('SELECT 1 FROM polls WHERE msg = ?', id), 8000, 'the poll on Ben’s PC');
  const pa = A.db.get('SELECT * FROM polls WHERE msg = ?', id), pb = B.db.get('SELECT * FROM polls WHERE msg = ?', id);
  assert.equal(pb.question, 'Lunch?');
  assert.equal(pb.by, a.id, 'by Ann (her shadow on Ben’s PC)');
  assert.deepEqual(JSON.parse(pb.answers).map((x) => x.text), ['Pizza', 'Noodles', 'Salad']);
  assert.equal(pb.ends, pa.ends, 'it closes at the same moment on both PCs');
  assert.equal(B.db.get('SELECT text FROM messages WHERE id = ?', id).text, 'Lunch?');
  // Ben's page sees a poll, not just a line of text.
  const view = await b.ok('poll.view', { conv: dm, id });
  assert.equal(view.poll.question, 'Lunch?');

  await b.ok('poll.vote', { conv: dm, id, answers: [1] });
  await a.ok('poll.vote', { conv: dm, id, answers: [0] });
  await until(() => counts(A, id) === '1,1,0' && counts(B, id) === '1,1,0', 8000, 'the same counts on both PCs');
  // Ben changes his mind: only his latest vote counts, everywhere.
  await b.ok('poll.vote', { conv: dm, id, answers: [2] });
  await until(() => counts(A, id) === '1,0,1' && counts(B, id) === '1,0,1', 8000, 'Ben’s new vote on both PCs');
  assert.equal(votesOf(A, id, b.id), '2');
  // Ann's page hears about Ben's vote.
  await a.next('poll', (d) => d.id === id && d.poll?.counts?.join(',') === '1,0,1');

  await a.ok('poll.end', { conv: dm, id });
  await until(() => B.db.get('SELECT ended FROM polls WHERE msg = ?', id)?.ended, 8000, 'ended on Ben’s PC');
  assert.match(await b.refused('poll.vote', { conv: dm, id, answers: [0] }), /ended/);
});

test('a poll in a thread of a direct conversation lands in the same thread on the friend’s PC', async () => {
  const { B, a, b, dm } = pair;
  const root = mid();
  await a.ok('msg.send', { conv: dm, id: root, text: 'thread for a poll' });
  await a.ok('msg.send', { conv: `t:${root}`, id: mid(), text: 'first reply' });
  await until(() => B.db.get('SELECT 1 FROM threads WHERE id = ?', `t:${root}`), 8000, 'the thread on Ben’s PC');
  const id = mid();
  await a.ok('poll.create', { conv: `t:${root}`, id, question: 'In the thread?', answers: ANSWERS.slice(0, 2), hours: 1 });
  await until(() => B.db.get('SELECT conv FROM messages WHERE id = ?', id), 8000, 'the poll on Ben’s PC');
  assert.equal(B.db.get('SELECT conv FROM messages WHERE id = ?', id).conv, `t:${root}`);
  await b.ok('poll.vote', { conv: `t:${root}`, id, answers: [1] });
  await until(() => counts(pair.A, id) === '0,1', 8000, 'Ben’s vote on Ann’s PC');
});

test('a friend whose PC is older (0.12.0) can’t be sent a poll: it is refused and names them', async () => {
  const { A, a, b, dm } = pair;
  A.peer._setCaps(uidOf(b), ['thread', 'pin', 'ttl']); // what a 0.12.0 PC says
  const err = await a.refused('poll.create', { conv: dm, id: mid(), question: 'Old PC?', answers: ANSWERS, hours: 24 });
  assert.match(err, /pollben/);
  assert.match(err, /update/i);
  A.peer._setCaps(uidOf(b), null);
});

test('a poll in a group across PCs: every member votes, every PC shows the same counts, the end syncs', async () => {
  const t = await threePcs(registry, pcs, ['pgana', 'pgbea', 'pgcal']);
  const { A, B, C, a, b, c } = t;
  const g = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const all = [a.id, b.id, c.id].sort().join();
  const members = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user).join();
  await until(() => members(B) === all && members(C) === all, 12_000, 'group on every PC');
  await until(() => [B, C].every((s) => caps(s, uidOf(a)).includes('poll')) && caps(A, uidOf(b)).includes('poll') && caps(A, uidOf(c)).includes('poll'), 12_000, 'caps');
  const id = mid();
  await a.ok('poll.create', { conv: g, id, question: 'Movie night?', answers: ANSWERS, hours: 24, multi: true });
  await until(() => B.db.get('SELECT 1 FROM polls WHERE msg = ?', id) && C.db.get('SELECT 1 FROM polls WHERE msg = ?', id), 12_000, 'the poll on every PC');
  assert.equal(C.db.get('SELECT multi FROM polls WHERE msg = ?', id).multi, 1);
  await b.ok('poll.vote', { conv: g, id, answers: [0, 2] });
  await c.ok('poll.vote', { conv: g, id, answers: [1] });
  await a.ok('poll.vote', { conv: g, id, answers: [2] });
  await until(() => [A, B, C].every((s) => counts(s, id) === '1,1,2'), 15_000, 'the same counts on every PC');
  await c.ok('poll.vote', { conv: g, id, answers: [0] });
  await until(() => [A, B, C].every((s) => counts(s, id) === '2,0,2'), 15_000, 'Cal’s new vote everywhere');
  // Only the person who started it can end it; that reaches every PC.
  assert.match(await b.refused('poll.end', { conv: g, id }), /started the poll/);
  await a.ok('poll.end', { conv: g, id });
  await until(() => B.db.get('SELECT ended FROM polls WHERE msg = ?', id)?.ended && C.db.get('SELECT ended FROM polls WHERE msg = ?', id)?.ended, 12_000, 'ended everywhere');
  // A member whose PC is older: the poll is refused, naming them.
  A.peer._setCaps(uidOf(c), ['thread', 'pin', 'ttl']);
  const err = await a.refused('poll.create', { conv: g, id: mid(), question: 'Again?', answers: ANSWERS, hours: 1 });
  assert.match(err, /pgcal/);
  A.peer._setCaps(uidOf(c), null);
});
