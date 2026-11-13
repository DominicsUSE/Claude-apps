// One icon style: drawn on a 20px grid, round caps and joins, a stroke that
// stays about 1.5px on screen at every size (16 in rows and menus, 20 on
// controls, 24 for major marks). Icons replace reading; they are never
// decoration. "f:" marks a filled shape. Aliases (gear, members, inbox...) let
// views use the name they think in; scratchpad/ui/system.md lists them.
import { html } from '../../vendor/preact-htm.js';

const P = {
  search: 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12Z|M17 17l-3.7-3.7',
  plus: 'M10 4v12|M4 10h12',
  x: 'M5 5l10 10|M15 5L5 15',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  'chev-d': 'M5 7.5l5 5 5-5',
  'chev-r': 'M7.5 5l5 5-5 5',
  back: 'M16 10H4.5|M9 5l-5 5 5 5',
  down: 'M10 4v11.5|M5 11l5 5 5-5',
  room: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3A1.5 1.5 0 0 1 4 11.5Z',
  voice: 'M3 8.5v3|M6.5 5.5v9|M10 3.5v13|M13.5 6.5v7|M17 8.5v3',
  news: 'M4 8.5v3a1 1 0 0 0 1 1h2l6 3.5v-12L7 7.5H5a1 1 0 0 0-1 1Z|M15.5 8a3 3 0 0 1 0 4|M7 12.5V16',
  thread: 'M5.5 4v7.5a3 3 0 0 0 3 3H15|M12 11.5l3 3-3 3',
  reply: 'M8 5L4 9l4 4|M4 9h7.5a4.5 4.5 0 0 1 4.5 4.5V15',
  react: 'M16.4 10.6A6.5 6.5 0 1 1 9.4 3.6|M7.4 11.6a3.2 3.2 0 0 0 5 0|M7.8 8.1v.3|M12 8.3v.1|M15.5 2.5v5|M13 5h5',
  smile: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z|M7 11.5a3.5 3.5 0 0 0 6 0|M7.5 7.8v.4|M12.5 7.8v.4',
  save: 'M6 3.5h8v13l-4-3-4 3z',
  saved: 'f:M6 3.5h8v13l-4-3-4 3z|M6 3.5h8v13l-4-3-4 3z',
  more: 'f:M5 8.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z|f:M10 8.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z|f:M15 8.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z',
  pin: 'M12 3.5l4.5 4.5-2 .7-2.7 2.7.3 3.1-1.2 1.2-6.6-6.6 1.2-1.2 3.1.3 2.7-2.7z|M6.6 13.4l-3.1 3.1',
  people: 'M7.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z|M2.5 16.5a5 5 0 0 1 10 0|M13.5 9.2a2.6 2.6 0 0 0 0-5.2|M14.5 12a4.5 4.5 0 0 1 3 4.5',
  info: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z|M10 9.5V14|M10 6.5v.2',
  bell: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5H4z|M8.5 17h3',
  'bell-off': 'M14.5 11V9a4.5 4.5 0 0 0-7-3.7|M5.5 9.5v4L4 15h10|M8.5 17h3|M3.5 3.5l13 13',
  mic: 'M10 3a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 10 3Z|M5.5 9.5a4.5 4.5 0 0 0 9 0|M10 14v3',
  'mic-off': 'M7.5 7.5v2a2.5 2.5 0 0 0 4 2|M12.5 8.5v-3a2.5 2.5 0 0 0-4.6-1.4|M5.5 9.5a4.5 4.5 0 0 0 7.6 3.2|M10 14v3|M3.5 3.5l13 13',
  ear: 'M4 14v-3.5a6 6 0 0 1 12 0V14|M4 12.5h2.5V17H5a1 1 0 0 1-1-1Z|M16 12.5h-2.5V17H15a1 1 0 0 0 1-1Z',
  'ear-off': 'M4 14v-3.5a6 6 0 0 1 1.5-4|M8 5a6 6 0 0 1 8 5.500V14|M4 12.5h2.5V17H5a1 1 0 0 1-1-1Z|M16 12.5h-2.5V15|M3.5 3.5l13 13',
  leave: 'M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3|M12.500 6.500L16 10l-3.500 3.500|M16 10H8',
  sliders: 'M4 6h7|M14.5 6H16|M4 14h1.5|M9 14h7|M12.750 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z|M7.250 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  send: 'M10 16V4.5|M5 9l5-5 5 5',
  clip: 'M14.5 9.5l-5 5a3 3 0 0 1-4.200-4.200l6-6a2 2 0 0 1 2.800 2.800l-5.900 5.900a1 1 0 0 1-1.400-1.400l5-5',
  at: 'M13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm0 0v1a2 2 0 0 0 4 0v-1a7 7 0 1 0-3 5.750',
  edit: 'M4 16l.8-3.400 8.600-8.600a1.500 1.500 0 0 1 2.100 0l.5.5a1.500 1.500 0 0 1 0 2.100L7.400 15.200z|M12 5.500l2.500 2.500',
  trash: 'M4.500 6h11|M8 6V4.500h4V6|M6 6l.7 9.500a1 1 0 0 0 1 .9h4.600a1 1 0 0 0 1-.9L14 6',
  copy: 'M7.500 7.500h8v8h-8z|M12.500 7.500v-3h-8v8h3',
  tray: 'M3.500 11l2-6.500h9l2 6.500v4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z|M3.500 11H7a3 3 0 0 0 6 0h3.500',
  file: 'M6 3.500h5.500L15 7v9.500H6z|M11.500 3.500V7H15',
  image: 'M3.500 4.500h13v11h-13z|M3.500 13l3.500-3.500 3 3 2.500-2.500 4 4|M12.800 7.800v.2',
  undo: 'M7 5L3.500 8.500 7 12|M3.500 8.500h8a4.500 4.500 0 0 1 0 9H9',
  offline: 'M3.500 3.500l13 13|M4.500 9.500a8.500 8.500 0 0 1 2.700-1.800|M10.500 6.800a8.500 8.500 0 0 1 5 2.700|M7.500 12.500a4 4 0 0 1 2-.9|M10 15.500v.1',
  alert: 'M10 3.500l7.500 13h-15z|M10 8.500V12|M10 14.300v.1',
  compose: 'M16 10.500V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4.500|M8 12l.6-2.600 6.200-6.200a1.300 1.300 0 0 1 1.900 0l.1.1a1.300 1.300 0 0 1 0 1.900l-6.200 6.200z',
  keys: 'M2.500 5.500h15v9h-15z|M5.500 8.500h.1|M8.500 8.500h.1|M11.500 8.500h.1|M14.500 8.500h.1|M6.500 11.500h7',
  user: 'M10 9.500a3.200 3.200 0 1 0 0-6.400 3.200 3.200 0 0 0 0 6.400Z|M4 17a6 6 0 0 1 12 0',
  eye: 'M2.500 10S5 4.500 10 4.500 17.500 10 17.500 10 15 15.500 10 15.500 2.500 10 2.500 10Z|M10 12.200a2.200 2.200 0 1 0 0-4.400 2.200 2.200 0 0 0 0 4.400Z',
  flask: 'M8 3.500h4|M8.500 3.500V8l-4 7a1 1 0 0 0 .9 1.500h9.200a1 1 0 0 0 .9-1.500l-4-7V3.500|M6.500 12h7',
  shield: 'M10 3l5.500 2v4.500c0 3.500-2.300 6.200-5.500 7.500-3.200-1.300-5.500-4-5.500-7.500V5z',
  house: 'M3.500 9.500L10 4l6.500 5.500|M5 8.500V16h10V8.500|M8.500 16v-4h3v4',
  link: 'M8.500 11.500a3 3 0 0 0 4.200 0l2.600-2.600a3 3 0 0 0-4.200-4.200l-.9.9|M11.500 8.500a3 3 0 0 0-4.200 0l-2.600 2.600a3 3 0 0 0 4.200 4.200l.9-.9',
  // Added for people views (friends, discover, profiles).
  star: 'M10 3.200l2 4.100 4.500.6-3.300 3.100.8 4.500L10 13.400l-4 2.100.8-4.500-3.300-3.100 4.500-.6z',
  starred: 'f:M10 3.200l2 4.100 4.500.6-3.300 3.100.8 4.500L10 13.400l-4 2.100.8-4.500-3.300-3.100 4.500-.6z|M10 3.200l2 4.100 4.500.6-3.300 3.100.8 4.500L10 13.400l-4 2.100.8-4.500-3.300-3.100 4.500-.6z',
  'user-plus': 'M8.500 9.500a3.200 3.200 0 1 0 0-6.400 3.200 3.200 0 0 0 0 6.400Z|M2.500 17a6 6 0 0 1 9.500-4.900|M15.500 11.500v5|M13 14h5',
  'user-check': 'M8.500 9.500a3.200 3.200 0 1 0 0-6.400 3.200 3.200 0 0 0 0 6.400Z|M2.500 17a6 6 0 0 1 9.500-4.900|M12.500 14.300l2 2 3.500-4',
  compass: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z|M12.800 7.200l-1.600 4-4 1.600 1.600-4z',
  calendar: 'M4.500 5h11a1 1 0 0 1 1 1v9.500a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z|M3.500 8.500h13|M7 3.500v3|M13 3.500v3',
  external: 'M11.500 4H16v4.500|M16 4l-6.500 6.500|M14 11.500V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.500',
  // Added for camera and screen sharing in voice rooms.
  // Calls: a handset; hanging up (the handset turned down); a missed call (an arrow that turned back).
  phone: 'M7.2 3.5H5a1.5 1.5 0 0 0-1.5 1.6A12 12 0 0 0 14.9 16.5a1.5 1.5 0 0 0 1.6-1.5v-2.2a1 1 0 0 0-.7-1l-2.6-.8a1 1 0 0 0-1 .3l-1.1 1.1a9 9 0 0 1-3.5-3.5l1.1-1.1a1 1 0 0 0 .3-1l-.8-2.6a1 1 0 0 0-1-.7Z',
  'phone-off': 'M2.8 10.4a10.5 10.5 0 0 1 14.4 0 1 1 0 0 1 .1 1.4l-1.4 1.6a1 1 0 0 1-1.2.2l-2.1-1a1 1 0 0 1-.6-.9v-1.4a8 8 0 0 0-4 0v1.4a1 1 0 0 1-.6.9l-2.1 1a1 1 0 0 1-1.2-.2l-1.4-1.6a1 1 0 0 1 .1-1.4Z',
  'phone-missed': 'M6.2 5.5H4.8a1.3 1.3 0 0 0-1.3 1.4A10.5 10.5 0 0 0 13.1 16.5a1.3 1.3 0 0 0 1.4-1.3v-1.6a1 1 0 0 0-.7-.9l-2.1-.6a1 1 0 0 0-.9.3l-.9.9A7.8 7.8 0 0 1 7.2 10.6l.9-.9a1 1 0 0 0 .3-.9l-.6-2.1a1 1 0 0 0-.9-.7Z|M12 3.5l2.5 2.5 3.5-3.5|M12 3.5h2.4|M12 3.5v2.4',
  camera: 'M3.500 6.500h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z|M12.500 9l4-2.500v7l-4-2.500',
  'camera-off': 'M8 6.500h3.500a1 1 0 0 1 1 1V11|M12.500 13.300a1 1 0 0 1-1 .2h-8a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1|M12.500 9l4-2.500v7l-2-1.250|M3.500 3.500l13 13',
  screen: 'M3.500 4.500h13a1 1 0 0 1 1 1v7.500a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5.500a1 1 0 0 1 1-1Z|M7 17h6|M10 14v3|M10 11.500V7.500|M8 9.300l2-1.800 2 1.800',
  'screen-off': 'M3.500 4.500h13a1 1 0 0 1 1 1v7.500a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5.500a1 1 0 0 1 1-1Z|M7 17h6|M10 14v3|M8 7.500l4 4|M12 7.500l-4 4',
  expand: 'M3.500 7.500v-4h4|M16.500 7.500v-4h-4|M3.500 12.500v4h4|M16.500 12.500v4h-4',
  shrink: 'M7.500 3.500v4h-4|M12.500 3.500v4h4|M7.500 16.500v-4h-4|M12.500 16.500v-4h4',
  // Added for voice messages and GIFs.
  play: 'f:M6.500 4.500v11l9-5.500z|M6.500 4.500v11l9-5.500z',
  pause: 'f:M5.500 4.500h3v11h-3z|f:M11.500 4.500h3v11h-3z',
  gif: 'M3 5.500h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z|M8 8.500H6.500a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1H8V10H7|M10.500 8.500v3|M13 11.500v-3h2|M13 10h1.500',
  // Added for messaging (js/views/messaging.js): polls, forwarding, scheduling, stickers, edit history, formatting.
  poll: 'M4 5.5h8|M4 10h12|M4 14.5h5',
  forward: 'M12 5l4 4-4 4|M16 9H8.5A4.5 4.5 0 0 0 4 13.5V15',
  clock: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z|M10 6.5V10l2.5 1.5',
  history: 'M3.5 10a6.5 6.5 0 1 0 1.9-4.6|M3.5 3.5v3h3|M10 7v3.2l2.2 1.3',
  sticker: 'M16.5 11.5V5A1.5 1.5 0 0 0 15 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h6.5Z|M11.5 16.5V13a1.5 1.5 0 0 1 1.5-1.5h3.5|M7.5 8v.3|M12.5 8v.3',
  bold: 'M6 4h4.5a3 3 0 0 1 0 6H6z|M6 10h5.5a3 3 0 0 1 0 6H6z',
  italic: 'M9 4h6|M5 16h6|M12 4L8 16',
  underline: 'M6 4v5a4 4 0 0 0 8 0V4|M5 16.5h10',
  strike: 'M4 10h12|M13.5 6.5c-.5-1.2-1.8-2-3.5-2-2 0-3.5 1-3.5 2.5|M7 13.5c.5 1.2 1.8 2 3.3 2 2 0 3.5-1 3.5-2.5',
  code: 'M7 6l-4 4 4 4|M13 6l4 4-4 4',
  spoiler: 'M3 10s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z|M3.5 3.5l13 13',
  quote: 'M5 5v10|M9 7h7|M9 10h7|M9 13h5',
  list: 'M8 6h8|M8 10h8|M8 14h8|M4.5 6v.2|M4.5 10v.2|M4.5 14v.2',
  // Added for the redesign: channel, voice and shell controls.
  hash: 'M8.2 3.5L6.8 16.5|M13.2 3.5l-1.4 13|M4 7.5h12.5|M3.5 12.5H16',
  speaker: 'M3.5 8v4h2.8l4.2 3.5v-11L6.3 8Z|M13.3 7.6a3.4 3.4 0 0 1 0 4.8|M15.6 5.3a6.6 6.6 0 0 1 0 9.4',
  'speaker-off': 'M3.5 8v4h2.8l4.2 3.5v-11L6.3 8Z|M13.5 8l4 4|M17.5 8l-4 4',
  headphones: 'M3.5 14v-3.5a6.5 6.5 0 0 1 13 0V14|M3.5 12.5h2.2a.8.8 0 0 1 .8.8v3a.8.8 0 0 1-.8.8H5a1.5 1.5 0 0 1-1.5-1.5Z|M16.5 12.5h-2.2a.8.8 0 0 0-.8.8v3a.8.8 0 0 0 .8.8H15a1.5 1.5 0 0 0 1.5-1.5Z',
  'headphones-off': 'M3.5 14v-3.5a6.5 6.5 0 0 1 1.6-4.3|M7.6 4.6A6.5 6.5 0 0 1 16.5 10.5V14|M3.5 12.5h2.2a.8.8 0 0 1 .8.8v3a.8.8 0 0 1-.8.8H5a1.5 1.5 0 0 1-1.5-1.5Z|M16.5 12.5h-2.2a.8.8 0 0 0-.8.8V15|M3 3l14 14',
  'chev-u': 'M5 12.5l5-5 5 5',
  'chev-l': 'M12.5 5l-5 5 5 5',
  'more-v': 'f:M8.6 5a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 0 0-2.8 0Z|f:M8.6 10a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 0 0-2.8 0Z|f:M8.6 15a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 0 0-2.8 0Z',
  filter: 'M3.5 5h13|M6 10h8|M8.5 15h3',
  'arrow-up': 'M10 16V4.5|M5 9.5l5-5 5 5',
  dm: 'M3.5 6A1.5 1.5 0 0 1 5 4.5h10A1.5 1.5 0 0 1 16.5 6v7a1.5 1.5 0 0 1-1.5 1.5H8.5L5 17v-2.5A1.5 1.5 0 0 1 3.5 13Z|M7 8.5h6|M7 11h3.5',
  dot: 'f:M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  // Distinct marks so one drawing never means two things (settings pages, voice rows).
  join: 'M11 4h3.500A1.500 1.500 0 0 1 16 5.500v9a1.500 1.500 0 0 1-1.500 1.500H11|M4 10h8|M9 7l3 3-3 3',
  ban: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z|M5.100 5.100l9.800 9.800',
  palette: 'M10 3a7 7 0 0 0 0 14c.900 0 1.500-.600 1.500-1.400 0-.500-.300-.900-.300-1.400 0-.800.600-1.400 1.400-1.400H14a3 3 0 0 0 3-3C17 6 13.900 3 10 3Z|f:M6.300 10.600a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z|f:M8.300 7.200a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z|f:M12.200 7.200a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  access: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z|f:M10 7.300a1.100 1.100 0 1 0 0-2.200 1.100 1.100 0 0 0 0 2.200Z|M6.500 8.400l3.500.8 3.500-.8|M10 9.200v2.300l-1.800 3|M10 11.500l1.800 3',
  tag: 'M3.500 4.500v4.600l7.400 7.400a1 1 0 0 0 1.400 0l4.200-4.200a1 1 0 0 0 0-1.400L9.100 3.500H4.500a1 1 0 0 0-1 1Z|f:M7 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  idcard: 'M3 5.500h14v9H3z|M7 10.300a1.500 1.500 0 1 0 0-3 1.500 1.500 0 0 0 0 3Z|M4.800 13c.400-1 1.200-1.500 2.200-1.500s1.800.500 2.200 1.500|M11.500 8.500H15|M11.500 11H14',
};

// A gear drawn from its geometry (8 teeth), so it sits on the same grid.
function gear(cx = 10, cy = 10, teeth = 8, ro = 7.3, ri = 5.6, tw = 0.42) {
  const pts = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i += 1) {
    const a = i * step - Math.PI / 2;
    const t = step * tw / 2, g = step * (1 - tw) / 2;
    for (const [ang, r] of [[a - t - g * 0.35, ri], [a - t, ro], [a + t, ro], [a + t + g * 0.35, ri]]) pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }
  return `M${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z|M10 12.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z`;
}
P.gear = gear();

// Other names for the same drawings.
const ALIAS = {
  settings: 'gear', members: 'people', inbox: 'tray', home: 'house', 'more-h': 'more', 'more-horizontal': 'more',
  chevron: 'chev-d', 'chev-down': 'chev-d', 'chev-right': 'chev-r', 'chev-left': 'chev-l', 'chev-up': 'chev-u',
  close: 'x', mention: 'at', emoji: 'smile', attach: 'clip', mute: 'bell-off', deafen: 'headphones-off',
  undeafen: 'headphones', hangup: 'phone-off', channel: 'hash', 'voice-room': 'speaker', delete: 'trash', notifications: 'bell',
};
for (const [k, v] of Object.entries(ALIAS)) if (!P[k]) P[k] = P[v];

// Places (js/views/places.js) and voice options (js/views/voiceopts.js) add their own icons here.
export const addIcons = (more) => Object.assign(P, more);

// The stroke, in grid units, that draws about the same on-screen weight at
// every size: 1.5px at 16-18, 1.6px at 20, 1.75px at 24 and up, 1.3px below 16.
const strokeFor = (size) => {
  const px = size < 16 ? 1.3 : size <= 18 ? 1.5 : size <= 22 ? 1.6 : 1.75;
  return +(px * 20 / size).toFixed(3);
};

export function Icon({ name, size = 20 }) {
  const parts = (P[name] || '').split('|');
  return html`<svg class="ic" width=${size} height=${size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width=${strokeFor(size)} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${parts.map((d) => (d.startsWith('f:')
      ? html`<path d=${d.slice(2)} fill="currentColor" stroke="none" />`
      : html`<path d=${d} />`))}
  </svg>`;
}
