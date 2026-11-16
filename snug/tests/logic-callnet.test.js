// A call's network rules (js/lib/callnet.js): send caps for data saver and
// adaptive stepping, the relay decision for hiding an IP address, telling a
// new connection from a renegotiation, and the global push-to-talk wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendCaps, adaptStep, hasTurn, relayWanted, relayInsisted, sdpSession, pttGlobalWait,
  LOW_DATA, FLOOR, MAX_LEVEL, PTT_FIRST_WAIT,
} from '../js/lib/callnet.js';

test('caps: full quality follows the room and the screen setting; more than 3 others lowers the camera', () => {
  const c = sendCaps({ roomBps: 64_000, screenBps: 1_560_000 });
  assert.equal(c.voice.maxBitrate, 64_000);
  assert.equal(c.camera.maxBitrate, 900_000);
  assert.equal(c.camera.active, true);
  assert.equal(c.camera.scaleResolutionDownBy, undefined, 'full resolution');
  assert.equal(c.screen.maxBitrate, 1_560_000);
  assert.equal(sendCaps({ many: true }).camera.maxBitrate, 450_000);
});

test('caps: data saver puts voice at 24 kbit/s, the camera at a quarter of the pixels and 15 fps, the screen at 600 kbit/s and 10 fps', () => {
  const c = sendCaps({ roomBps: 96_000, screenBps: 3_000_000, lowData: true });
  assert.equal(c.voice.maxBitrate, LOW_DATA.voice);
  assert.deepEqual({ ...c.camera }, { maxBitrate: 250_000, active: true, scaleResolutionDownBy: 2, maxFramerate: 15 });
  assert.deepEqual({ ...c.screen }, { maxBitrate: 600_000, maxFramerate: 10 });
  // A room set lower than data saver keeps its own lower bitrate.
  assert.equal(sendCaps({ roomBps: 16_000, lowData: true }).voice.maxBitrate, 16_000);
});

test('caps: each step down halves video and screen within their floors, and voice goes 32, 24, 16 kbit/s', () => {
  const at = (level) => sendCaps({ roomBps: 64_000, screenBps: 1_200_000, level });
  assert.deepEqual([1, 2, 3].map((l) => at(l).voice.maxBitrate), [32_000, 24_000, 16_000]);
  assert.deepEqual([1, 2, 3].map((l) => at(l).camera.maxBitrate), [450_000, 225_000, FLOOR.camera]);
  assert.deepEqual([1, 2, 3].map((l) => at(l).screen.maxBitrate), [600_000, 300_000, FLOOR.screen]);
  assert.equal(at(1).camera.scaleResolutionDownBy, undefined);
  assert.equal(at(2).camera.scaleResolutionDownBy, 2, 'from step 2 the camera sends fewer pixels');
  assert.equal(at(9).voice.maxBitrate, 16_000, 'never past the last step');
});

test('caps: someone who asked not to get my camera (their data saver) gets it switched off', () => {
  assert.equal(sendCaps({ cameraWanted: false }).camera.active, false);
  assert.equal(sendCaps({ cameraWanted: true }).camera.active, true);
});

test('adapting: two bad polls step down, five good ones step back up, fair holds, unknown changes nothing', () => {
  let s = {};
  s = adaptStep(s, { loss: 12, rtt: 80 });
  assert.equal(s.level, 0, 'one bad poll is not enough');
  s = adaptStep(s, { loss: 12, rtt: 80 });
  assert.equal(s.level, 1);
  s = adaptStep(adaptStep(s, { loss: 0, rtt: 600 }), { loss: 0, rtt: 600 });
  assert.equal(s.level, 2, 'a long round trip counts as bad too');
  for (let i = 0; i < 20; i++) s = adaptStep(s, { loss: 30, rtt: 900 });
  assert.equal(s.level, MAX_LEVEL);
  for (let i = 0; i < 4; i++) s = adaptStep(s, { loss: 0, rtt: 40 });
  assert.equal(s.level, MAX_LEVEL, 'four good polls are not enough');
  s = adaptStep(s, { loss: 0, rtt: 40 });
  assert.equal(s.level, MAX_LEVEL - 1);
  const held = adaptStep({ level: 1, good: 4 }, { loss: 3, rtt: 200 });
  assert.deepEqual(held, { level: 1, bad: 0, good: 0 }, 'fair resets the counts');
  assert.deepEqual(adaptStep({ level: 2, bad: 1 }, {}), { level: 2, bad: 1, good: 0 });
});

test('relay: on by default in voice rooms and with people who are not friends; Always and Off; the PC-to-PC switch', () => {
  assert.equal(hasTurn([{ urls: 'stun:stun.example:3478' }]), false);
  assert.equal(hasTurn([{ urls: ['stun:a', 'turns:relay.example:443?transport=tcp'] }]), true);
  assert.equal(hasTurn(null), false);
  assert.equal(relayWanted({ room: true }), true, 'voice room');
  assert.equal(relayWanted({ friend: false }), true, 'a call with someone who is not a friend');
  assert.equal(relayWanted({ friend: true }), false, 'a call with a friend goes direct by default');
  assert.equal(relayWanted({ mode: 'all', friend: true }), true);
  assert.equal(relayWanted({ mode: 'off', room: true }), false);
  assert.equal(relayWanted({ mode: 'off', p2pHide: true, friend: true }), true, 'Hide my IP from friends wins');
  assert.equal(relayInsisted({}), false, 'the default is not a promise to keep without a relay');
  assert.equal(relayInsisted({ mode: 'all' }), true);
  assert.equal(relayInsisted({ p2pHide: true }), true);
});

test('sdp session: read from the o= line, the same across a renegotiation, absent from junk', () => {
  const a = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\n';
  assert.equal(sdpSession(a), '4611731400430051336');
  assert.equal(sdpSession({ type: 'offer', sdp: a.replace(' 2 IN', ' 3 IN') }), '4611731400430051336');
  assert.equal(sdpSession('nonsense'), null);
  assert.equal(sdpSession(null), null);
});

test('global push to talk: waits out a slow key repeat after the first press, then three missed repeats', () => {
  assert.equal(pttGlobalWait(null), PTT_FIRST_WAIT, 'first press: up to 1.1 s for the system to start repeating');
  assert.ok(pttGlobalWait(null) > 900, 'covers a 900 ms repeat delay');
  assert.equal(pttGlobalWait(33), 120, 'fast repeats: never under 120 ms');
  assert.equal(pttGlobalWait(100), 300);
  assert.equal(pttGlobalWait(5000), PTT_FIRST_WAIT, 'a long gap is a new press');
});
