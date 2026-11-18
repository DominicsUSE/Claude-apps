// A sheet of every shared control in both its states, for checking the design
// system by eye (DESIGN.md). Not linked from the app. Open it from the
// browser console:
//   Promise.all([import('/js/store.js'), import('/js/ui/gallery.js')])
//     .then(([s, g]) => s.openLayer({ C: g.Gallery, props: {} }))
import { html, useState } from '../../vendor/preact-htm.js';
import { S, closeLayer, toast } from '../store.js';
import {
  Avatar, Badge, Spinner, Switch, Seg, Button, IconButton, TextInput, TextArea, SearchInput, Tabs, TabPanel,
  Dropdown, EmptyState, LoadingState, ErrorState, Skeleton, Tooltip, confirmDialog, toastSuccess, toastError, toastInfo, contextMenu,
} from './kit.js';

const Sect = ({ title, children }) => html`<section class="ui-gal-sect"><h2>${title}</h2><div class="ui-gal-row">${children}</div></section>`;

export function Gallery() {
  const [tab, setTab] = useState('one');
  const [q, setQ] = useState('kiln');
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState('m');
  const me = S.users[S.me] || { id: 'x', name: 'Robin Hale', hue: 40, presence: 'around' };
  const items = [{ label: 'Edit', icon: 'edit', onSelect: () => {} }, { label: 'Pin', icon: 'pin', hint: 'P' }, { label: 'Delete', icon: 'trash', danger: true }];
  return html`<div class="layer ui-gal" role="dialog" aria-modal="true" aria-label="Design system" tabindex="-1">
    <div class="layer-body"><div class="layer-col">
      <h1>Design system</h1>
      <${Sect} title="Buttons">
        <${Button} variant="primary">Save changes<//>
        <${Button}>Cancel<//>
        <${Button} variant="ghost" icon="plus">Add room<//>
        <${Button} variant="danger">Leave house<//>
        <${Button} variant="danger-solid">Delete<//>
        <${Button} variant="primary" loading>Saving<//>
        <${Button} disabled>Disabled<//>
        <${Button} size="sm">Small<//>
        <${Button} size="lg" variant="primary">Large<//>
      <//>
      <${Sect} title="Icon buttons">
        <${IconButton} icon="pin" label="Pin" />
        <${IconButton} icon="people" label="People" pressed=${true} />
        <${IconButton} icon="trash" label="Delete" danger />
        <${IconButton} icon="more" label="More" size="compact" />
        <${IconButton} icon="x" label="Close" size="sm" />
        <${Button} icon="settings" label="Settings" />
        <${Dropdown} label="Sort" items=${items}>Newest first<//>
        <${Dropdown} label="More" icon="more" iconOnly items=${items} />
      <//>
      <${Sect} title="Fields">
        <div class="ui-gal-col">
          <${TextInput} label="Display name" hint="Shown next to your messages." value="Robin" />
          <${TextInput} label="Handle" error="That handle is taken. Try robin.hale." value="robin" />
          <${TextArea} label="About" optional placeholder="A line about you" />
          <${SearchInput} label="Search rooms" placeholder="Search rooms" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} />
        </div>
      <//>
      <${Sect} title="Choices">
        <${Switch} on=${on} onChange=${setOn} label="Example switch" />
        <${Seg} label="Text size" value=${seg} onChange=${setSeg} options=${[['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]} />
      <//>
      <${Sect} title="Tabs">
        <div class="ui-gal-col">
          <${Tabs} base="gal" label="Example" value=${tab} onChange=${setTab} tabs=${[{ id: 'one', label: 'Online', count: 4 }, { id: 'two', label: 'Pending', badge: 2 }, { id: 'three', label: 'Blocked' }]} />
          <${TabPanel} base="gal" value=${tab}><p class="sub">Panel for ${tab}.</p><//>
        </div>
      <//>
      <${Sect} title="People and counts">
        <${Avatar} user=${me} presence />
        <${Avatar} user=${{ ...me, id: 'y', name: 'Ines Duarte', hue: 200, presence: 'away' }} presence />
        <${Avatar} user=${{ ...me, id: 'z', name: 'Malik', hue: 300, presence: 'offline' }} presence dim />
        <${Badge} n=${3} label="3 mentions" /><${Badge} n=${12} quiet /><${Badge} n=${1} alert />
        <${Spinner} /><${Spinner} size="lg" />
        <${Tooltip} text="A tooltip on plain text">Hover or focus me<//>
        <span class="ui-gal-ctx" ...${contextMenu(() => items, { label: 'Example' })} tabindex="0">Right-click me<//>
      <//>
      <${Sect} title="Dialogs and toasts">
        <${Button} onClick=${() => confirmDialog({ title: 'Leave Kiln & Co.?', text: 'You can come back with a new invitation.', action: 'Leave', danger: true })}>Confirm dialog<//>
        <${Button} onClick=${() => toast('Link copied.')}>Plain toast<//>
        <${Button} onClick=${() => toastSuccess('Saved.')}>Success<//>
        <${Button} onClick=${() => toastError('Couldn’t send. Check your connection.')}>Error<//>
        <${Button} onClick=${() => toastInfo('Notifications are paused until 9:00.')}>Info<//>
      <//>
      <${Sect} title="States">
        <div class="ui-gal-col">
          <${EmptyState} icon="house" title="No houses yet" text="Join one with an invite link, or start your own." action=${{ label: 'Find a house', onClick: () => {} }} />
          <${LoadingState} kind="list" rows=${3} />
          <${LoadingState} kind="messages" rows=${2} />
          <${ErrorState} text="Snug couldn’t reach the server." onRetry=${() => {}} />
          <div class="ui-gal-row"><${Skeleton} w=${120} h=${12} line /><${Skeleton} circle w=${32} h=${32} /></div>
        </div>
      <//>
    </div></div>
    <${IconButton} icon="x" label="Close" cls="layer-close" onClick=${closeLayer} />
  </div>`;
}
