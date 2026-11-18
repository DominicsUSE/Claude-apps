// Text and messages, the pure rules: the emoji set (shortcodes, skin tones,
// ranking, frequently used), mention and room tokens, message links, slash
// commands and quick edits, and who a reply notifies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL, CATEGORIES, emojiByName, resolveShortcodes, withTone, rankEmoji, bumpUse, frequent, stripTone } from '../js/lib/emojis.js';
import { parse, plain, formatHooks, messageLinkOf } from '../js/lib/format.js';
import {
  parseCommand, suggestCommands, textCommand, parseRoll, rollText, parsePoll, parseSubst, parseReact, silentPrefix, quoteText, emoticons, COMMANDS,
} from '../js/lib/commands.js';
import { forMe } from '../js/lib/attention.js';
import { cleanPrefs, PREF_DEFAULTS } from '../js/lib/account.js';

test('emoji set: about 1,900 emoji in nine categories, every one with a name, modifiers flagged', () => {
  assert.ok(ALL.length >= 1800, `${ALL.length}`);
  assert.deepEqual(CATEGORIES.map(([id]) => id), ['smileys', 'people', 'nature', 'food', 'activities', 'travel', 'objects', 'symbols', 'flags']);
  assert.ok(ALL.every((e) => e.c && e.names.length && /^[a-z0-9_+-]+$/.test(e.names[0])));
  assert.equal(emojiByName('wave').c, '👋');
  assert.equal(emojiByName('waving_hand').tone, true);
  assert.equal(emojiByName('joy').tone, false);
  assert.ok(ALL.filter((e) => e.tone).length > 250);
  // The longest entry fits the server's reaction check (32), with a tone on every person.
  assert.ok(Math.max(...ALL.map((e) => withTone(e.c, 5).length)) <= 32);
});

test('shortcodes: :name: becomes the emoji, with the skin tone; unknown names and code stay as typed', () => {
  assert.equal(resolveShortcodes(':wave: hello'), '👋 hello');
  assert.equal(resolveShortcodes(':wave: :thumbsup::tada:', 3), '👋🏽 👍🏽🎉');
  assert.equal(resolveShortcodes(':not_an_emoji: and :WAVE:'), ':not_an_emoji: and 👋');
  assert.equal(resolveShortcodes('`:wave:` ```\n:wave:\n```'), '`:wave:` ```\n:wave:\n```');
  assert.equal(resolveShortcodes('at 10:30:00 or http://a:fire:'), 'at 10:30:00 or http://a:fire:');
  assert.equal(resolveShortcodes('<:party:em_abcdefgh12> :fire:'), '<:party:em_abcdefgh12> 🔥');
});

test('skin tones: after each person, never on the handshake inside a pair, variation selector dropped', () => {
  assert.equal(withTone('👋', 1), '👋🏻');
  assert.equal(withTone('✌️', 5), '✌🏿');
  assert.equal(withTone('🧑‍🤝‍🧑', 2), '🧑🏼‍🤝‍🧑🏼');
  assert.equal(withTone('👩‍❤️‍💋‍👨', 3), '👩🏽‍❤️‍💋‍👨🏽');
  assert.equal(withTone('🏃‍♀️', 4), '🏃🏾‍♀️');
  assert.equal(withTone('😀', 3), '😀', 'faces take no tone');
  assert.equal(withTone('👋', 0), '👋');
  assert.equal(stripTone('👋🏽'), '👋');
});

test('ranking: a name that starts with the term, then a word in a name, then keywords', () => {
  assert.equal(rankEmoji('wave')[0].c, '👋');
  assert.equal(rankEmoji('thumb')[0].c, '👍');
  assert.equal(rankEmoji(':fire:')[0].c, '🔥');
  const happy = rankEmoji('happy', ALL, 10).map((e) => e.c);
  assert.ok(happy.includes('😀'), 'by keyword');
  const heart = rankEmoji('heart', ALL, 3);
  assert.ok(heart.every((e) => e.names.some((n) => n.includes('heart'))), 'names before keywords');
  assert.equal(rankEmoji('zzqqx').length, 0);
});

test('frequently used: counts go up, at most 40 kept, the least used drop out; the setting is checked', () => {
  let use = {};
  for (let i = 0; i < 45; i++) use = bumpUse(use, String.fromCodePoint(0x1F600 + i));
  use = bumpUse(use, '😀'); use = bumpUse(use, '😀');
  assert.equal(Object.keys(use).length, 40);
  assert.equal(frequent(use)[0], '😀');
  assert.deepEqual(cleanPrefs({ emojiUse: { '👋🏽': 3 }, skinTone: 2 }), { emojiUse: { '👋🏽': 3 }, skinTone: 2 });
  assert.throws(() => cleanPrefs({ emojiUse: { hello: 1 } }), /isn’t valid/);
  assert.throws(() => cleanPrefs({ emojiUse: { '👋': 1.5 } }), /isn’t valid/);
  assert.throws(() => cleanPrefs({ emojiUse: Object.fromEntries([...Array(41)].map((_, i) => [String.fromCodePoint(0x1F600 + i), 1])) }), /40/);
  assert.throws(() => cleanPrefs({ skinTone: 6 }), /0 to 5/);
  assert.equal(PREF_DEFAULTS.showIds, false);
});

test('mentions: @everyone, @here, roles by name (people first), <#room>; plain() reads rooms by name', () => {
  formatHooks.role = (after) => (/^studio lead(?![\w])/i.test(after) ? { id: 'r1', name: 'Studio lead', hue: 35, len: 11 } : null);
  formatHooks.roomName = (id) => ({ r_glaze: 'glaze-lab' })[id] || null;
  try {
    const t = parse('@everyone @here hi @Studio lead and @ada in <#r_glaze> or <#r_secret>');
    const kinds = t.filter((x) => x.t !== 'text').map((x) => [x.t, x.v]);
    assert.deepEqual(kinds, [['everyone', 'everyone'], ['everyone', 'here'], ['role', 'Studio lead'], ['at', 'ada'], ['room', 'r_glaze'], ['room', 'r_secret']]);
    assert.equal(t.find((x) => x.t === 'role').hue, 35);
    assert.equal(parse('mail@everyone.com').some((x) => x.t === 'everyone'), false);
    assert.equal(parse('`@everyone`')[0].t, 'code');
    assert.equal(plain('see <#r_glaze> not <#r_secret>'), 'see #glaze-lab not #unknown room');
  } finally { formatHooks.role = null; formatHooks.roomName = null; }
});

test('message links: only this Snug’s /m/<conversation>/<message> becomes a card token', () => {
  formatHooks.origin = 'https://snug.example';
  try {
    assert.deepEqual(messageLinkOf('https://snug.example/m/r_desk/m_abc12345'), { conv: 'r_desk', id: 'm_abc12345' });
    assert.deepEqual(messageLinkOf('https://snug.example/m/t:m_root1234/m_abc12345'), { conv: 't:m_root1234', id: 'm_abc12345' });
    assert.equal(messageLinkOf('https://other.example/m/r_desk/m_abc12345'), null);
    assert.equal(messageLinkOf('https://snug.example/m/r_desk'), null);
    const t = parse('look https://snug.example/m/r_desk/m_abc12345 and https://x.example/');
    assert.deepEqual(t.filter((x) => x.t !== 'text').map((x) => x.t), ['msglink', 'link']);
  } finally { formatHooks.origin = ''; }
});

test('slash commands: parse, suggest, text commands, /roll specs, /poll, unknown names', () => {
  assert.deepEqual(parseCommand('/me waves'), { name: 'me', rest: 'waves', cmd: COMMANDS.find((c) => c.name === 'me') });
  assert.equal(parseCommand('/nope x').cmd, null);
  assert.equal(parseCommand('not a command'), null);
  assert.equal(parseCommand('/ space'), null);
  assert.deepEqual(suggestCommands('ro').map((c) => c.name), ['roll']);
  assert.ok(suggestCommands('').length >= 15);
  assert.equal(textCommand('me', 'waves'), '_waves_');
  assert.equal(textCommand('me', ''), null);
  assert.equal(textCommand('shrug', 'ok'), 'ok ¯\\_(ツ)_/¯');
  assert.equal(textCommand('tableflip', ''), '(╯°□°)╯︵ ┻━┻');
  assert.equal(textCommand('spoiler', 'the end'), '||the end||');
  assert.equal(textCommand('silent', 'psst'), '@silent psst');
  assert.deepEqual(parseRoll(''), { n: 1, sides: 6 });
  assert.deepEqual(parseRoll('2d6'), { n: 2, sides: 6 });
  assert.deepEqual(parseRoll('D20'), { n: 1, sides: 20 });
  for (const bad of ['0d6', '21d6', 'd1', '2d1001', '2d6+1', 'x', '1d']) assert.equal(parseRoll(bad), null, bad);
  assert.equal(rollText({ n: 2, sides: 6 }, [3, 5]), 'rolled 2d6: 3 + 5 = 8');
  assert.equal(rollText({ n: 1, sides: 20 }, [17]), 'rolled 1d20: 17');
  assert.deepEqual(parsePoll('Lunch? | Pizza | Soup |'), { question: 'Lunch?', answers: ['Pizza', 'Soup'] });
});

test('quick edits and prefixes: s/old/new, +:emoji:, @silent, quote, emoticons', () => {
  assert.deepEqual(parseSubst('s/teh/the'), { from: 'teh', to: 'the' });
  assert.deepEqual(parseSubst('s/a\\/b/c/'), { from: 'a/b', to: 'c' });
  assert.deepEqual(parseSubst('s/typo//'), { from: 'typo', to: '' });
  assert.equal(parseSubst('so/what'), null);
  assert.equal(parseReact('+:tada:'), 'tada');
  assert.equal(parseReact('+:tada: yes'), null);
  assert.deepEqual(silentPrefix('@silent hello'), { silent: true, text: 'hello' });
  assert.equal(silentPrefix('@silently').silent, false);
  assert.equal(quoteText('one\ntwo', 'ada'), '> one\n> two\n@ada ');
  assert.equal(quoteText(Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n'), 'x').split('\n').filter((l) => l.startsWith('> ')).length, 10);
  assert.equal(emoticons('hi :) and `:)` <3'), 'hi 🙂 and `:)` ❤️');
  assert.equal(emoticons('http://a.b/:)'), 'http://a.b/:)');
});

test('attention: a reply with the mention off isn’t for me; an @mention in it still is', () => {
  const S = {
    me: 'u_me', users: { u_me: { id: 'u_me', handle: 'me' }, u_x: { id: 'u_x', handle: 'x' } },
    msgs: { r1: [{ id: 'm1', author: 'u_me', text: 'mine', ts: 1 }] }, rooms: {}, houses: {}, threads: {}, dms: {}, prefs: {},
  };
  assert.equal(forMe(S, 'r1', { id: 'm2', author: 'u_x', text: 'reply', replyTo: 'm1' }), true);
  assert.equal(forMe(S, 'r1', { id: 'm3', author: 'u_x', text: 'reply', replyTo: 'm1', replyPing: false }), false);
  assert.equal(forMe(S, 'r1', { id: 'm4', author: 'u_x', text: '@me reply', replyTo: 'm1', replyPing: false }), true);
});
