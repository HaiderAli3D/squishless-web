// Minimal ZIP writer (no compression: images are already compressed).
//
//   const zip = await buildZip([{ name: 'photo.jpg', blob }, ...]);  // Blob (application/zip)
//
// Entries are stored (method 0) with CRC-32 and UTF-8 names (general purpose flag bit 11).
// Names are made unique case-insensitively ("a.jpg", "a (2).jpg", ...), and path
// separators are replaced so every entry lands in the archive root. No ZIP64: fine for
// the sizes a browser tab can hold (each entry and the archive must stay under 4 GiB,
// and there can be at most 65535 entries).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE) of bytes. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function cleanName(name) {
  let n = String(name == null ? '' : name).replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/g, '').trim();
  if (!n || n === '.' || n === '..') n = 'image';
  if (n.length > 200) { // keep the extension when capping very long names
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
    n = n.slice(0, 200 - ext.length).replace(/[\ud800-\udbff]$/, '') + ext;
  }
  return n;
}

/** Returns names made unique case-insensitively: "a.jpg", "a (2).jpg", "a (3).jpg". */
export function uniqueNames(names) {
  const used = new Set();
  return names.map((raw) => {
    const base = cleanName(raw);
    let name = base;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function dosDateTime(d) {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Builds a ZIP archive from [{ name, blob }]. Resolves to a Blob of type application/zip. */
export async function buildZip(entries) {
  const list = Array.from(entries || []);
  if (list.length > 0xffff) throw new RangeError('Too many files for one ZIP (max 65535)');
  const enc = new TextEncoder();
  const { time: dosTime, date: dosDate } = dosDateTime(new Date());
  const names = uniqueNames(list.map((e) => e.name));
  const parts = [];
  const central = [];
  let offset = 0;
  for (let i = 0; i < list.length; i++) {
    const blob = list[i].blob;
    const data = blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());
    const name = enc.encode(names[i]);
    const crc = crc32(data);
    if (data.length > 0xfffffffe || offset > 0xfffffffe) throw new RangeError('ZIP too large (over 4 GiB)');

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true); // version needed
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true); // store
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true); // version made by
    ch.setUint16(6, 20, true); // version needed
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    // extra, comment, disk start, internal attrs, external attrs = 0
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, list.length, true);
  end.setUint16(10, list.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
