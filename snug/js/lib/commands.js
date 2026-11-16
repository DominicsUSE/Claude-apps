// Slash commands: the registry the composer suggests from, and the parsers.
// No DOM here: the server uses parseRoll too, and the tests run in Node.
//
// Each command: { name, hint, args: [{ name, hint, optional, rest }], kind }
//   kind 'text'   rewrites the message and sends it (/me, /shrug, /spoiler)
//   kind 'client' does something here without sending (/poll, /giphy, /status)
//   kind 'server' asks the server, which writes the result (/roll)
export const COMMANDS = [
  { name: 'me', hint: 'Say something about yourself, in italics', args: [{ name: 'action', hint: 'what you’re doing', rest: true }], kind: 'text' },
  { name: 'shrug', hint: 'Add ¯\\_(ツ)_/¯ to your message', args: [{ name: 'message', optional: true, rest: true }], kind: 'text' },
  { name: 'tableflip', hint: 'Add (╯°□°)╯︵ ┻━┻ to your message', args: [{ name: 'message', optional: true, rest: true }], kind: 'text' },
  { name: 'unflip', hint: 'Add ┬─┬ノ( º _ ºノ) to your message', args: [{ name: 'message', optional: true, rest: true }], kind: 'text' },
  { name: 'lenny', hint: 'Add ( ͡° ͜ʖ ͡°) to your message', args: [{ name: 'message', optional: true, rest: true }], kind: 'text' },
  { name: 'spoiler', hint: 'Send your message hidden until clicked', args: [{ name: 'message', rest: true }], kind: 'text' },
  { name: 'silent', hint: 'Send without a sound or notification', args: [{ name: 'message', rest: true }], kind: 'text' },
  { name: 'roll', hint: 'Roll dice, like 2d6. Everyone sees the result', args: [{ name: 'dice', hint: 'NdM, up to 20d1000', optional: true }], kind: 'server' },
  { name: 'poll', hint: 'Start a poll', args: [{ name: 'question', hint: 'question | answer | answer', rest: true, optional: true }], kind: 'client' },
  { name: 'giphy', hint: 'Find a GIF', args: [{ name: 'search', optional: true, rest: true }], kind: 'client' },
  { name: 'nick', hint: 'Change your nickname in this house', args: [{ name: 'nickname', optional: true, rest: true }], kind: 'client' },
  { name: 'status', hint: 'Set your status line, or clear it', args: [{ name: 'status', optional: true, rest: true }], kind: 'client' },
  { name: 'open', hint: 'Show that you are open to talk', args: [], kind: 'client' },
  { name: 'around', hint: 'Show that you are around', args: [], kind: 'client' },
  { name: 'focus', hint: 'Hold notifications while you work', args: [], kind: 'client' },
  { name: 'away', hint: 'Show that you are away', args: [], kind: 'client' },
];
const byName = new Map(COMMANDS.map((c) => [c.name, c]));
export const commandNamed = (name) => byName.get(String(name).toLowerCase()) || null;

export const FACES = { shrug: '¯\\_(ツ)_/¯', tableflip: '(╯°□°)╯︵ ┻━┻', unflip: '┬─┬ノ( º _ ºノ)', lenny: '( ͡° ͜ʖ ͡°)' };

// "/name rest" -> { name, rest, cmd } (cmd null for an unknown name), or null when not a command.
// "//text" is not a command: it sends "/text".
export function parseCommand(text) {
  const m = /^\/([a-z][\w-]{0,31})(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: (m[2] || '').trim(), cmd: commandNamed(m[1]) };
}

// Commands whose name starts with what is typed, for the suggestion row.
export function suggestCommands(typed, list = COMMANDS) {
  const q = String(typed || '').toLowerCase();
  return list.filter((c) => c.name.startsWith(q));
}

// Which argument the caret is in, for highlighting its chip: 0 for the first.
export function argIndex(cmd, rest) {
  if (!cmd?.args.length) return -1;
  const words = String(rest || '').split(/\s+/).filter(Boolean).length;
  const i = Math.max(0, String(rest || '').endsWith(' ') ? words : words - 1);
  const last = cmd.args.length - 1;
  return cmd.args[last].rest ? Math.min(i, last) : Math.min(i, last);
}

// A text command's message, or null when it needs text it didn't get.
export function textCommand(name, rest) {
  if (FACES[name]) return `${rest} ${FACES[name]}`.trim();
  if (name === 'me') return rest ? `_${rest.replace(/_/g, '\\_')}_` : null;
  if (name === 'spoiler') return rest ? `||${rest.replace(/\|\|/g, '| |')}||` : null;
  if (name === 'silent') return rest ? `@silent ${rest}` : null;
  return null;
}

// /roll NdM: 1 to 20 dice of 2 to 1000 sides. "d20" is one die; nothing is 1d6.
export const ROLL_MAX_DICE = 20;
export const ROLL_MAX_SIDES = 1000;
export function parseRoll(spec) {
  const s = String(spec ?? '').trim().toLowerCase();
  if (!s) return { n: 1, sides: 6 };
  const m = /^(\d{1,3})?d(\d{1,5})$/.exec(s);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  if (n < 1 || n > ROLL_MAX_DICE || sides < 2 || sides > ROLL_MAX_SIDES) return null;
  return { n, sides };
}
export const rollText = ({ n, sides }, rolls) => {
  const total = rolls.reduce((a, b) => a + b, 0);
  return n === 1 ? `rolled 1d${sides}: ${total}` : `rolled ${n}d${sides}: ${rolls.join(' + ')} = ${total}`;
};

// /poll Question | Answer | Answer -> { question, answers } (the modal opens prefilled).
export function parsePoll(rest) {
  const parts = String(rest || '').split('|').map((p) => p.trim());
  return { question: parts[0] || '', answers: parts.slice(1).filter(Boolean).slice(0, 10) };
}

// Quick edits typed into the composer:
//   s/old/new      replaces the first "old" in your last message
//   +:emoji:       reacts to the last message with that emoji
export function parseSubst(text) {
  const m = /^s\/((?:\\\/|[^/])+)\/((?:\\\/|[^/])*)\/?$/.exec(String(text || ''));
  if (!m) return null;
  const un = (x) => x.replace(/\\\//g, '/');
  return { from: un(m[1]), to: un(m[2]) };
}
export function parseReact(text) {
  const m = /^\+:([a-z0-9_+-]{1,40}):$/i.exec(String(text || '').trim());
  return m ? m[1].toLowerCase() : null;
}

// "@silent " at the start sends a message without a sound or a notification.
export function silentPrefix(text) {
  const m = /^@silent\s+([\s\S]+)$/.exec(String(text || ''));
  return m ? { silent: true, text: m[1] } : { silent: false, text };
}

// Quote: the first ten lines as "> " lines, then the author's handle.
export function quoteText(text, handle) {
  const lines = String(text || '').split('\n').slice(0, 10).map((l) => `> ${l}`);
  return `${lines.join('\n')}\n${handle ? `@${handle} ` : ''}`;
}

// Text emoticons (the textEmoticons setting): :) becomes 🙂 when sent, outside code.
const EMOTICONS = [[':-)', '🙂'], [':)', '🙂'], [':-(', '🙁'], [':(', '🙁'], [':-D', '😄'], [':D', '😄'], [';-)', '😉'], [';)', '😉'], [':-P', '😛'], [':P', '😛'], [':p', '😛'], [':o', '😮'], [':O', '😮'], ['<3', '❤️'], [":'(", '😢'], ['xD', '😆'], ['XD', '😆']];
export function emoticons(text) {
  return String(text || '').split(/(```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+)/).map((part, i) => {
    if (i % 2) return part;
    let out = part;
    for (const [from, to] of EMOTICONS) {
      const re = new RegExp(`(^|\\s)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g');
      out = out.replace(re, `$1${to}`);
    }
    return out;
  }).join('');
}

// The message length limit, and where the counter starts to show.
export const MAX_LEN = 4000;
export const WARN_LEN = 3500;
