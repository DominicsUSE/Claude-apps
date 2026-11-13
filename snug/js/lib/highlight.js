// A small code highlighter for fenced code blocks: keywords, strings,
// numbers and comments in a few common languages. It returns tokens, never
// HTML, so code can't inject markup. Anything else stays plain text.

const JS = 'abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield';
const LANGS = {
  js: { kw: JS, line: '//', block: ['/*', '*/'], str: '"\'`' },
  json: { kw: 'true false null', str: '"' },
  py: { kw: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return self try while with yield print', line: '#', str: '"\'' },
  css: { kw: 'important media import keyframes from to root hover focus active before after', block: ['/*', '*/'], str: '"\'' },
  sh: { kw: 'if then else elif fi for in do done while until case esac function return export local echo exit cd sudo set unset source alias', line: '#', str: '"\'' },
  sql: { kw: 'select from where and or not insert into values update set delete create table index drop alter join left right inner outer on group by order having limit offset as distinct null is in like between case when then else end primary key references default unique asc desc count sum avg min max', line: '--', block: ['/*', '*/'], str: '\'"', ci: true },
  go: { kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false', line: '//', block: ['/*', '*/'], str: '"`\'' },
  rust: { kw: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while', line: '//', block: ['/*', '*/'], str: '"' },
  html: { markup: true },
};
const ALIAS = {
  javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', node: 'js',
  python: 'py', py3: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', xml: 'html', svg: 'html', htm: 'html',
  postgres: 'sql', sqlite: 'sql', mysql: 'sql', golang: 'go', rs: 'rust', scss: 'css', less: 'css',
};
export const langOf = (lang) => { const l = String(lang || '').toLowerCase(); return LANGS[l] ? l : ALIAS[l] || null; };

const MAX = 20_000;
function push(out, t, v) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === t) last.v += v; else out.push({ t, v });
}

function markup(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const j = end < 0 ? src.length : end + 3;
      push(out, 'com', src.slice(i, j)); i = j; continue;
    }
    if (src[i] === '<' && /[a-zA-Z/!]/.test(src[i + 1] || '')) {
      const m = /^<\/?[a-zA-Z!][\w:-]*/.exec(src.slice(i));
      push(out, 'kw', m[0]); i += m[0].length;
      while (i < src.length && src[i] !== '>') {
        const rest = src.slice(i);
        const s = /^("[^"]*"?|'[^']*'?)/.exec(rest);
        if (s) { push(out, 'str', s[0]); i += s[0].length; continue; }
        const a = /^[\w:-]+/.exec(rest);
        if (a) { push(out, 'attr', a[0]); i += a[0].length; continue; }
        push(out, 'text', src[i]); i++;
      }
      if (src[i] === '>') { push(out, 'kw', '>'); i++; }
      continue;
    }
    const next = src.indexOf('<', i + 1);
    const j = next < 0 ? src.length : next;
    push(out, 'text', src.slice(i, j)); i = j;
  }
  return out;
}

// [{ t: 'kw'|'str'|'num'|'com'|'attr'|'text', v }]. Unknown languages and very long code: one text token.
export function highlight(code, lang) {
  const key = langOf(lang);
  const src = String(code || '');
  if (!key || src.length > MAX) return [{ t: 'text', v: src }];
  const L = LANGS[key];
  if (L.markup) return markup(src);
  const kw = new Set(L.kw.split(' ').map((w) => (L.ci ? w.toLowerCase() : w)));
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (L.line && src.startsWith(L.line, i)) {
      const end = src.indexOf('\n', i);
      const j = end < 0 ? src.length : end;
      push(out, 'com', src.slice(i, j)); i = j; continue;
    }
    if (L.block && src.startsWith(L.block[0], i)) {
      const end = src.indexOf(L.block[1], i + L.block[0].length);
      const j = end < 0 ? src.length : end + L.block[1].length;
      push(out, 'com', src.slice(i, j)); i = j; continue;
    }
    if (L.str.includes(c)) {
      let j = i + 1;
      while (j < src.length && src[j] !== c && !(src[j] === '\n' && c !== '`')) j += src[j] === '\\' ? 2 : 1;
      j = Math.min(src.length, j + 1);
      push(out, 'str', src.slice(i, j)); i = j; continue;
    }
    if (/[0-9]/.test(c) && !/[\w$]/.test(src[i - 1] || '')) {
      const m = /^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i.exec(src.slice(i));
      push(out, 'num', m[0]); i += m[0].length; continue;
    }
    if (/[A-Za-z_$@]/.test(c)) {
      const m = /^[@A-Za-z_$][\w$-]*/.exec(src.slice(i));
      let w = m[0];
      if (key !== 'css' && w.includes('-')) w = w.slice(0, w.indexOf('-'));
      push(out, kw.has(L.ci ? w.toLowerCase() : w.replace(/^@/, '')) ? 'kw' : 'text', w); i += w.length; continue;
    }
    push(out, 'text', c); i++;
  }
  return out;
}
