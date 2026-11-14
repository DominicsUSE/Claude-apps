// Where a new house starts: blank, a template, or the structure of a house
// you manage (rooms, roles and access; never its messages or members).
import { html } from '../../vendor/preact-htm.js';
import { S } from '../store.js';
import { can } from '../lib/perms.js';
import { TEMPLATES } from '../lib/places.js';

export const startArgs = (v) => (v === 'blank' ? {} : v.startsWith('copy:') ? { from: v.slice(5) } : { template: v });

export function TemplatePick({ value, onChange }) {
  const mine = S.houseOrder.filter((h) => S.houses[h]?.joined && can(S, h, 'roles'));
  const options = [['blank', 'Blank', 'Three rooms and a voice room.'], ...TEMPLATES.map((t) => [t.id, t.label, t.hint])];
  const hint = value.startsWith('copy:') ? 'Its rooms, roles and who can see what. No messages or members come with it.' : options.find((o) => o[0] === value)?.[2];
  return html`<div>
    <span class="label" id="house-start">Start from</span>
    <div class="topic-chips" role="group" aria-labelledby="house-start">
      ${options.map(([v, label]) => html`<button type="button" key=${v} class="chip" aria-pressed=${String(value === v)} onClick=${() => onChange(v)}>${label}</button>`)}
    </div>
    ${mine.length > 0 && html`<select class="field start-copy" aria-label="Or copy a house you manage" value=${value.startsWith('copy:') ? value : ''}
      onChange=${(e) => onChange(e.target.value || 'blank')}>
      <option value="">Or copy a house you manage…</option>
      ${mine.map((h) => html`<option key=${h} value=${`copy:${h}`}>${S.houses[h].name}</option>`)}
    </select>`}
    <div class="hint">${hint}</div>
  </div>`;
}
