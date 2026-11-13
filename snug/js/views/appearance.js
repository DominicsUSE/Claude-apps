// Customisation pages: Appearance (live preview, themes and the theme
// builder, accent, chat display, fonts), the profile picture editor and
// profile styling (decorations, name style, profile colours), notification
// sounds, and the keyboard shortcut editor.
//
// Every value is checked by js/lib/account.js cleanPrefs (themes and accents
// with the contrast rules in js/lib/theme.js and js/lib/colour.js), and the
// server runs the same checks (server/appearance.js, server/account.js).
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, me, setPref, toast, openLayer } from '../store.js';
import { call } from '../server.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Seg, Switch, nameAttrs, profileColours } from '../ui/kit.js';
import { HUES, hueOf } from '../lib/util.js';
import { contrastRatio, ratioLabel, profileInk, HEX } from '../lib/colour.js';
import {
  THEME_PRESETS, THEME_NOTES, ACCENT_PRESETS, accentHex, accentProblem, accentTokens, deriveTheme, cleanTheme, decodeTheme, themeForCode,
  newThemeId, customId, MAX_THEMES, DECORATIONS, NAME_FONTS, NAME_WEIGHTS,
} from '../lib/theme.js';
import { ACTIONS, bindings, comboKeys, conflictOf, eventCombo } from '../lib/keys.js';
import { SOUND_KINDS, SOUND_PACKS, packOf, soundFor } from '../lib/account.js';
import { playSound, SOUND_LIST, effectivePrefs, setLook, deviceLook, setDeviceOnly, resolveTheme } from '../account.js';
// The real message component, handed over by js/views/settings.js (importing
// js/views/stream.js from here would make an import cycle through the settings).
let Message = () => null;
export const setMessageComponent = (C) => { Message = C; };

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const Row = ({ label, hint, children, top, id }) => html`<div class=${`set-row${top ? ' top' : ''}`} id=${id}>
  <div class="set-label"><b>${label}</b>${hint && html`<span>${hint}</span>`}</div><div class="set-ctl">${children}</div></div>`;
const Badge = ({ ratio, need, label }) => {
  const ok = ratio >= need;
  return html`<span class=${`ap-badge${ok ? '' : ' bad'}`} aria-label=${`${label || 'Contrast'} ${ratioLabel(ratio)}, ${ok ? 'readable' : `needs ${need}:1`}`}>
    <${Icon} name=${ok ? 'check' : 'alert'} size=${12} />${ratioLabel(ratio)}</span>`;
};
let settingsLayer = null;
export const setSettingsLayer = (C) => { settingsLayer = C; };

// ---------- Live preview ----------
// Two message groups drawn with the real message component, so every
// setting below shows as it will in a conversation.
const PV = 'ap:preview';
function previewMsgs() {
  const meId = S.me;
  const other = Object.keys(S.users).find((id) => id !== meId && !S.users[id].deleted) || meId;
  const t = Date.now() - 9 * 60000;
  const handle = S.users[meId]?.handle || 'you';
  return [
    { id: 'pv1', conv: PV, author: other, ts: t, text: 'Swap half the kaolin for calcined: same chemistry, much less shrinkage. Notes at https://snug.example/glazes', reactions: { '🔥': [meId, other], '👍': [other] } },
    { id: 'pv2', conv: PV, author: other, ts: t + 30000, text: `@${handle} could you check \`cone 6\` on the test tiles?` },
    { id: 'pv3', conv: PV, author: meId, ts: t + 4 * 60000, text: 'On it. They come out of the kiln at four 🙂', replyTo: 'pv2' },
    { id: 'pv4', conv: PV, author: meId, ts: t + 4 * 60000 + 20000, text: '🏺' },
  ];
}
export function AppearancePreview() {
  const [shut, setShut] = useState(false);
  const list = previewMsgs();
  // The messages exist only while the preview draws (the quote looks them up).
  S.msgs[PV] = list;
  useLayoutEffect(() => { delete S.msgs[PV]; });
  return html`<section class=${`ap-preview${shut ? ' collapsed' : ''}`} aria-label="Preview">
    <div class="ap-preview-head"><span>Preview</span>
      <button class="btn quiet" aria-expanded=${String(!shut)} onClick=${() => setShut(!shut)}>${shut ? 'Show' : 'Hide'}</button></div>
    <div class="ap-preview-body" aria-hidden="true" inert>
      ${list.map((m, i) => html`<${Message} key=${m.id} conv=${PV} m=${m} grouped=${i > 0 && list[i - 1].author === m.author && m.id !== 'pv3'} />`)}
    </div>
    <div class="ap-preview-foot" aria-hidden="true"><span class="btn primary">Send</span><span class="btn">Cancel</span><button class="switch" role="switch" aria-checked="true" tabindex="-1"></button></div>
  </section>`;
}

// ---------- Themes ----------
function Swatch({ bg, surface, text, accent }) {
  return html`<span class="ap-swatch" aria-hidden="true" style=${`background:${bg}`}>
    <span><i style=${`background:${text}`}></i><i style=${`background:${text}`}></i></span>
    <span style=${`background:${surface}`}><b style=${`background:${accent}`}></b></span></span>`;
}
const presetLook = (id) => {
  const t = THEME_PRESETS[id];
  return { bg: t.bg1, surface: t.bg2, text: t.text1, accent: ACCENT_PRESETS.violet[t.base] };
};
function ThemeCards() {
  const p = effectivePrefs();
  const cur = THEME_PRESETS[p.theme] || customId(p.theme) ? p.theme : 'system';
  const cards = ['system', ...Object.keys(THEME_PRESETS)];
  return html`<div class="ap-cards" role="radiogroup" aria-label="Theme">
    ${cards.map((id) => {
      const look = id === 'system' ? presetLook(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : presetLook(id);
      const label = id === 'system' ? 'Match device' : THEME_PRESETS[id].label;
      return html`<button key=${id} type="button" role="radio" class="ap-card" data-theme-id=${id} aria-checked=${String(cur === id)}
        aria-label=${`${label}${THEME_NOTES[id] ? `. ${THEME_NOTES[id]}` : ''}`} onClick=${() => setLook('theme', id)}>
        <${Swatch} ...${look} />
        <span class="ap-card-name">${label}${cur === id && html`<${Icon} name="check" size=${14} />`}</span>
      </button>`;
    })}
  </div>`;
}

const BLANK = { name: '', base: 'dark', bg: '#1E2228', surface: '#252A31', text: '#E8ECF1', accent: '#7AA2F7' };
function ColourField({ id, label, value, onChange, badge }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (v) => { const h = v.startsWith('#') ? v : `#${v}`; if (HEX.test(h)) onChange(h.toUpperCase()); };
  return html`<div class="ap-field">
    <label for=${id}>${label}</label>
    <input id=${id} class="field ap-hex" maxlength="7" spellcheck="false" autocomplete="off" value=${text} aria-invalid=${HEX.test(text) ? undefined : 'true'}
      onInput=${(e) => { setText(e.target.value); commit(e.target.value.trim()); }} />
    <input type="color" class="ap-color" aria-label=${`${label}, colour picker`} value=${HEX.test(value) ? value.toLowerCase() : '#000000'} onInput=${(e) => onChange(e.target.value.toUpperCase())} />
    ${badge}
  </div>`;
}

export function ThemeBuilder({ start, onDone }) {
  const [t, setT] = useState(() => ({ ...BLANK, ...(start || {}) }));
  const [err, setErr] = useState('');
  const set = (patch) => { setT({ ...t, ...patch }); setErr(''); };
  const d = deriveTheme(t);
  const tok = d.tokens;
  const chk = (id) => d.checks.find((c) => c.id === id);
  const vars = tok['--bg-1'] ? `--tb-bg:${tok['--bg-1']};--tb-surface:${tok['--bg-2']};--tb-text:${tok['--text-1']};--tb-text2:${tok['--text-2']};--tb-text3:${tok['--text-3']};--tb-line:${tok['--line']};--tb-accent:${tok['--accent'] || t.accent};--tb-on:${tok['--on-accent'] || '#111211'}` : '';
  const save = () => {
    const list = S.prefs.customThemes || [];
    const id = start?.id || newThemeId();
    let clean;
    try { clean = cleanTheme({ ...t, id }); } catch (e) { setErr(e.message); return; }
    if (!start?.id && list.length >= MAX_THEMES) { setErr(`You can keep up to ${MAX_THEMES} themes. Delete one first.`); return; }
    const next = start?.id ? list.map((x) => (x.id === id ? clean : x)) : [...list, clean];
    setPref('customThemes', next);
    setLook('theme', `custom:${id}`);
    toast(`“${clean.name}” saved and in use.`);
    onDone?.();
  };
  return html`<div class="ap-builder" role="group" aria-labelledby="tb-title">
    <div class="ap-fields">
      <h3 id="tb-title" class="set-head" style="margin:0">${start?.id ? 'Edit theme' : 'Create a theme'}</h3>
      <div class="ap-field"><label for="tb-name">Name</label>
        <input id="tb-name" class="field" maxlength="32" placeholder="My theme" value=${t.name} style="grid-column:span 2" onInput=${(e) => set({ name: e.target.value })} /></div>
      <div class="ap-field"><label id="tb-base">Base</label><span style="grid-column:span 2"><${Seg} label="Theme base" value=${t.base} options=${[['dark', 'Dark'], ['light', 'Light']]} onChange=${(v) => set({ base: v })} /></span></div>
      <${ColourField} id="tb-bg" label="Background" value=${t.bg} onChange=${(v) => set({ bg: v })} badge=${chk('text-bg') && html`<${Badge} ...${chk('text-bg')} />`} />
      <${ColourField} id="tb-surface" label="Panels" value=${t.surface} onChange=${(v) => set({ surface: v })} badge=${chk('text3') && html`<${Badge} ...${chk('text3')} />`} />
      <${ColourField} id="tb-text" label="Text" value=${t.text} onChange=${(v) => set({ text: v })} badge=${chk('text-surface') && html`<${Badge} ...${chk('text-surface')} />`} />
      <${ColourField} id="tb-accent" label="Accent" value=${t.accent} onChange=${(v) => set({ accent: v })} badge=${chk('accent') && html`<${Badge} ...${chk('accent')} />`} />
      <ul class="ap-checks" aria-label="Contrast checks">
        ${d.checks.map((c) => html`<li key=${c.id}><span>${c.label}</span><${Badge} ...${c} /></li>`)}
      </ul>
      ${(err || d.problems[0]) && html`<p class="err" role="alert" id="tb-err">${err || d.problems[0]}</p>`}
      <div class="acc-inline">
        <button class="btn primary" disabled=${!d.ok || !t.name.trim()} onClick=${save}>${start?.id ? 'Save changes' : 'Save and use'}</button>
        <button class="btn" onClick=${() => onDone?.()}>Cancel</button>
      </div>
    </div>
    <div class="ap-mini" style=${vars} aria-label="Theme preview" role="img">
      <div class="ap-mini-side"><span class="on">Lounge</span><span>Glaze lab</span><span>Firing schedule</span></div>
      <div class="ap-mini-main"><b>Sunniva Berg</b><span>The test tiles are out. Cone 6 looks right.</span><small>Today at 16:04</small><span class="ap-mini-btn">Reply</span></div>
    </div>
  </div>`;
}

function MyThemes() {
  const list = S.prefs.customThemes || [];
  const p = effectivePrefs();
  const [editing, setEditing] = useState(null); // null, 'new' or a theme
  const [code, setCode] = useState('');
  const [shown, setShown] = useState(null); // { id, code }
  const [msg, setMsg] = useState(null);
  const remove = (t) => {
    setPref('customThemes', list.filter((x) => x.id !== t.id));
    if (p.theme === `custom:${t.id}`) setLook('theme', 'system');
    toast(`“${t.name}” deleted.`);
  };
  const doImport = () => {
    let t;
    try { t = decodeTheme(code); } catch (e) { setMsg({ bad: true, text: e.message }); return; }
    if (list.length >= MAX_THEMES) { setMsg({ bad: true, text: `You can keep up to ${MAX_THEMES} themes. Delete one first.` }); return; }
    const id = newThemeId();
    setPref('customThemes', [...list, { ...t, id }]);
    setLook('theme', `custom:${id}`);
    setCode('');
    setMsg({ text: `“${t.name}” added and in use.` });
  };
  return html`
    ${list.length > 0 && html`<div class="ap-mythemes" role="radiogroup" aria-label="Your themes">
      ${list.map((t) => html`<div class="ap-mytheme" key=${t.id}>
        <span class="ap-dot" style=${`background:${t.bg}`}></span><span class="ap-dot" style=${`background:${t.accent}`}></span>
        <span class="grow trunc"><b style="font-weight:500">${t.name}</b> <span class="faint">${t.base === 'dark' ? 'Dark' : 'Light'}</span></span>
        <button class="btn" role="radio" aria-checked=${String(p.theme === `custom:${t.id}`)} onClick=${() => setLook('theme', `custom:${t.id}`)}>${p.theme === `custom:${t.id}` ? 'In use' : 'Use'}</button>
        <button class="ib" aria-label=${`Edit ${t.name}`} data-tip="Edit" onClick=${() => setEditing(t)}><${Icon} name="edit" size=${18} /></button>
        <button class="ib" aria-label=${`Share ${t.name}`} data-tip="Share code" onClick=${() => setShown(shown?.id === t.id ? null : { id: t.id, code: themeForCode(t) })}><${Icon} name="copy" size=${18} /></button>
        <button class="ib danger" aria-label=${`Delete ${t.name}`} data-tip="Delete" onClick=${() => remove(t)}><${Icon} name="trash" size=${18} /></button>
      </div>
      ${shown?.id === t.id && html`<div class="ap-code"><input class="field" readonly aria-label=${`Theme code for ${t.name}`} value=${shown.code} onFocus=${(e) => e.target.select()} />
        <button class="btn" onClick=${() => navigator.clipboard?.writeText(shown.code).then(() => toast('Theme code copied'), () => toast('Couldn’t copy. Select the code instead.'))}>Copy</button></div>`}`)}
    </div>`}
    ${editing ? html`<div style="margin-top:var(--s-3)"><${ThemeBuilder} start=${editing === 'new' ? null : editing} onDone=${() => setEditing(null)} /></div>`
      : html`<div class="acc-inline" style="margin-top:var(--s-3)">
        <button class="btn" disabled=${list.length >= MAX_THEMES} onClick=${() => setEditing('new')}><${Icon} name="plus" size=${16} />Create theme</button>
        ${list.length >= MAX_THEMES && html`<span class="hint">${MAX_THEMES} of ${MAX_THEMES}. Delete one to make another.</span>`}
      </div>`}
    <div class="ap-code">
      <input class="field" id="ap-import" placeholder="Paste a theme code (snug-theme:1:…)" aria-label="Theme code to import" value=${code}
        aria-invalid=${msg?.bad ? 'true' : undefined} aria-describedby="ap-import-msg" onInput=${(e) => { setCode(e.target.value); setMsg(null); }}
        onKeyDown=${(e) => { if (e.key === 'Enter') doImport(); }} />
      <button class="btn" disabled=${!code.trim()} onClick=${doImport}>Import</button>
    </div>
    ${msg && html`<p id="ap-import-msg" class=${msg.bad ? 'err' : 'hint'} role=${msg.bad ? 'alert' : 'status'}>${msg.text}</p>`}`;
}

// ---------- Accent ----------
function AccentPicker() {
  const p = S.prefs;
  const th = resolveTheme();
  const custom = !ACCENT_PRESETS[p.accent];
  const [hex, setHex] = useState(custom ? p.accent : '#3A7BD5');
  const [err, setErr] = useState('');
  useEffect(() => { if (custom) setHex(p.accent); }, [p.accent]);
  const valid = HEX.test(hex);
  const ramp = valid ? accentTokens(hex.toUpperCase(), th.bg1, th.base) : null;
  const ratio = ramp ? contrastRatio(ramp['--accent'], th.bg1) : valid ? contrastRatio(hex, th.bg1) : 0;
  const choose = (v) => {
    const why = accentProblem(v);
    if (why) { setErr(why); return; }
    setErr('');
    setPref('accent', v.startsWith('#') ? v.toUpperCase() : v);
  };
  return html`<div style="display:grid;gap:var(--s-2)">
    <div class="ap-accents" role="radiogroup" aria-label="Accent colour">
      ${Object.entries(ACCENT_PRESETS).map(([id, a]) => html`<button key=${id} type="button" role="radio" class="ap-accent" data-accent=${id}
        aria-checked=${String(p.accent === id)} style=${`--c:${accentHex(id, th.base)}`} onClick=${() => choose(id)}><i aria-hidden="true"></i>${a.label}${id === 'violet' ? ' (Snug)' : ''}</button>`)}
      <button type="button" role="radio" class="ap-accent" data-accent="custom" aria-checked=${String(custom)} style=${`--c:${valid ? hex : 'transparent'}`} onClick=${() => valid && choose(hex)}><i aria-hidden="true"></i>Custom</button>
    </div>
    <div class="ap-custom">
      <label class="sr" for="ap-accent-hex">Custom accent, hex</label>
      <input id="ap-accent-hex" class="field ap-hex" maxlength="7" spellcheck="false" value=${hex} aria-invalid=${valid && !err ? undefined : 'true'} aria-describedby="ap-accent-msg"
        onInput=${(e) => { setHex(e.target.value.trim()); setErr(''); }} onKeyDown=${(e) => { if (e.key === 'Enter' && HEX.test(hex)) choose(hex); }} />
      <input type="color" class="ap-color" aria-label="Custom accent, colour picker" value=${valid ? hex.toLowerCase() : '#3a7bd5'}
        onInput=${(e) => { setHex(e.target.value.toUpperCase()); setErr(''); }} onChange=${(e) => choose(e.target.value.toUpperCase())} />
      ${valid && html`<${Badge} ratio=${ratio} need=${3} label="Accent on the background" />`}
      <button class="btn" disabled=${!valid} onClick=${() => choose(hex)}>Use colour</button>
      <span id="ap-accent-msg" class=${`ap-msg${err || !valid ? ' err' : ' hint'}`} role=${err ? 'alert' : undefined}>
        ${err || (!valid ? 'A hex colour like #3A7BD5.' : ramp && ramp['--accent'] !== hex.toUpperCase() ? `Shown as ${ramp['--accent']} on this theme so it stays readable.` : 'Readable on this theme.')}</span>
    </div>
  </div>`;
}

// ---------- Fonts ----------
const FONTS = [['inter', 'Inter', '"Inter", sans-serif'], ['system', 'System', 'system-ui, sans-serif'], ['hyperlegible', 'Atkinson Hyperlegible', '"Atkinson Hyperlegible", sans-serif'], ['serif', 'Serif', 'Georgia, serif'], ['mono', 'Mono', '"Atkinson Hyperlegible Mono", monospace']];
function FontPicker() {
  const p = S.prefs;
  return html`<div class="seg ap-fonts" role="radiogroup" aria-label="Font">
    ${FONTS.map(([id, label, face]) => html`<button key=${id} type="button" role="radio" aria-checked=${String(p.font === id)} aria-pressed=${String(p.font === id)} data-font=${id} style=${`font-family:${face}`} onClick=${() => setPref('font', id)}>${label}</button>`)}
  </div>`;
}

// ---------- Appearance page ----------
const opt = (v, label) => [v, label];
export function AppearancePage() {
  const sp = S.prefs;
  const p = effectivePrefs();
  const dev = !!deviceLook();
  const [, force] = useState(0);
  return html`
    <h1>Appearance</h1>
    <p class="lead">Changes apply as you make them, and follow you to every device you sign in on.</p>
    <${AppearancePreview} />
    <${Row} label="Use these settings on this device only" hint=${dev ? 'Theme, zoom, text size, spacing, message display and sidebar width stay on this device. Other settings still follow you.' : 'Keep theme, zoom, text size, spacing, display and sidebar width just for this device.'}>
      <div class="acc-inline">
        ${dev && html`<button class="btn quiet" onClick=${() => { setDeviceOnly(true); force((n) => n + 1); }}>Reset to synced</button>`}
        <${Switch} on=${dev} label="Use these settings on this device only" onChange=${(v) => { setDeviceOnly(v); force((n) => n + 1); }} />
      </div>
    <//>
    <div class="set-head">Themes</div>
    <${ThemeCards} />
    <${MyThemes} />
    <div class="set-head">Accent</div>
    <${Row} label="Accent colour" hint=${customId(p.theme) ? 'Your theme has its own accent. This applies to the built-in themes.' : 'Buttons, switches, the selected row and the focus ring. Snug’s violet still marks what needs you.'} top>
      <${AccentPicker} />
    <//>
    <div class="set-head">Messages</div>
    <${Row} label="Message display" hint="Compact puts the name and time on the same line as the message.">
      <${Seg} label="Message display" value=${p.display} options=${[opt('cozy', 'Cozy'), opt('compact', 'Compact')]} onChange=${(v) => setLook('display', v)} />
    <//>
    <${Row} label="Pictures in compact" hint=${p.display === 'compact' ? 'Show people’s pictures beside compact messages.' : 'Only applies to Compact.'}>
      <${Switch} on=${sp.compactAvatars} label="Show pictures in compact" onChange=${(v) => setPref('compactAvatars', v)} />
    <//>
    <${Row} label="Spacing" hint="Room between groups of messages.">
      <${Seg} label="Spacing" value=${p.density} options=${[opt('snug', 'Tight'), opt('regular', 'Regular'), opt('roomy', 'Roomy')]} onChange=${(v) => setLook('density', v)} />
    <//>
    <${Row} label="Line height" hint="Space between the lines of a message.">
      <${Seg} label="Line height" value=${sp.lineHeight} options=${[opt('tight', 'Tight'), opt('normal', 'Normal'), opt('loose', 'Loose')]} onChange=${(v) => setPref('lineHeight', v)} />
    <//>
    <div class="set-head">Chat</div>
    <${Row} label="Times on messages" hint="Hidden until you point at a message, or always shown.">
      <${Seg} label="Times on messages" value=${sp.showTimes} options=${[opt('always', 'Always'), opt('hover', 'On hover')]} onChange=${(v) => setPref('showTimes', v)} />
    <//>
    <${Row} label="Big emoji" hint="A message that is only emoji shows them large.">
      <${Switch} on=${sp.jumboEmoji !== false} label="Big emoji" onChange=${(v) => setPref('jumboEmoji', v)} />
    <//>
    <${Row} label="Emoji size" hint="Emoji inside messages.">
      <${Seg} label="Emoji size" value=${sp.emojiSize} options=${[opt('s', 'Small'), opt('m', 'Medium'), opt('l', 'Large')]} onChange=${(v) => setPref('emojiSize', v)} />
    <//>
    <${Row} label="Reactions" hint="Show the reactions under messages.">
      <${Switch} on=${sp.showReactions !== false} label="Show reactions" onChange=${(v) => setPref('showReactions', v)} />
    <//>
    <${Row} label="Play GIFs" hint="Match motion follows your Motion setting; Always plays them even with reduced motion.">
      <${Seg} label="Play GIFs" value=${sp.gifAutoplay} options=${[opt('auto', 'Match motion'), opt('always', 'Always'), opt('hover', 'On hover'), opt('never', 'Never')]} onChange=${(v) => setPref('gifAutoplay', v)} />
    <//>
    <${Row} label="Animated emoji" hint="Custom emoji that move.">
      <${Seg} label="Animated emoji" value=${sp.animatedEmoji} options=${[opt('auto', 'Match motion'), opt('always', 'Always'), opt('hover', 'On hover'), opt('never', 'Never')]} onChange=${(v) => setPref('animatedEmoji', v)} />
    <//>
    <${Row} label="Spoilers" hint="Hidden text shows when you select it, or always.">
      <${Seg} label="Spoilers" value=${sp.spoilers} options=${[opt('click', 'On click'), opt('always', 'Always show')]} onChange=${(v) => setPref('spoilers', v)} />
    <//>
    <${Row} label="People’s name styles" hint="Fonts and colours people chose for their names.">
      <${Switch} on=${sp.showNameStyles !== false} label="Show people’s name styles" onChange=${(v) => setPref('showNameStyles', v)} />
    <//>
    <${Row} label="Chat background" hint="A faint pattern behind messages. Off with high contrast.">
      <${Seg} label="Chat background" value=${sp.chatBg} options=${[opt('plain', 'Plain'), opt('dots', 'Dots'), opt('grid', 'Grid'), opt('arches', 'Arches'), opt('grain', 'Grain')]} onChange=${(v) => setPref('chatBg', v)} />
    <//>
    <div class="set-head">Text</div>
    <${Row} label="Font" hint="Atkinson Hyperlegible was drawn for low vision: letters that are easy to tell apart. Serif and System use your device’s own fonts." top>
      <${FontPicker} />
    <//>
    <${Row} label="Code font" hint="For code in messages.">
      <${Seg} label="Code font" value=${sp.codeFont} options=${[opt('mono', 'Atkinson Mono'), opt('system-mono', 'System mono')]} onChange=${(v) => setPref('codeFont', v)} />
    <//>
    <${Row} label="Text size" hint="12 to 20 pixels. Every size in Snug scales with it.">
      <${LookSlider} id="acc-font" k="fontScale" label="Text size" min=${12} max=${20} unit="px" />
    <//>
    <${Row} label="Zoom" hint="Makes everything bigger or smaller, like the browser’s zoom.">
      <${Seg} label="Zoom" value=${p.zoom} options=${[80, 90, 100, 110, 125, 150].map((v) => [v, `${v}%`])} onChange=${(v) => setLook('zoom', v)} />
    <//>
    <${Row} label="Clock" hint="Times on messages and in lists.">
      <${Seg} label="Clock" value=${sp.clock} options=${[opt('auto', 'Match language'), opt('12', '12-hour'), opt('24', '24-hour')]} onChange=${(v) => setPref('clock', v)} />
    <//>
    <div class="set-head">Colour</div>
    <${Row} label="Saturation" hint="Turn colours down, all the way to greys.">
      <${LookSlider} id="acc-sat" k="saturation" label="Saturation" min=${0} max=${100} step=${5} unit="%" />
    <//>
    <${Row} label="Role colours on names" hint="Names take the colour of their highest coloured role.">
      <${Switch} on=${sp.roleColors !== false} label="Role colours on names" onChange=${(v) => setPref('roleColors', v)} />
    <//>
    <div class="set-head">Layout</div>
    <${Row} label="Sidebar width" hint="Or drag the sidebar’s edge.">
      <${LookSlider} id="acc-side" k="sidebarW" label="Sidebar width" min=${200} max=${420} step=${4} unit="px" />
    <//>
    <${Row} label="Contrast and motion" hint="On the Accessibility page.">
      <button class="btn" onClick=${() => settingsLayer && openLayer({ C: settingsLayer, props: { page: 'a11y' } })}>Accessibility</button>
    <//>`;
}

function LookSlider({ id, k, label, min, max, step = 1, unit = '' }) {
  const value = effectivePrefs()[k];
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const put = (n) => (['fontScale', 'sidebarW'].includes(k) ? setLook(k, n) : setPref(k, n));
  return html`<div class="acc-slider">
    <input id=${id} type="range" min=${min} max=${max} step=${step} value=${v} aria-label=${label} aria-valuetext=${`${v}${unit}`}
      onInput=${(e) => setV(Number(e.target.value))} onChange=${(e) => put(Number(e.target.value))} />
    <output for=${id} class="num">${v}${unit}</output>
  </div>`;
}

// ---------- Profile picture ----------
const PIC_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_PIC = 2 * 1024 * 1024;
const STAGE = 240;
function AvatarEditor() {
  const u = me();
  const file = useRef();
  const canvas = useRef();
  const [src, setSrc] = useState(null);    // { img, url, file, gif }
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null);
  const drag = useRef(null);
  const geom = (z = zoom, o = off) => {
    if (!src) return null;
    const { naturalWidth: w, naturalHeight: h } = src.img;
    const scale = (STAGE / Math.min(w, h)) * z;
    const clamp = (v, size) => Math.min(0, Math.max(STAGE - size * scale, v));
    return { w, h, scale, x: clamp(o.x, w), y: clamp(o.y, h) };
  };
  useEffect(() => {
    const g = geom();
    const c = canvas.current;
    if (!g || !c) return;
    c.width = STAGE * 2; c.height = STAGE * 2;
    const x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    x.drawImage(src.img, g.x * 2, g.y * 2, g.w * g.scale * 2, g.h * g.scale * 2);
    setPreview(src.gif ? src.url : c.toDataURL('image/png'));
  }, [src, zoom, off]);
  useEffect(() => () => { if (src?.url) URL.revokeObjectURL(src.url); }, [src]);
  const pick = (f) => {
    setErr('');
    if (!f) return;
    if (!PIC_TYPES.includes(f.type)) { setErr('Pictures need to be PNG, JPEG, GIF or WebP.'); return; }
    if (f.size > MAX_PIC) { setErr('Pictures can be up to 2 MB.'); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth < 64 || img.naturalHeight < 64) { setErr('Pictures need to be at least 64 pixels on each side.'); URL.revokeObjectURL(url); return; }
      if (img.naturalWidth > 2048 || img.naturalHeight > 2048) { setErr('Pictures can be up to 2048 pixels on each side.'); URL.revokeObjectURL(url); return; }
      const scale = STAGE / Math.min(img.naturalWidth, img.naturalHeight);
      setZoom(1);
      setOff({ x: (STAGE - img.naturalWidth * scale) / 2, y: (STAGE - img.naturalHeight * scale) / 2 });
      setSrc({ img, url, file: f, gif: f.type === 'image/gif' });
    };
    img.onerror = () => { setErr('That picture couldn’t be opened.'); URL.revokeObjectURL(url); };
    img.src = url;
  };
  const save = async () => {
    const g = geom();
    if (!g) return;
    setBusy(true); setErr('');
    try {
      let blob = src.file;
      // A GIF keeps its frames (the server shows it round, centred); everything else is cropped here.
      if (!src.gif) {
        const out = document.createElement('canvas');
        out.width = 512; out.height = 512;
        out.getContext('2d').drawImage(src.img, -g.x / g.scale, -g.y / g.scale, STAGE / g.scale, STAGE / g.scale, 0, 0, 512, 512);
        blob = await new Promise((r) => out.toBlob(r, 'image/png'));
        if (blob.size > MAX_PIC) blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.9));
      }
      const res = await fetch('/api/files?avatar=1', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'That picture didn’t upload. Try again.');
      await call('me.update', { avatar: d.id });
      setSrc(null);
      toast('Your picture is updated.');
    } catch (e) { setErr(e.offline ? 'You’re offline. Try again once you’re back.' : e.message); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    try { await call('me.update', { avatar: null }); toast('Picture removed.'); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const g = geom();
  const nudge = (dx, dy) => setOff({ x: g.x + dx, y: g.y + dy });
  const keys = (e) => {
    const step = e.shiftKey ? 24 : 8;
    const m = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (m) { e.preventDefault(); nudge(...m); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(Math.min(4, zoom + 0.1)); }
    if (e.key === '-') { e.preventDefault(); setZoom(Math.max(1, zoom - 0.1)); }
  };
  const pv = { ...u, img: preview || u.img, imgAnim: false };
  return html`<div class="ap-avatar">
    <input ref=${file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden id="ap-avatar-file" onChange=${(e) => { pick(e.target.files[0]); e.target.value = ''; }} />
    ${src ? html`<div class="ap-crop">
        <div class="ap-crop-stage" tabindex="0" role="img" aria-label="Picture to crop. Arrow keys move it, plus and minus zoom." onKeyDown=${keys}
          onPointerDown=${(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, o: { x: g.x, y: g.y } }; }}
          onPointerMove=${(e) => { const d = drag.current; if (d) setOff({ x: d.o.x + e.clientX - d.x, y: d.o.y + e.clientY - d.y }); }}
          onPointerUp=${() => { drag.current = null; }} onPointerCancel=${() => { drag.current = null; }}>
          <canvas ref=${canvas}></canvas>
        </div>
        <div class="acc-slider"><input type="range" min="1" max="4" step="0.05" value=${zoom} aria-label="Zoom" disabled=${src.gif} onInput=${(e) => setZoom(Number(e.target.value))} /><output class="num">${Math.round(zoom * 100)}%</output></div>
        ${src.gif && html`<p class="hint">GIFs keep their movement, so they aren’t cropped: Snug shows the middle in the circle.</p>`}
      </div>` : null}
    <div class="ap-avatar-now">
      <div class="ap-sizes" aria-label="How it looks">
        <span><${Avatar} user=${pv} size=${24} deco=${false} />24</span>
        <span><${Avatar} user=${pv} size=${40} />40</span>
        <span><${Avatar} user=${pv} size=${96} />96</span>
      </div>
      <div class="acc-inline">
        ${src ? html`
          <button class="btn primary" disabled=${busy} onClick=${save}>${busy ? 'Uploading…' : 'Save picture'}</button>
          <button class="btn" disabled=${busy} onClick=${() => setSrc(null)}>Cancel</button>`
        : html`
          <button class="btn" disabled=${busy} onClick=${() => file.current.click()}>${u.img ? 'Change picture' : 'Upload picture'}</button>
          ${u.img && html`<button class="btn quiet" disabled=${busy} onClick=${remove}>Remove</button>`}`}
      </div>
    </div>
    ${err && html`<p class="err" role="alert" id="ap-avatar-err"><${Icon} name="alert" size=${16} /> ${err}</p>`}
    ${busy && html`<p class="hint" role="status">Uploading your picture…</p>`}
  </div>`;
}

// ---------- Decorations, name style, profile colours ----------
const save = (patch) => call('me.update', patch).catch((e) => toast(e.offline ? 'You’re offline, so that wasn’t saved.' : e.message));
function HueSwatches({ label, value, onChange }) {
  return html`<div class="swatches" role="radiogroup" aria-label=${label}>
    <button class="swatch none" role="radio" aria-checked=${String(value == null)} aria-label="Theme colour" onClick=${() => onChange(null)}></button>
    ${HUES.map(([v, name]) => html`<button key=${v} class="swatch" role="radio" style=${`--hue:${v}`} aria-checked=${String(value != null && hueOf(value) === v)} aria-label=${name} onClick=${() => onChange(v)}></button>`)}
  </div>`;
}
function DecorationPicker() {
  const u = me();
  return html`<div style="display:grid;gap:var(--s-3);justify-items:end">
    <div class="ap-decos" role="radiogroup" aria-label="Decoration">
      ${[[null, 'None'], ...DECORATIONS].map(([id, label]) => html`<button key=${id || 'none'} type="button" role="radio" class="ap-deco" data-deco=${id || 'none'} aria-checked=${String((u.decoration || null) === id)}
        onClick=${() => save({ decoration: id })}><${Avatar} user=${{ ...u, decoration: id, imgAnim: false }} size=${40} />${label}</button>`)}
    </div>
    ${u.decoration && html`<${HueSwatches} label="Decoration colour" value=${u.decorationHue ?? null} onChange=${(v) => save({ decorationHue: v })} />`}
  </div>`;
}
function NameStylePicker() {
  const u = me();
  const ns = u.nameStyle || { font: 'inter', weight: 'semibold', hue: null };
  const put = (patch) => save({ nameStyle: { font: ns.font, weight: ns.weight, hue: ns.hue ?? null, ...patch } });
  return html`<div style="display:grid;gap:var(--s-2);justify-items:end">
    <span class="ap-namepv" ...${nameAttrs({ nameStyle: ns })}>${u.name}</span>
    <${Seg} label="Name font" value=${ns.font} options=${NAME_FONTS} onChange=${(v) => put({ font: v })} />
    <${Seg} label="Name weight" value=${ns.weight} options=${NAME_WEIGHTS} onChange=${(v) => put({ weight: v })} />
    <${HueSwatches} label="Name colour" value=${ns.hue ?? null} onChange=${(v) => put({ hue: v })} />
  </div>`;
}
function ProfileColoursEditor() {
  const u = me();
  const [c, setC] = useState(u.profileColors || ['#2B4C7E', '#F3E9D2']);
  const [err, setErr] = useState('');
  useEffect(() => { if (u.profileColors) setC(u.profileColors); }, [JSON.stringify(u.profileColors)]);
  const inks = c.map((x) => (HEX.test(x) ? profileInk(x) : null));
  const ok = inks.every(Boolean);
  const card = profileColours({ profileColors: ok ? c : null });
  const put = async () => {
    if (!ok) { setErr('Text wouldn’t be readable on one of those colours. Pick a lighter or darker one.'); return; }
    try { await call('me.update', { profileColors: c }); setErr(''); toast('Profile colours saved.'); } catch (e) { setErr(e.message); }
  };
  return html`<div style="display:grid;gap:var(--s-3);justify-items:end">
    <div class=${`ap-card-pv${card.cls}`} style=${card.style} aria-label="Profile card preview" role="img">
      <div class="acc-banner" style=${`--hue:${hueOf(u.hue)}`}></div>
      <div class="pc-body"><b ...${nameAttrs(u)}>${u.name}</b><span>@${u.handle}</span><span>${u.about || 'A few lines about you.'}</span></div>
    </div>
    <${ColourField} id="pc-1" label="Header" value=${c[0]} onChange=${(v) => { setC([v, c[1]]); setErr(''); }} badge=${inks[0] ? html`<${Badge} ratio=${inks[0].ratio} need=${4.5} label="Text on the header" />` : html`<span class="ap-badge bad">Unreadable</span>`} />
    <${ColourField} id="pc-2" label="Card" value=${c[1]} onChange=${(v) => { setC([c[0], v]); setErr(''); }} badge=${inks[1] ? html`<${Badge} ratio=${inks[1].ratio} need=${4.5} label="Text on the card" />` : html`<span class="ap-badge bad">Unreadable</span>`} />
    ${err && html`<p class="err" role="alert">${err}</p>`}
    <div class="acc-inline">
      ${u.profileColors && html`<button class="btn quiet" onClick=${() => save({ profileColors: null })}>Remove</button>`}
      <button class="btn" disabled=${!ok} onClick=${put}>Save colours</button>
    </div>
  </div>`;
}
export function ProfileStyle({ Row: R = Row }) {
  return html`
    <div class="set-head">Picture and style</div>
    <${R} label="Profile picture" hint="PNG, JPEG, GIF or WebP, up to 2 MB. Crop it to a circle here. Only people who can see you can load it." top>
      <${AvatarEditor} />
    <//>
    <${R} label="Decoration" hint="Drawn around your picture where it’s big enough. Moving ones play once when someone points at them." top>
      <${DecorationPicker} />
    <//>
    <${R} label="Name style" hint="How your name looks on messages and your profile. People can turn name styles off for themselves; role colours still win." top>
      <${NameStylePicker} />
    <//>
    <${R} label="Profile colours" hint="Solid colours for your profile card. Snug picks dark or light text so it stays readable." top>
      <${ProfileColoursEditor} />
    <//>`;
}

// ---------- Notification sounds ----------
export function SoundSettings({ Row: R = Row }) {
  const p = S.prefs;
  const sounds = Object.fromEntries(SOUND_KINDS.map((k) => [k, soundFor(p, k)]));
  const pack = packOf(sounds);
  const vol = p.soundVolume ?? 80;
  const setOne = (k, v) => { setPref('sounds', { ...sounds, [k]: v }); playSound(v, { volume: vol }); };
  const KIND = { message: ['Messages', 'Followed threads and other messages that reach you.'], mention: ['Mentions', 'When someone mentions you, replies to you or uses one of your words.'], dm: ['Direct messages', 'Messages in your conversations.'] };
  return html`
    <${R} label="Sound pack" hint="Sets all three sounds at once." top>
      <div class="ap-accents" role="radiogroup" aria-label="Sound pack">
        ${Object.entries(SOUND_PACKS).map(([id, sp]) => html`<button key=${id} type="button" role="radio" class="ap-accent" aria-checked=${String(pack === id)}
          onClick=${() => { setPref('sounds', { ...sp.sounds }); playSound(sp.sounds.mention, { volume: vol }); }}>${sp.label}</button>`)}
      </div>
    <//>
    ${SOUND_KINDS.map((k) => html`<${R} key=${k} label=${KIND[k][0]} hint=${KIND[k][1]}>
      <div class="acc-inline">
        <select class="field" aria-label=${`${KIND[k][0]} sound`} value=${sounds[k]} onChange=${(e) => setOne(k, e.target.value)}>
          ${['off', ...SOUND_LIST].map((n) => html`<option value=${n}>${n === 'off' ? 'Off' : n[0].toUpperCase() + n.slice(1)}</option>`)}
        </select>
        <button class="ib" aria-label=${`Play the ${KIND[k][0].toLowerCase()} sound`} data-tip="Play" disabled=${sounds[k] === 'off' || vol === 0} onClick=${() => playSound(sounds[k], { volume: vol })}><${Icon} name="play" /></button>
      </div>
    <//>`)}
    <${R} label="Volume" hint="For notification sounds only. Calls keep their own ring.">
      <div class="acc-slider"><input id="ap-vol" type="range" min="0" max="100" step="5" value=${vol} aria-label="Notification volume" aria-valuetext=${`${vol}%`}
        onChange=${(e) => { setPref('soundVolume', Number(e.target.value)); playSound(sounds.mention, { volume: Number(e.target.value) }); }} /><output for="ap-vol" class="num">${vol}%</output></div>
    <//>`;
}

// ---------- Keyboard shortcuts ----------
export const Keys = ({ combo }) => (combo
  ? html`<span class="kb-keys">${comboKeys(combo, isMac).map((k) => html`<kbd class="kbd">${k}</kbd>`)}</span>`
  : html`<span class="kb-keys"><span class="kb-none">None</span></span>`);
export function KeysEditor() {
  const custom = S.prefs.keys || {};
  const b = bindings(custom);
  const [rec, setRec] = useState(null);
  const [err, setErr] = useState({});
  // A layout effect: listening starts before the button says so.
  useLayoutEffect(() => {
    if (!rec) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape' && !e.shiftKey) { setRec(null); return; }
      const combo = eventCombo(e, isMac);
      if (!combo) return; // a modifier on its own: wait for the key
      const why = conflictOf(combo, rec, custom);
      if (why) { setErr({ [rec]: why.text }); return; }
      const def = ACTIONS.find((a) => a.id === rec).def;
      const next = { ...custom };
      if (combo === def) delete next[rec]; else next[rec] = combo;
      setPref('keys', next);
      setErr({});
      setRec(null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [rec, JSON.stringify(custom)]);
  const reset = (id) => { const next = { ...custom }; delete next[id]; setPref('keys', next); setErr({}); };
  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  return html`
    <h1>Keyboard</h1>
    <p class="lead">Everything works without a mouse. Change any shortcut below: press Record, then the keys. Voice shortcuts work in a call, even while you type.</p>
    <div class="acc-inline" style="justify-content:flex-end">
      <button class="btn" disabled=${!Object.keys(custom).length} onClick=${() => { setPref('keys', {}); setErr({}); toast('Shortcuts are back to how they started.'); }}>Reset all</button>
    </div>
    ${groups.map((g) => html`<div key=${g}><div class="set-head">${g}</div><div class="kb-list">
      ${ACTIONS.filter((a) => a.group === g).map((a) => html`<div class="kb-row" key=${a.id} data-action=${a.id}>
        <span>${a.label}${a.id in custom && html`<span class="kb-changed">Changed</span>`}</span>
        <${Keys} combo=${b[a.id]} />
        <span class="acc-inline">
          <button class=${`btn kb-rec${rec === a.id ? ' listening' : ''}`} aria-live="polite" aria-label=${rec === a.id ? `Press the keys for ${a.label}, or Escape to cancel` : `Record shortcut for ${a.label}`}
            onClick=${() => { setErr({}); setRec(rec === a.id ? null : a.id); }}>${rec === a.id ? 'Press keys…' : 'Record'}</button>
          ${b[a.id] && rec !== a.id && html`<button class="btn quiet" aria-label=${`Clear the shortcut for ${a.label}`} onClick=${() => { setPref('keys', { ...custom, [a.id]: '' }); setErr({}); }}>Clear</button>`}
          ${a.id in custom && html`<button class="btn quiet" aria-label=${`Reset ${a.label}`} onClick=${() => reset(a.id)}>Reset</button>`}
        </span>
        ${err[a.id] && html`<div class="kb-err" role="alert">${err[a.id]}</div>`}
      </div>`)}
    </div></div>`)}
    <div class="set-head">Fixed</div>
    <p class="hint">Esc closes the top layer (or marks the place read), Alt ← goes back, ? opens this page, and in the message box ${isMac ? '⌘' : 'Ctrl'} B, I, U and E format text. On a message: R reply, T thread, S save, E edit, Enter all actions.</p>`;
}

// Quick switcher actions (js/views/search.js): themes by name.
export const THEME_ACTIONS = Object.entries(THEME_PRESETS).map(([id, t]) => ({
  label: `Switch to ${t.label} theme`, icon: 'eye', words: `theme ${id} ${t.label} ${t.base} colours appearance`, run: () => setLook('theme', id),
}));

