// The names of the settings on each Settings page, so the search can find a
// setting and go straight to it (js/views/settings.js). Pages add the names
// they draw when they open, so a name missing here is still found once seen.
// Names only: states (On, Off) and people's own things (house names) stay out.
export const SETTING_ROWS = {
  profile: ['Name', 'About you', 'Picture', 'Colour', 'Interests', 'Links', 'Picture and style', 'Profile picture', 'Decoration', 'Name style', 'Profile colours', 'More about you', 'Pronouns', 'Accent', 'Banner', 'About, as people see it', 'Status', 'Username'],
  account: ['Connection', 'Devices and sessions', 'Sign out', 'Sign out on this device', 'Sign out everywhere', 'Your data', 'Download or delete your account'],
  security: ['Password', 'Two-factor sign-in', 'Recovery key', 'Passkeys', 'Sign in with a passkey', 'Encryption', 'End-to-end encryption', 'Active sessions', 'Signed-in devices', 'Recent activity'],
  privacy: ['Activity', 'Who sees when you’re online', 'Typing', 'Who can reach you', 'Who can message you', 'Message requests', 'Who can send you friend requests', 'Who can invite you to houses', 'Blocked', 'Who can see what'],
  e2ee: ['End-to-end encryption', 'Hide names in notifications'],
  data: ['Download your data', 'Keep a copy of messages on this device', 'End your account', 'Deactivate', 'Delete your account'],
  notify: ['How you’re told', 'Pop-ups', 'Notifications while Snug is open', 'Notify me when Snug is closed', 'Sound pack', 'Messages', 'Mentions', 'Direct messages', 'Volume', 'Show message text', 'Direct messages and groups', 'Highlight words', 'Calls and voice rooms', 'Calls from favourites', 'Quiet times', 'While you’re Focused', 'Quiet hours', 'From and until', 'Different on some days', 'Go idle after'],
  voice: ['Devices', 'Name your devices', 'Microphone', 'Speaker', 'Microphone check', 'Microphone volume', 'Output volume', 'Input mode', 'How your microphone opens', 'Set sensitivity automatically', 'Connection and privacy', 'Data saver', 'Hide my IP address from people in calls', 'Voice processing', 'Noise suppression', 'Echo cancellation', 'Automatic gain', 'Camera', 'Camera quality', 'Camera frame rate', 'Mirror my camera', 'Camera check', 'Screen share', 'What you share', 'Resolution', 'Frame rate', 'Share sound', 'Sounds and behaviour', 'Join and leave sounds', 'Mute and deafen sounds', 'Deafening mutes you too', 'Leave voice rooms when alone', 'Calls', 'Who can ring you', 'Ringtone', 'Ring volume', 'Ring on', 'Tell me when I’m muted'],
  look: ['Use these settings on this device only', 'Themes', 'Accent', 'Accent colour', 'Messages', 'Message display', 'Pictures in compact', 'Spacing', 'Line height', 'Chat', 'Times on messages', 'Big emoji', 'Emoji size', 'Reactions', 'Play GIFs', 'Animated emoji', 'Spoilers', 'People’s name styles', 'Chat background', 'Text', 'Font', 'Code font', 'Text size', 'Zoom', 'Clock', 'Colour', 'Saturation', 'Role colours on names', 'Layout', 'Sidebar width', 'Contrast and motion'],
  chat: ['Emoji', 'Skin tone', 'Frequently used', 'Turn emoticons into emoji', 'Messages', 'Double-tap to react', 'Show message IDs', 'Mention people you reply to'],
  a11y: ['Reading', 'Text size', 'Contrast', 'Font', 'Underline links', 'Motion', 'Keyboard and focus', 'Always show the focus ring', 'Keyboard', 'Speech', 'Read new messages aloud'],
  keys: ['Getting around', 'Voice and calls', 'Fixed'],
  streamer: ['Streamer mode'],
};
