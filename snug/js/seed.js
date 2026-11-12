// Demo data: two houses you belong to, one you are invited to, and a few
// direct conversations. Times are relative to "now" so the app always opens
// with fresh activity. Nothing here is fetched; a real backend would replace it.
import { DAY, MIN } from './lib/util.js';

const ALL = ['post', 'announce', 'highlight', 'moderate', 'rooms', 'invite', 'roles'];

const person = (name, hue, presence, extra = {}) => ({ name, hue, presence, status: '', about: '', ...extra });

const USERS = {
  robin: person('Robin Hale', 165, 'around', { about: 'Mostly bowls. Sundays on the bike.' }),
  ines: person('Ines Carvalho', 35, 'open', { status: 'On the studio floor from 4', about: 'Runs Kiln & Co. Ask me about classes.' }),
  tomasz: person('Tomasz Wójcik', 215, 'focus', { status: 'Loading the kiln', about: 'Kiln technician. If it is hot, do not touch it.' }),
  priya: person('Priya Raman', 300, 'around', { about: 'Glaze tests, mostly failed ones.' }),
  malik: person('Malik Osei', 60, 'open', { emoji: '🦊', about: 'Mug number 40 and counting.' }),
  sunniva: person('Sunniva Berg', 130, 'around', { status: 'Mixing glazes', emoji: '🌿', about: 'Glaze chemistry, sieves, patience.' }),
  hyunwoo: person('Hyun-woo Park', 250, 'away', { about: 'Shino and large jars.' }),
  dara: person('Dara Okonkwo', 15, 'open', { about: 'Handbuilder. Moon jars this year.' }),
  lea: person('Léa Fontaine', 330, 'around', { about: 'New here. Thursday beginners.' }),
  farid: person('Farid Haddad', 95, 'offline', { about: 'Learning to read cones.' }),
  jonas: person('Jonas Lindqvist', 230, 'open', { status: 'Route planning', about: 'Ride captain. Brings the alignment tool.' }),
  aiko: person('Aiko Tanaka', 0, 'around', { emoji: '🚲', about: 'Climbs under protest.' }),
  noor: person('Noor Aziz', 190, 'away', { status: 'On a ride', about: 'Leads the short loop.' }),
  callum: person('Callum Reid', 75, 'offline', { about: 'Here for the cake.' }),
  mateo: person('Mateo Ruiz', 280, 'around', { about: 'Gravel when it is dry, road when it is not.' }),
  bex: person('Bex Morrow', 310, 'open', { about: 'Hosts Small Hours. Deletes more code than she writes.' }),
  kwame: person('Kwame Mensah', 110, 'around', { about: 'Building a synth in the browser.' }),
  yuki: person('Yuki Sato', 350, 'offline', { about: 'Zines about transit maps.' }),
  odile: person('Odile Brandt', 265, 'focus', { status: 'Writing', about: 'Interactive fiction, reluctant CSS.' }),
};

const room = (house, name, kind, topic) => ({ house, name, kind, topic, notify: null, highlights: [] });

const ROOMS = {
  k_desk: room('kiln', 'Front desk', 'news', 'Notices from the studio leads'),
  k_floor: room('kiln', 'The floor', 'text', 'Day-to-day studio chat'),
  k_glaze: room('kiln', 'Glaze lab', 'text', 'Recipes, tests and what went wrong'),
  k_firing: room('kiln', 'Firing schedule', 'text', 'What is going in the kiln, and when'),
  k_show: room('kiln', 'Show & tell', 'text', 'Fresh out of the kiln'),
  k_market: room('kiln', 'Marketplace', 'text', 'Buy, sell and swap'),
  k_classes: room('kiln', 'Classes', 'text', 'Courses and workshops'),
  k_wheel: room('kiln', 'Wheel room', 'voice', 'Talk while you throw'),
  k_watch: room('kiln', 'Kiln watch', 'voice', 'Company for long firings'),
  r_board: room('riders', 'Notice board', 'news', 'Rides and club news'),
  r_plans: room('riders', 'Ride plans', 'text', 'Who is riding, where and when'),
  r_routes: room('riders', 'Routes', 'text', 'Good roads, and where the mud is'),
  r_workshop: room('riders', 'Workshop', 'text', 'Repairs, kit and bad ideas'),
  r_results: room('riders', 'Results & bragging', 'text', 'Times, photos, excuses'),
  r_coffee: room('riders', 'Coffee stop', 'voice', 'Post-ride debrief'),
  s_start: room('small', 'Start here', 'news', 'Read this first'),
  s_intro: room('small', 'Introductions', 'text', 'Say hello'),
  s_ship: room('small', 'Ship log', 'text', 'What you shipped, however small'),
  s_help: room('small', 'Help desk', 'text', 'Ask anything'),
  s_review: room('small', 'Code review', 'text', 'A second pair of eyes'),
  s_tools: room('small', 'Tools', 'text', 'Editors, plugins, gadgets'),
  s_off: room('small', 'Off topic', 'text', 'Everything else'),
  s_jobs: room('small', 'Jobs', 'text', 'Paid work and collaborators'),
  s_pair: room('small', 'Pairing', 'voice', 'Work alongside someone'),
};

const HOUSES = {
  kiln: {
    name: 'Kiln & Co.', mark: 'K', hue: 35, joined: true, newcomer: false, notify: 'all',
    about: 'A shared pottery studio. Twelve wheels, two kilns, one kettle.',
    roles: [
      { id: 'lead', name: 'Studio lead', hue: 35, perms: ALL },
      { id: 'tech', name: 'Technician', hue: 215, perms: ['post', 'announce', 'highlight', 'moderate', 'rooms'] },
      { id: 'member', name: 'Member', hue: null, perms: ['post', 'invite'] },
      { id: 'new', name: 'Newcomer', hue: null, perms: ['post'] },
    ],
    joinRole: 'new',
    members: { ines: 'lead', robin: 'lead', tomasz: 'tech', priya: 'member', malik: 'member', sunniva: 'member', hyunwoo: 'member', dara: 'member', lea: 'new', farid: 'new' },
    groups: [
      { id: 'kg1', name: 'Studio', rooms: ['k_desk', 'k_floor', 'k_glaze', 'k_firing', 'k_show'] },
      { id: 'kg2', name: 'Practical', rooms: ['k_market', 'k_classes'] },
      { id: 'kg3', name: 'Live', rooms: ['k_wheel', 'k_watch'] },
    ],
    starter: ['k_desk', 'k_floor', 'k_show'],
  },
  riders: {
    name: 'Ridgeline Riders', mark: 'R', hue: 250, joined: true, newcomer: false, notify: 'all',
    about: 'Sunday club rides in the Chilterns. No-drop, cake mandatory.',
    roles: [
      { id: 'captain', name: 'Ride captain', hue: 300, perms: ALL },
      { id: 'member', name: 'Rider', hue: null, perms: ['post', 'invite'] },
    ],
    joinRole: 'member',
    members: { jonas: 'captain', noor: 'captain', robin: 'member', aiko: 'member', callum: 'member', mateo: 'member', bex: 'member' },
    groups: [
      { id: 'rg1', name: 'Club', rooms: ['r_board', 'r_plans', 'r_routes', 'r_workshop', 'r_results'] },
      { id: 'rg2', name: 'Live', rooms: ['r_coffee'] },
    ],
    starter: ['r_board', 'r_plans', 'r_routes'],
  },
  small: {
    name: 'Small Hours', mark: 'S', hue: 290, joined: false, newcomer: false, notify: 'all',
    about: 'People who make things after everyone else has gone to bed.',
    roles: [
      { id: 'host', name: 'Host', hue: 290, perms: ALL },
      { id: 'regular', name: 'Regular', hue: 200, perms: ['post', 'invite', 'highlight'] },
      { id: 'new', name: 'New here', hue: null, perms: ['post'] },
    ],
    joinRole: 'new',
    members: { bex: 'host', kwame: 'regular', odile: 'regular', yuki: 'regular' },
    groups: [
      { id: 'sg1', name: 'Welcome', rooms: ['s_start', 's_intro'] },
      { id: 'sg2', name: 'Making', rooms: ['s_ship', 's_help', 's_review', 's_tools'] },
      { id: 'sg3', name: 'Around', rooms: ['s_off', 's_jobs', 's_pair'] },
    ],
    starter: ['s_start', 's_intro', 's_ship'],
    firstStep: { room: 's_intro', label: 'Introduce yourself', draft: 'Hi, I’m Robin. ' },
  },
};

export function seed(now) {
  const at = (days, hhmm) => {
    const d = new Date(now - days * DAY);
    const [h, m] = hhmm.split(':');
    d.setHours(+h, +m, 0, 0);
    return d.getTime();
  };
  const ago = (min) => now - min * MIN;

  let n = 0;
  const msgs = {}, threads = {};
  const put = (conv, rows) => {
    msgs[conv] = rows.map(([ts, author, text, x = {}]) => {
      const m = { id: x.k ? `m_${x.k}` : `m${n++}`, author, ts, text };
      if (x.re) m.replyTo = `m_${x.re}`;
      if (x.r) m.reactions = x.r;
      if (x.f) m.files = x.f;
      if (x.th) {
        const t = `t:${m.id}`;
        threads[t] = { conv, root: m.id };
        msgs[t] = x.th.map(([ts2, a2, t2]) => ({ id: `m${n++}`, author: a2, ts: ts2, text: t2 }));
      }
      return m;
    }).sort((a, b) => a.ts - b.ts);
  };
  const img = (art, name, w, h) => ({ kind: 'image', art, name, w, h });

  // Kiln & Co.
  put('k_desk', [
    [at(6, '10:00'), 'ines', '**Holiday hours**\nThe studio is closed 24 to 26 December. Kilns go off on the 22nd, so the last glaze firing of the year is Saturday the 20th.'],
    [at(2, '09:00'), 'ines', '**Thursday beginners is full**\nThe waitlist is open. Message me and I’ll add you.'],
    [ago(200), 'ines', '**Saturday shared glaze load**\nBring glazed work by 10 am. Cone 6 only. Wipe your foot rings, or Tomasz will find you.', { r: { '🫡': ['malik', 'priya', 'dara'] } }],
  ]);
  put('k_floor', [
    [at(1, '09:05'), 'ines', 'Morning all. The bisque kiln is unloaded, everything from Tuesday’s class is on the blue cart.'],
    [at(1, '09:07'), 'ines', 'Two pieces had glaze on the foot ring. Please wipe your bottoms, people.', { r: { '😂': ['malik', 'priya', 'sunniva'] } }],
    [at(1, '09:20'), 'malik', 'Guilty. I’ll bring biscuits as an apology.'],
    [at(1, '09:41'), 'priya', 'Is the slab roller fixed? The left side was dragging last week.'],
    [at(1, '09:44'), 'tomasz', 'Fixed on Monday. The bearing was full of dried slip. If it drags again, stop and tell me. Don’t force it.', { r: { '🙏': ['priya'] } }],
    [at(1, '13:15'), 'sunniva', 'Does anyone have a spare bag of the speckled buff? The supplier is out until the 24th.', {
      k: 'buff',
      th: [
        [at(1, '13:22'), 'hyunwoo', 'I have half a bag in locker 12. Take it.'],
        [at(1, '13:24'), 'sunniva', 'You’re a lifesaver. Swap you for some of my porcelain?'],
        [at(1, '13:30'), 'hyunwoo', 'Deal.'],
      ],
    }],
    [at(1, '16:30'), 'dara', 'Reminder that the wedging tables get wiped down at the end of the day. I found a fossilised lump of terracotta this morning.'],
    [at(1, '16:32'), 'malik', 'Also guilty.'],
    [at(1, '16:33'), 'dara', 'Malik.', { r: { '😂': ['ines', 'priya', 'sunniva', 'robin'] } }],
    [ago(190), 'ines', 'Open studio runs till 9 tonight. I’m on the floor from 4.'],
    [ago(184), 'priya', 'I’ll be in around 6 to trim. Can someone leave the Giffin grip out?'],
    [ago(180), 'tomasz', 'It’s on wheel 3.'],
    [ago(95), 'lea', 'First time posting here. I joined the Thursday beginners class and I think I’m hooked.', { r: { '👋': ['ines', 'malik', 'priya', 'dara'] } }],
    [ago(93), 'ines', 'Welcome Léa! Show & tell is the place for your first pots. We love a wobbly bowl.'],
    [ago(60), 'malik', '@robin are you still up for splitting a kiln load on Saturday? I’ve got 14 mugs waiting.'],
    [ago(58), 'malik', 'Cone 6, same glazes as last time.'],
    [ago(22), 'sunniva', 'The new batch of tenmoku is mixed and sieved. Bucket 7. Stir it properly, it settles fast.'],
    [ago(20), 'hyunwoo', 'Specific gravity?'],
    [ago(19), 'sunniva', '1.45. Dip for a slow three count.'],
  ]);
  put('k_glaze', [
    [at(2, '18:10'), 'priya', 'Test tiles from the weekend. Celadon over white slip, tenmoku, the copper green that keeps crawling, and a satin white.', { f: [img('tiles', 'test-tiles.jpg', 640, 400)], k: 'tiles' }],
    [at(2, '18:12'), 'priya', 'The copper green crawled on every tile where it went on thicker than 2 mm.'],
    [at(2, '18:25'), 'sunniva', 'Crawling like that is usually too much raw clay in the recipe. It shrinks as it dries and pulls away. What’s the kaolin percentage?'],
    [at(2, '18:27'), 'priya', '25% EPK.'],
    [at(2, '18:31'), 'sunniva', 'Swap half of it for calcined kaolin. Same chemistry in the kiln, much less shrinkage on the pot.', { k: 'fix', r: { '💡': ['priya', 'robin', 'hyunwoo'] } }],
    [at(2, '18:40'), 'hyunwoo', 'Can confirm. Fixed my shino the same way.'],
    [at(1, '11:02'), 'robin', 'Has anyone layered the satin white over tenmoku? I want that breaking-edge look on a set of bowls.', {
      k: 'layer',
      th: [
        [at(1, '11:10'), 'sunniva', 'Yes. White over tenmoku goes a milky blue where it’s thick. Tenmoku over white just goes muddy.'],
        [at(1, '11:14'), 'robin', 'Milky blue is exactly it. Dip times?'],
        [at(1, '11:19'), 'sunniva', 'Tenmoku for a three count, let it dry fully, then white for one. Any longer and it runs.'],
        [ago(130), 'ines', 'There’s a test bowl of that combination on the top shelf by the window. Have a look before you commit a whole set.'],
      ],
    }],
    [at(1, '11:30'), 'tomasz', 'If you’re layering, keep it off the bottom third. Runny combinations glue pots to the shelf, and I’m the one who chisels them off.', { k: 'third', r: { '🫡': ['robin', 'priya'] } }],
    [ago(150), 'hyunwoo', 'Mixed a 2 kg test batch of the copper green with calcined kaolin. Tiles are going in Thursday’s firing.'],
    [ago(148), 'priya', 'Amazing. Label them please, I lost track of the last set.'],
    [ago(40), 'farid', 'Is cone 6 the same as 1,222 °C? I keep seeing different numbers.'],
    [ago(37), 'tomasz', 'It depends how fast you get there. Cones measure heat work, not temperature. That’s why we use witness cones and don’t just trust the pyrometer.', { k: 'cone' }],
    [ago(36), 'tomasz', '`1,222 °C at 60 °C/h` for the last 100 degrees\n`1,243 °C at 150 °C/h`'],
  ]);
  put('k_firing', [
    [at(3, '08:30'), 'tomasz', '**This week**\nTue: bisque, cone 06\nThu: glaze, cone 6, loading from 2 pm\nSat: glaze, cone 6, shared load', { k: 'week' }],
    [at(1, '08:15'), 'tomasz', 'Thursday’s schedule. Slow cool from 1,000 down to 760 °C to help the satin glazes.', { f: [img('curve', 'cone-6-slow-cool.png', 640, 400), { kind: 'file', name: 'Cone 6 slow cool.pdf', size: 86016 }], k: 'curve' }],
    [at(1, '08:40'), 'ines', 'Slow cool again? The glossy people will complain.'],
    [at(1, '08:44'), 'tomasz', 'The glossy people can have Saturday.', { r: { '😂': ['ines', 'malik'] } }],
    [ago(170), 'tomasz', 'Thursday’s load is about 80% full. Room for ten more mugs or two big pieces.'],
    [ago(75), 'tomasz', '@robin your celadon bowls are on shelf 3. Don’t unload before Friday noon, the kiln will still be over 200 °C.'],
    [ago(12), 'dara', 'Can I claim the last big-piece slot for a moon jar? 34 cm tall.'],
    [ago(10), 'tomasz', '34 fits with the half shelf out. It’s yours.'],
  ]);
  put('k_show', [
    [at(2, '20:15'), 'malik', 'Mug number 40 of the year. Finally a handle I don’t hate.', { f: [img('mug', 'mug-40.jpg', 480, 480)], r: { '❤️': ['ines', 'priya', 'lea', 'robin'], '🔥': ['dara'] } }],
    [at(2, '20:20'), 'ines', 'That handle is lovely. Pulled or extruded?'],
    [at(2, '20:21'), 'malik', 'Pulled, off the pot.'],
    [ago(88), 'lea', 'My first bowl survived trimming! It isn’t round, but it’s mine.', { r: { '🎉': ['ines', 'malik'] } }],
    [ago(86), 'priya', 'Round is overrated.'],
  ]);
  put('k_market', [
    [at(4, '12:10'), 'malik', 'Selling a Shimpo banding wheel, barely used. €45.'],
    [at(4, '12:31'), 'dara', 'Is it the 25 cm one?'],
    [at(4, '12:33'), 'malik', '22 cm.'],
    [at(1, '17:50'), 'hyunwoo', 'Looking for a second-hand kiln shelf, 40 cm round. Chips are fine.'],
  ]);
  put('k_classes', [
    [at(5, '10:20'), 'ines', 'Winter term starts 12 January. Members get first pick until Friday.'],
    [at(5, '11:02'), 'farid', 'Is the handbuilding course suitable for complete beginners?'],
    [at(5, '11:05'), 'ines', 'Yes, that’s exactly who it’s for.'],
  ]);
  put('k_wheel', [
    [at(1, '18:40'), 'malik', 'Wheel 2 is making that noise again.'],
    [at(1, '18:41'), 'priya', 'The one that sounds like a dying fridge?'],
    [at(1, '18:41'), 'malik', 'That’s the one.'],
  ]);
  put('k_watch', []);

  // Ridgeline Riders
  put('r_board', [
    [at(3, '18:00'), 'jonas', '**Sunday club ride**\n08:30 from the clock tower. 82 km with 1,150 m of climbing, café stop in Aldbury. No-drop, lights on.', { k: 'sunday' }],
  ]);
  put('r_plans', [
    [at(1, '19:02'), 'jonas', 'Sunday’s route is up. Two proper climbs. The second is the one everyone complains about.', { f: [img('elev', 'sunday-profile.png', 640, 280)] }],
    [at(1, '19:05'), 'aiko', 'Is that Ivinghoe Beacon from the steep side?'],
    [at(1, '19:06'), 'jonas', 'It is.'],
    [at(1, '19:06'), 'aiko', 'Great. Love that for me.', { r: { '😂': ['callum', 'noor', 'robin'] } }],
    [at(1, '19:30'), 'callum', 'Forecast says 4 °C at the start. Overshoes weather.'],
    [at(1, '19:44'), 'noor', 'I can lead a shorter loop for anyone who wants to skip the second climb. 58 km, back by 11:30.', { k: 'short' }],
    [at(1, '19:50'), 'bex', 'In for the short loop.'],
    [ago(140), 'mateo', 'Anyone riding out from the south side? I’m leaving Hemel at 07:50.'],
    [ago(131), 'noor', 'I’ll meet you at the canal bridge at 08:00.'],
    [ago(52), 'jonas', '@robin are you in for Sunday? I need numbers for the café by Friday.'],
    [ago(50), 'callum', 'Put me down. And put me down for cake.'],
  ]);
  put('r_routes', [
    [at(5, '08:12'), 'noor', 'The gravel loop through Ashridge is rideable again after the rain. One muddy stretch by the monument.'],
    [at(5, '08:30'), 'mateo', 'Route file is here: https://example.org/routes/ashridge-gravel'],
  ]);
  put('r_workshop', [
    [at(2, '20:02'), 'callum', 'Rear mech hanger is bent again. Does anyone have the alignment tool?'],
    [at(2, '20:10'), 'jonas', 'I do. Bring the bike on Sunday, it takes five minutes.'],
    [ago(300), 'mateo', 'Tubeless question: how often are you all topping up sealant?'],
    [ago(280), 'aiko', 'Every three months, or when I remember, whichever is later.'],
  ]);
  put('r_results', [
    [at(7, '14:20'), 'aiko', 'Under three hours on the reservoir loop. I’d like it noted.', { r: { '👏': ['jonas', 'noor', 'robin'] } }],
    [at(7, '14:26'), 'jonas', 'Noted. Tailwind also noted.'],
  ]);
  put('r_coffee', []);

  // Small Hours (invited, not joined yet)
  put('s_start', [
    [at(30, '21:00'), 'bex', '**Welcome to Small Hours.**\nWe make things after everyone else has gone to bed: apps, games, zines, synth patches. Post what you shipped, ask what you’re stuck on, and be kind about other people’s first drafts.'],
  ]);
  put('s_intro', [
    [at(3, '22:40'), 'kwame', 'Hi all. Kwame, backend developer by day, building a tiny synth in the browser by night.'],
    [at(2, '23:15'), 'yuki', 'Yuki here. I make zines about transit maps. Yes, really.', { r: { '🚇': ['bex', 'kwame'] } }],
    [at(1, '21:05'), 'odile', 'Odile. I write interactive fiction and occasionally fight with CSS.'],
  ]);
  put('s_ship', [
    [at(2, '23:40'), 'kwame', 'Shipped: oscillator drift. It now sounds worse on purpose.', { r: { '🎛️': ['bex', 'odile'] } }],
    [ago(400), 'yuki', 'Shipped: issue 4 of the zine went to the printer.'],
    [ago(390), 'bex', 'Shipped: nothing. But I deleted 400 lines, which is better.'],
  ]);
  put('s_help', [
    [at(1, '22:10'), 'odile', 'Why does my flex child refuse to shrink below its content?'],
    [at(1, '22:12'), 'kwame', '`min-width: 0` on the child. It’s always `min-width: 0`.', { r: { '😭': ['odile'] } }],
  ]);
  put('s_review', [
    [at(2, '22:02'), 'kwame', 'Anyone want to sanity-check this debounce?\n```js\nfunction debounce(fn, ms) {\n  let t;\n  return (...args) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...args), ms);\n  };\n}\n```'],
    [at(2, '22:09'), 'bex', 'Looks right. You lose `this` if someone calls it as a method, but you use arrows everywhere anyway.'],
  ]);
  put('s_tools', [[at(4, '23:02'), 'odile', 'Finally tried a split keyboard. My wrists are happy, my typing speed is not.']]);
  put('s_off', [[at(1, '00:40'), 'yuki', 'It is 00:40 and I am rearranging my bookshelf by colour instead of working.']]);
  put('s_jobs', [[at(6, '20:15'), 'bex', 'A friend’s studio needs a freelance illustrator for a two-week job in January. Message me for details.']]);
  put('s_pair', []);

  // Direct conversations
  put('d_ines', [
    [at(1, '12:02'), 'ines', 'Could you cover Saturday morning open studio? I’ve got a delivery at 9.'],
    [at(1, '12:06'), 'robin', 'Sure. Do I need the key, or will Tomasz be there?'],
    [at(1, '12:07'), 'ines', 'Tomasz opens at 8. You just need to be the friendly face.'],
    [at(1, '12:09'), 'robin', 'I can do friendly until at least 11.'],
    [ago(35), 'ines', 'Perfect. Also, your tenmoku bowls came out beautifully. I put one aside for the shop window, if that’s all right with you?'],
  ]);
  put('d_tomasz', [
    [at(4, '15:20'), 'robin', 'Is there space for a 40 cm platter this week?'],
    [at(4, '15:31'), 'tomasz', 'Not flat. I can fit it on edge in a setter if it’s bone dry.'],
    [at(4, '15:33'), 'robin', 'It’s been drying under plastic for ten days.'],
    [at(4, '15:34'), 'tomasz', 'Bring it Thursday before 2.'],
  ]);
  put('d_priya', [
    [at(2, '19:02'), 'priya', 'Did you write down Sunniva’s fix for the crawling?'],
    [at(2, '19:04'), 'robin', 'Saved it. Half the kaolin swapped for calcined.'],
    [at(2, '19:05'), 'priya', 'Thank you. My notes app is a graveyard.'],
  ]);
  put('d_jonas', [
    [at(6, '13:10'), 'jonas', 'You left a glove at the café.'],
    [at(6, '13:12'), 'robin', 'Left or right?'],
    [at(6, '13:12'), 'jonas', 'Left. It lives in my saddle bag now.'],
  ]);
  put('g_sat', [
    [at(1, '17:02'), 'malik', 'Saturday shared load: who’s bringing what?'],
    [at(1, '17:10'), 'ines', '8 bowls and 2 vases.'],
    [at(1, '17:12'), 'robin', '6 bowls and a jug with a questionable spout.'],
    [ago(57), 'malik', '14 mugs. We might need the big kiln.'],
  ]);

  const rooms = structuredClone(ROOMS);
  for (const id of Object.keys(rooms)) rooms[id].id = id;
  rooms.k_glaze.highlights = ['m_fix'];
  rooms.k_firing.highlights = ['m_week', 'm_curve'];
  const houses = structuredClone(HOUSES);
  for (const id of Object.keys(houses)) houses[id].id = id;
  const users = structuredClone(USERS);
  for (const id of Object.keys(users)) { users[id].id = id; users[id].handle = id; }

  const read = {};
  for (const conv of Object.keys(msgs)) read[conv] = ago(240);
  read.g_sat = now;

  return {
    v: 1,
    me: 'robin',
    users, houses, rooms,
    houseOrder: ['kiln', 'riders'],
    dms: {
      d_ines: { id: 'd_ines', members: ['robin', 'ines'] },
      d_tomasz: { id: 'd_tomasz', members: ['robin', 'tomasz'] },
      d_priya: { id: 'd_priya', members: ['robin', 'priya'] },
      d_jonas: { id: 'd_jonas', members: ['robin', 'jonas'] },
      g_sat: { id: 'g_sat', members: ['robin', 'ines', 'malik'], name: 'Saturday load' },
    },
    dmOrder: ['d_ines', 'g_sat', 'd_tomasz', 'd_priya', 'd_jonas'],
    msgs, threads, read,
    followed: { 't:m_layer': true },
    saved: [
      { id: 'm_fix', conv: 'k_glaze', at: at(2, '18:35'), note: 'Fix for the crawling copper green' },
      { id: 'm_third', conv: 'k_glaze', at: at(1, '11:31'), note: '' },
      { id: 'm_short', conv: 'r_plans', at: at(1, '19:45'), note: 'Short loop option' },
    ],
    drafts: {},
    voice: { k_wheel: ['malik', 'priya', 'dara'], k_watch: [], r_coffee: ['jonas', 'aiko'], s_pair: ['kwame', 'odile'] },
    call: null,
    invites: [{ house: 'small', from: 'bex', ts: ago(300) }],
    prefs: { theme: 'system', density: 'regular', text: 'm', motion: 'system', toasts: true, houseShut: {}, groupShut: {} },
    last: { view: { type: 'conv', id: 'k_floor' } },
  };
}
