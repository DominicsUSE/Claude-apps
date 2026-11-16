// Full-text search over messages with SQLite FTS5 (0.12).
//
// messages_fts indexes the diacritic-folded `fold` column of `messages` as an
// external-content table: the words live once in the index, the text stays in
// `messages`. Triggers keep it in step with every insert, edit, wipe and
// delete, wherever in the server they happen. `secure-delete` makes a delete
// remove a message's words from the index at once, in keeping with
// PRAGMA secure_delete on the rest of the database (server/db.js).
//
// If this Node's SQLite lacks FTS5, nothing here is created and search keeps
// its substring scan (server/model.js).

export function migrateFts(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_probe USING fts5(x); DROP TABLE temp.fts_probe;");
  } catch {
    return false;
  }
  const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get();
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(fold, content='messages', content_rowid='seq',
      tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, fold) VALUES (new.seq, new.fold);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, fold) VALUES ('delete', old.seq, old.fold);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF fold ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, fold) VALUES ('delete', old.seq, old.fold);
      INSERT INTO messages_fts(rowid, fold) VALUES (new.seq, new.fold);
    END;
  `);
  db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('secure-delete', 1)");
  // A database from before 0.12: index what is already there, in one pass.
  if (fresh) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.messages_vocab USING fts5vocab(main, 'messages_fts', 'row')");
  return true;
}

// The index's tokenizer splits on anything that isn't a letter or digit, so
// a search term splits the same way. Terms the index can't serve (single
// characters, emoji, symbols) are left to the substring scan.
const WORD = /[\p{L}\p{N}]+/gu;
const PLAIN = /^[\p{L}\p{N}]+(?:[-'’.][\p{L}\p{N}]+)*$/u; // words, maybe joined by - ' or .
export function splitTerms(terms) {
  const fts = [], like = [];
  for (const t of terms) {
    const parts = t.match(WORD) || [];
    if (PLAIN.test(t) && parts.every((p) => p.length >= 2)) fts.push(parts);
    else like.push(t);
  }
  return { fts, like };
}

// One MATCH expression: every term must be there; a term's last word matches
// as a prefix. Words are quoted, so FTS syntax typed in the box (OR, NEAR,
// *, ^, -) is plain text.
export function matchExpr(fts) {
  return fts.map((parts) => `"${parts.join(' ')}"*`).join(' AND ');
}

// Close matches for a word the index doesn't know: indexed words that start
// with the same letter and are one edit away (two for longer words). Edits
// are insertions, deletions, substitutions and swaps of neighbours.
// `ok(term)` says whether a term counts (review-media 2: only words the searcher could find, so the cap of
// `max` is applied after the visibility filter and words in conversations they can't read leave no trace).
// The scan has no row window: any cut-off that counts words of the whole server (a window of rows, or a
// cap on how many candidates are checked) could be padded to its edge from another account and then
// tell whether one more unreadable word exists. It streams the words with that first letter and length,
// about 2 µs each, and stops once `max` words count.
export function closeWords(db, word, max = 8, ok = () => true) {
  if (word.length < 4) return [];
  const first = word[0];
  const limit = word.length > 6 ? 2 : 1;
  const sql = 'SELECT term FROM temp.messages_vocab WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?';
  const args = [first, first + '\u{10FFFF}', word.length - limit, word.length + limit];
  const rows = db.raw?.prepare ? db.raw.prepare(sql).iterate(...args) : db.all(sql, ...args);
  const out = [];
  for (const { term } of rows) {
    if (term !== word && editDistance(word, term, limit) <= limit && ok(term)) out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

// Optimal string alignment distance, giving up once it passes `cap`.
export function editDistance(a, b, cap = Infinity) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}
