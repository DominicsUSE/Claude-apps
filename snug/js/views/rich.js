// Rich text pieces beyond the basics (js/ui/kit.js draws the rest): headings,
// subtext, quotes, lists, underline, spoilers, masked links, dynamic
// timestamps and code blocks with a language label, highlighting and Copy.
// Everything is built from tokens as elements; no message text ever becomes HTML.
import { html, useState } from '../../vendor/preact-htm.js';
import { S, openModal, closeModal, persist, toast } from '../store.js';
import { fmtStamp } from '../lib/format.js';
import { highlight, langOf } from '../lib/highlight.js';
import { fmtFull } from '../lib/util.js';
import { Icon } from '../ui/icons.js';

function copy(text) {
  try { navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy. Select the text and copy it by hand.')); } catch { toast('Couldn’t copy. Select the text and copy it by hand.'); }
}

export function CodeBlock({ lang, v }) {
  const key = langOf(lang);
  const [copied, setCopied] = useState(false);
  const label = lang || 'Code';
  const onCopy = () => { copy(v); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return html`<div class="codeblock" data-lang=${key || ''}>
    <div class="cb-head">
      <span class="cb-lang">${label}</span>
      <button class="cb-copy" type="button" aria-label=${`Copy ${lang ? `${lang} ` : ''}code`} onClick=${onCopy}>
        <${Icon} name=${copied ? 'check' : 'copy'} size=${14} />${copied ? 'Copied' : 'Copy'}
      </button>
    </div>
    <pre><code>${highlight(v, lang).map((t, i) => (t.t === 'text' ? t.v : html`<span key=${i} class=${`hl-${t.t}`}>${t.v}</span>`))}</code></pre>
  </div>`;
}

// Hidden until clicked (or Enter/Space). Screen readers don't hear it before then either.
function Spoiler({ children }) {
  const [open, setOpen] = useState(false);
  if (open) return html`<span class="spoiler open">${children}</span>`;
  const reveal = (e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); };
  return html`<span class="spoiler" role="button" tabindex="0" aria-label="Spoiler. Select to show it."
    onClick=${reveal} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') reveal(e); }}><span class="spoiler-in" aria-hidden="true">${children}</span></span>`;
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const trusted = (host) => host === location.hostname || (S.prefs.trustedHosts || []).includes(host);

function LeaveSnug({ url, host }) {
  const [always, setAlways] = useState(false);
  const go = () => {
    if (always) { S.prefs.trustedHosts = [...new Set([...(S.prefs.trustedHosts || []), host])].slice(-200); persist(); }
    closeModal();
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  return html`
    <h2>Leaving Snug</h2>
    <p class="modal-lead">This link goes to <b>${host}</b>, not to where its text might suggest.</p>
    <p class="leave-url" dir="ltr">${url}</p>
    <label class="check"><input type="checkbox" checked=${always} onChange=${(e) => setAlways(e.target.checked)} /> Don’t ask again for ${host}</label>
    <div class="modal-foot">
      <button class="btn" data-autofocus onClick=${closeModal}>Go back</button>
      <button class="btn primary" onClick=${go}>Open ${host}</button>
    </div>`;
}

// [text](https://...): the real host shows on hover, and an unfamiliar host asks first.
function MaskedLink({ url, children }) {
  const host = hostOf(url);
  const onClick = (e) => {
    if (trusted(host)) return;
    e.preventDefault();
    openModal(LeaveSnug, { url, host });
  };
  return html`<a class="mlink" href=${url} target="_blank" rel="noopener noreferrer" data-tip=${host} aria-description=${`Goes to ${host}`} onClick=${onClick}>${children}</a>`;
}

function Stamp({ v, style }) {
  const ms = v * 1000;
  const ok = Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
  return html`<time class="stamp" datetime=${ok ? new Date(ms).toISOString() : undefined} data-tip=${ok ? fmtFull(ms) : undefined}>${fmtStamp(v, style)}</time>`;
}

// The renderer for every token kit.js doesn't know. `render` draws children.
export function renderExtra(t, ctx, render) {
  switch (t.t) {
    case 'u': return html`<u>${render(t.c, ctx)}</u>`;
    case 'spoiler': return html`<${Spoiler}>${render(t.c, ctx)}<//>`;
    case 'mlink': return html`<${MaskedLink} url=${t.v}>${render(t.c, ctx)}<//>`;
    case 'ts': return html`<${Stamp} v=${t.v} style=${t.style} />`;
    case 'h': {
      const Tag = t.level === 1 ? 'h3' : t.level === 2 ? 'h4' : 'h5';
      return html`<${Tag} class=${`rh rh${t.level}`}>${render(t.c, ctx)}<//>`;
    }
    case 'sub': return html`<small class="rsub">${render(t.c, ctx)}</small>`;
    case 'quote': return html`<blockquote class="rquote">${render(t.c, ctx)}</blockquote>`;
    case 'list': {
      const items = t.items.map((it, i) => html`<li key=${i} class=${it.depth ? `d${it.depth}` : ''}>${render(it.c, ctx)}</li>`);
      return t.ordered ? html`<ol class="rlist" start=${t.start}>${items}</ol>` : html`<ul class="rlist">${items}</ul>`;
    }
    default: return null;
  }
}
