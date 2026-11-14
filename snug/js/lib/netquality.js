// How a call's connections are really doing, from WebRTC's own statistics
// (RTCPeerConnection.getStats), and the call's running time. Pure functions,
// so the rules are tested on their own (tests/logic-voice.test.js) and the
// browser (js/voice.js) only feeds them reports.

// Good, fair or poor, from the round trip (ms) and the share of packets lost
// (percent). Either may be unknown (null); with both unknown there is no
// verdict yet.
//   good: under 150 ms and under 2% lost
//   poor: over 400 ms, or over 8% lost
//   fair: anything in between
export function qualityOf({ rtt = null, loss = null } = {}) {
  const r = Number.isFinite(rtt) ? rtt : null;
  const l = Number.isFinite(loss) ? loss : null;
  if (r == null && l == null) return null;
  if ((r != null && r > 400) || (l != null && l > 8)) return 'poor';
  if ((r == null || r < 150) && (l == null || l < 2)) return 'good';
  return 'fair';
}
export const QUALITY_LABEL = { good: 'Good connection', fair: 'Fair connection', poor: 'Poor connection' };

// One poll's numbers for one connection, from its stats report (anything
// with forEach or a list of stat objects) and the previous poll's summary
// (for the loss and bitrate since then).
//   rtt: ms on the connection in use; loss: % of incoming packets lost since
//   the last poll; jitter: ms; sendKbps: what I am sending (audio and video);
//   relay: true when the connection goes through a TURN relay.
export function summarize(report, prev = null) {
  const list = [];
  if (Array.isArray(report)) list.push(...report);
  else report?.forEach?.((r) => list.push(r));
  const byId = new Map(list.map((r) => [r.id, r]));
  let pair = null;
  for (const r of list) {
    if (r.type === 'transport' && r.selectedCandidatePairId && byId.get(r.selectedCandidatePairId)) { pair = byId.get(r.selectedCandidatePairId); break; }
  }
  if (!pair) pair = list.find((r) => r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) || null;
  const local = pair && byId.get(pair.localCandidateId);
  const remote = pair && byId.get(pair.remoteCandidateId);
  let lost = 0, received = 0, jitter = null, sent = 0, at = 0, inbound = false;
  for (const r of list) {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
      inbound = true;
      lost += Math.max(0, r.packetsLost || 0);
      received += r.packetsReceived || 0;
      if (Number.isFinite(r.jitter)) jitter = Math.max(jitter ?? 0, r.jitter * 1000);
    } else if (r.type === 'outbound-rtp') {
      sent += r.bytesSent || 0;
      at = Math.max(at, r.timestamp || 0);
    }
  }
  const rtt = pair && Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null;
  let loss = null;
  if (inbound) {
    const dLost = lost - (prev?.lost ?? 0), dRecv = received - (prev?.received ?? 0);
    loss = dLost + dRecv > 0 ? Math.round((Math.max(0, dLost) / (Math.max(0, dLost) + Math.max(0, dRecv))) * 1000) / 10 : 0;
  }
  let sendKbps = null;
  if (prev?.at && at > prev.at && sent >= prev.sent) sendKbps = Math.round(((sent - prev.sent) * 8) / (at - prev.at));
  const relay = !!pair && (local?.candidateType === 'relay' || remote?.candidateType === 'relay');
  const out = { rtt, loss, jitter: jitter == null ? null : Math.round(jitter), sendKbps, relay, lost, received, sent, at };
  out.quality = qualityOf(out);
  return out;
}

// My own uplink is poor when most of the people I talk to hear me badly.
export function uplinkPoor(summaries) {
  const known = summaries.filter((s) => s?.quality);
  return known.length > 0 && known.filter((s) => s.quality === 'poor').length * 2 > known.length;
}

// A call's running time: 00:07, 12:45, then 1:02:03.
export function callClock(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
}
// The same, in words, for a screen reader (said once, not on every tick).
export function callClockWords(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h} ${h === 1 ? 'hour' : 'hours'}${m ? ` ${m} ${m === 1 ? 'minute' : 'minutes'}` : ''}`;
  if (m) return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  return 'under a minute';
}
