// Decoder for the precomputed hero seams (.seams files written by cmd/heroseams at build
// time; the byte format is documented in cmd/heroseams/format.go).
//
//   const s = decodeSeams(arrayBuffer);
//   s.width, s.height    image size the seams were found in
//   s.seams              number of seams N
//   s.order              Uint16Array(width*height): the step at which each source pixel is
//                        removed, 65535 = never; identical to engine.seamOrder(axis 'x',
//                        maxSeams N) on the same pixels, so it feeds livepreview.renderOrder
//   s.path               Uint16Array(N*height): column of seam s in row y, in the image
//                        after s removals (index s*height + y)
//   s.orig               Uint16Array(N*height): the same pixel's column in the source image
//
// The order map is rebuilt by replaying the removals: each row keeps the list of source
// columns still present, and removing a seam pixel is one copyWithin on that list.

const MAGIC = 0x4d535153; // "SQSM" little-endian
export const NEVER = 65535;

export function decodeSeams(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16 || dv.getUint32(0, true) !== MAGIC) throw new Error('seams: not a .seams file');
  if (bytes[4] !== 1 || bytes[5] !== 0) throw new Error('seams: unsupported version');
  const w = dv.getUint16(8, true);
  const h = dv.getUint16(10, true);
  const n = dv.getUint16(12, true);
  const rs = dv.getUint16(14, true);
  if (!w || !h || n >= w || rs !== 2 + Math.ceil((2 * (h - 1)) / 8) || bytes.byteLength !== 16 + n * rs) {
    throw new Error('seams: inconsistent header');
  }

  const order = new Uint16Array(w * h).fill(NEVER);
  const path = new Uint16Array(n * h);
  const orig = new Uint16Array(n * h);
  // cols[y*w + i] = source column of the i-th remaining pixel of row y
  const cols = new Uint16Array(w * h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) cols[i] = x;

  for (let s = 0; s < n; s++) {
    let off = 16 + s * rs;
    let x = bytes[off] | (bytes[off + 1] << 8);
    off += 2;
    const cw = w - s; // current width
    let bits = 0;
    let cur = 0;
    for (let y = 0; y < h; y++) {
      if (y > 0) {
        if (bits === 0) { cur = bytes[off++]; bits = 8; }
        const code = cur & 3;
        cur >>= 2;
        bits -= 2;
        if (code === 1) x++;
        else if (code === 2) x--;
        else if (code === 3) throw new Error('seams: invalid step');
      }
      if (x < 0 || x >= cw) throw new Error('seams: column out of range');
      const row = y * w;
      const ox = cols[row + x];
      order[row + ox] = s;
      path[s * h + y] = x;
      orig[s * h + y] = ox;
      cols.copyWithin(row + x, row + x + 1, row + cw);
    }
  }
  return { width: w, height: h, seams: n, order, path, orig };
}

const cache = new Map();

/** Fetches and decodes /assets/landing/<id>.seams once (shared by the hero and "Watch it think"). */
export function loadSeams(id) {
  if (!cache.has(id)) {
    const p = fetch(`/assets/landing/${id}.seams?v=__BUILD_ID__`)
      .then((r) => {
        if (!r.ok) throw new Error(`seams: HTTP ${r.status} for ${id}`);
        return r.arrayBuffer();
      })
      .then(decodeSeams);
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return cache.get(id);
}

/** Loads an image and returns { img, rgba (Uint8ClampedArray), width, height }. */
const pixCache = new Map();
export function loadPixels(src, img) {
  if (!pixCache.has(src)) {
    const p = (async () => {
      const el = img || new Image();
      if (!img) {
        el.decoding = 'async';
        el.src = src;
      }
      if (!el.complete || !el.naturalWidth) {
        try {
          await el.decode();
        } catch {
          await new Promise((resolve, reject) => {
            if (el.complete && el.naturalWidth) return resolve();
            el.addEventListener('load', resolve, { once: true });
            el.addEventListener('error', () => reject(new Error('could not load ' + src)), { once: true });
          });
        }
      }
      const width = el.naturalWidth;
      const height = el.naturalHeight;
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(el, 0, 0);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      return { img: el, canvas: c, rgba, width, height };
    })();
    p.catch(() => pixCache.delete(src));
    pixCache.set(src, p);
  }
  return pixCache.get(src);
}
