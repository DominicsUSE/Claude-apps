// Voice and calls rules that run on both sides: connection quality from
// WebRTC statistics, the call clock, and the games' win and draw detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityOf, summarize, uplinkPoor, callClock, callClockWords } from '../js/lib/netquality.js';
import { gameResult, c4Drop, moveCell, emptyBoard, moveName, GAMES } from '../js/lib/games.js';

test('quality: good under 150 ms and 2% loss, poor over 400 ms or 8% loss, fair between, at the edges', () => {
  assert.equal(qualityOf({ rtt: 149, loss: 1.9 }), 'good');
  assert.equal(qualityOf({ rtt: 150, loss: 0 }), 'fair', '150 ms is not under 150');
  assert.equal(qualityOf({ rtt: 40, loss: 2 }), 'fair', '2% is not under 2');
  assert.equal(qualityOf({ rtt: 400, loss: 8 }), 'fair', 'the poor edges are exclusive');
  assert.equal(qualityOf({ rtt: 401, loss: 0 }), 'poor');
  assert.equal(qualityOf({ rtt: 20, loss: 8.1 }), 'poor');
  assert.equal(qualityOf({ rtt: null, loss: 0.5 }), 'good', 'loss alone is enough');
  assert.equal(qualityOf({ rtt: 500, loss: null }), 'poor');
  assert.equal(qualityOf({}), null, 'nothing known yet');
  assert.equal(qualityOf({ rtt: NaN, loss: Infinity }), null);
});

test('quality: a stats report gives the round trip, loss since the last poll, jitter, send bitrate and relay', () => {
  const report = (lost, recv, sent, ts, type = 'host') => [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.123, nominated: true, state: 'succeeded' },
    { id: 'P2', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.9, nominated: false },
    { id: 'L', type: 'local-candidate', candidateType: type },
    { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
    { id: 'I', type: 'inbound-rtp', kind: 'audio', packetsLost: lost, packetsReceived: recv, jitter: 0.012 },
    { id: 'O', type: 'outbound-rtp', kind: 'audio', bytesSent: sent, timestamp: ts },
  ];
  const a = summarize(report(10, 990, 10_000, 1000));
  assert.equal(a.rtt, 123, 'the selected pair, not another one');
  assert.equal(a.loss, 1);
  assert.equal(a.jitter, 12);
  assert.equal(a.sendKbps, null, 'no bitrate without a previous poll');
  assert.equal(a.relay, false);
  assert.equal(a.quality, 'good');
  // Two seconds later: 30 more lost of 300 is 10%, and 16 kB in 2 s is 64 kbit/s.
  const b = summarize(new Map(report(40, 1260, 26_000, 3000, 'relay').map((r) => [r.id, r])), a);
  assert.equal(b.loss, 10);
  assert.equal(b.sendKbps, 64);
  assert.equal(b.relay, true);
  assert.equal(b.quality, 'poor');
  // No transport entry: the nominated, succeeded pair.
  const c = summarize(report(0, 10, 0, 0).filter((r) => r.type !== 'transport'));
  assert.equal(c.rtt, 123);
  assert.equal(summarize([]).quality, null);
  assert.equal(uplinkPoor([{ quality: 'poor' }, { quality: 'poor' }, { quality: 'good' }]), true);
  assert.equal(uplinkPoor([{ quality: 'poor' }, { quality: 'good' }]), false);
  assert.equal(uplinkPoor([]), false);
});

test('call clock: mm:ss, then h:mm:ss; and in words', () => {
  assert.equal(callClock(0), '00:00');
  assert.equal(callClock(7_400), '00:07');
  assert.equal(callClock(12 * 60_000 + 45_000), '12:45');
  assert.equal(callClock(3_599_000), '59:59');
  assert.equal(callClock(3_600_000), '1:00:00');
  assert.equal(callClock(3_723_000), '1:02:03');
  assert.equal(callClock(-5), '00:00');
  assert.equal(callClockWords(30_000), 'under a minute');
  assert.equal(callClockWords(61_000), '1 minute');
  assert.equal(callClockWords(3_720_000), '1 hour 2 minutes');
});

test('games: tic-tac-toe rows, columns and diagonals win; a full board without a line is a draw', () => {
  const X = 0, O = 1, _ = null;
  assert.equal(gameResult('ttt', emptyBoard('ttt')), null);
  assert.deepEqual(gameResult('ttt', [X, X, X, O, O, _, _, _, _]), { winner: 0, line: [0, 1, 2] });
  assert.deepEqual(gameResult('ttt', [O, X, _, O, X, _, O, _, X]), { winner: 1, line: [0, 3, 6] });
  assert.deepEqual(gameResult('ttt', [X, O, _, O, X, _, _, _, X]), { winner: 0, line: [0, 4, 8] });
  assert.deepEqual(gameResult('ttt', [_, _, O, X, O, X, O, X, _]), { winner: 1, line: [2, 4, 6] });
  assert.deepEqual(gameResult('ttt', [X, O, X, X, O, O, O, X, X]), { draw: true });
  assert.equal(gameResult('ttt', [X, O]), null, 'a malformed board is no result');
  assert.equal(moveCell('ttt', [X, _, _, _, _, _, _, _, _], 0), -1, 'taken');
  assert.equal(moveCell('ttt', emptyBoard('ttt'), 9), -1);
  assert.equal(moveCell('ttt', emptyBoard('ttt'), 4), 4);
  assert.equal(moveName('ttt', 4), 'centre');
  assert.equal(moveName('ttt', 0), 'top left');
});

test('games: Connect Four drops to the lowest free row, refuses a full column, and finds four every way', () => {
  const { cols } = GAMES.c4;
  const b = emptyBoard('c4');
  assert.equal(c4Drop(b, 3), 5 * cols + 3, 'the bottom row first');
  for (let r = 0; r < 6; r++) b[r * cols] = r % 2;
  assert.equal(c4Drop(b, 0), -1, 'full');
  assert.equal(c4Drop(b, 7), -1);
  assert.equal(c4Drop(b, -1), -1);
  assert.equal(gameResult('c4', b), null, 'alternating is no line');
  const at = (r, c) => r * cols + c;
  const horiz = emptyBoard('c4'); [1, 2, 3, 4].forEach((c) => { horiz[at(5, c)] = 1; });
  assert.deepEqual(gameResult('c4', horiz), { winner: 1, line: [at(5, 1), at(5, 2), at(5, 3), at(5, 4)] });
  const vert = emptyBoard('c4'); [2, 3, 4, 5].forEach((r) => { vert[at(r, 6)] = 0; });
  assert.equal(gameResult('c4', vert).winner, 0);
  const diag = emptyBoard('c4'); [0, 1, 2, 3].forEach((k) => { diag[at(5 - k, k)] = 0; });
  assert.deepEqual(gameResult('c4', diag).line, [at(2, 3), at(3, 2), at(4, 1), at(5, 0)]);
  const diag2 = emptyBoard('c4'); [0, 1, 2, 3].forEach((k) => { diag2[at(k, k + 2)] = 1; });
  assert.equal(gameResult('c4', diag2).winner, 1);
  const three = emptyBoard('c4'); [0, 1, 2].forEach((c) => { three[at(5, c)] = 0; });
  assert.equal(gameResult('c4', three), null, 'three is not four');
  // A full board with no four: a draw.
  const full = Array.from({ length: 42 }, (_, i) => { const r = Math.floor(i / cols), c = i % cols; return (Math.floor(c / 2) + r) % 2; });
  assert.equal(gameResult('c4', full)?.winner, undefined);
  assert.deepEqual(gameResult('c4', full), { draw: true });
  assert.equal(moveName('c4', at(5, 4)), 'column 5');
});
