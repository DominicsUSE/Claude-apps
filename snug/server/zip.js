// A small zip writer for "Download my data" (server/account.js): entries are
// written to a stream one at a time, so a big export never sits in memory
// whole. Each entry is deflated (or stored when that isn't smaller), with its
// CRC-32 and sizes in the local header; the central directory goes last.
// Plain zip (no zip64): an export is capped well below 4 GB by the caller.
import { crc32, deflateRawSync } from 'node:zlib';

// DOS date and time, as zip headers want them (local time, two-second steps).
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// write(buffer) -> Promise; returns { add(name, data, when?), end() }.
export function zipWriter(write) {
  const central = [];
  let offset = 0;
  const put = async (buf) => { await write(buf); offset += buf.length; };
  return {
    bytes: () => offset,
    async add(name, data, when = new Date()) {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const packed = deflateRawSync(raw);
      const deflate = packed.length < raw.length;
      const body = deflate ? packed : raw;
      const fname = Buffer.from(name, 'utf8');
      const crc = crc32(raw) >>> 0;
      const { time, date } = dosTime(when);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);           // version needed
      head.writeUInt16LE(0x0800, 6);       // names are UTF-8
      head.writeUInt16LE(deflate ? 8 : 0, 8);
      head.writeUInt16LE(time, 10);
      head.writeUInt16LE(date, 12);
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(body.length, 18);
      head.writeUInt32LE(raw.length, 22);
      head.writeUInt16LE(fname.length, 26);
      head.writeUInt16LE(0, 28);
      central.push({ fname, crc, size: body.length, raw: raw.length, method: deflate ? 8 : 0, time, date, at: offset });
      await put(head);
      await put(fname);
      await put(body);
    },
    async end() {
      const start = offset;
      for (const e of central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(20, 4);            // made by
        h.writeUInt16LE(20, 6);            // version needed
        h.writeUInt16LE(0x0800, 8);
        h.writeUInt16LE(e.method, 10);
        h.writeUInt16LE(e.time, 12);
        h.writeUInt16LE(e.date, 14);
        h.writeUInt32LE(e.crc, 16);
        h.writeUInt32LE(e.size, 20);
        h.writeUInt32LE(e.raw, 24);
        h.writeUInt16LE(e.fname.length, 28);
        h.writeUInt32LE(e.at, 42);
        await put(h);
        await put(e.fname);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(central.length, 8);
      end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(offset - start, 12);
      end.writeUInt32LE(start, 16);
      await put(end);
    },
  };
}
