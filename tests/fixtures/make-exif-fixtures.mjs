#!/usr/bin/env node
// Writes EXIF-rotated copies of site/samples/sample.jpg for the engine tests:
//   tests/fixtures/sample-orient6.jpg  (Orientation 6: display rotated 90° clockwise)
//   tests/fixtures/sample-orient3.jpg  (Orientation 3: display rotated 180°)
// The JPEG image data is unchanged; only the APP1 Exif segment is replaced by a minimal
// one holding the orientation tag. Usage: node tests/fixtures/make-exif-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../site/samples/sample.jpg');

/** Minimal APP1 Exif segment (big-endian TIFF) with IFD0 = { Orientation }. */
function exifSegment(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 offset
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18); // value (left-justified in the 4-byte field)
  tiff.writeUInt32BE(0, 22); // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

function withOrientation(jpeg, orientation) {
  if (jpeg.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG');
  const out = [jpeg.subarray(0, 2), exifSegment(orientation)];
  let p = 2;
  for (;;) {
    if (jpeg[p] !== 0xff) throw new Error(`bad marker at ${p}`);
    const marker = jpeg[p + 1];
    if (marker === 0xda) { out.push(jpeg.subarray(p)); break; } // SOS: rest is image data
    const len = jpeg.readUInt16BE(p + 2);
    const isExif = marker === 0xe1 && jpeg.subarray(p + 4, p + 10).toString('latin1') === 'Exif\0\0';
    if (!isExif) out.push(jpeg.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  return Buffer.concat(out);
}

const jpeg = fs.readFileSync(src);
for (const o of [6, 3]) {
  const dst = path.join(here, `sample-orient${o}.jpg`);
  fs.writeFileSync(dst, withOrientation(jpeg, o));
  console.log(`wrote ${path.relative(process.cwd(), dst)}`);
}
