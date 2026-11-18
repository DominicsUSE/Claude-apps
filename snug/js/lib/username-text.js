// What to tell someone about a Snug username they typed (design section 2.3).
// The rules themselves live in js/lib/usernames.js; this only turns a rule's
// code into a sentence, so the sign-in screen, Settings and the local server
// all say the same thing.
import { check, normalize } from './usernames.js';

export const NAME_RULES = '2 to 32 characters: lowercase letters, numbers, dots and underscores.';

// Why an invalid name is invalid, in the words someone can act on.
function invalidWhy(n) {
  if (!n) return 'Pick a username.';
  if (n.length < 2) return 'Usernames need at least 2 characters.';
  if (n.length > 32) return 'Usernames can be up to 32 characters.';
  if (/[^a-z0-9_.]/.test(n)) return 'Use only lowercase letters, numbers, dots and underscores.';
  if (/^[._]|[._]$/.test(n)) return 'A username can’t start or end with a dot or an underscore.';
  if (/[._]{2}/.test(n)) return 'Dots and underscores can’t sit next to each other.';
  return `Usernames are ${NAME_RULES}`;
}

// A registry or rule code -> one sentence. `name` is what was typed.
export function nameMessage(code, name = '') {
  const n = normalize(name);
  switch (code) {
    case 'invalid_name': return invalidWhy(n);
    case 'reserved':
    case 'owner_only': return 'That name is reserved. Try another.';
    case 'taken': return `@${n} is taken. Try another.`;
    case 'already_claimed': return 'This GitHub account already has a Snug username.';
    case 'rate_limited': return 'That’s a lot of tries. Wait a minute, then try again.';
    default: return null;
  }
}

// null when the name passes the local rules, else the sentence to show.
export function localNameProblem(name, { owner = false } = {}) {
  const code = check(name, { owner });
  return code ? nameMessage(code, name) : null;
}
