// Live preview from a seam-order map (pure functions, main thread or worker).
//
// renderOrder(srcRGBA, w, h, order, axis, k, out?) -> ImageData
//   order: Uint16Array (w*h) from engine.seamOrder: the step at which each source pixel is
//   removed, 65535 = never (within maxSeams).
//   k > 0: remove k seams (keep pixels with order >= k).
//   k < 0: insert -k seams by duplicating pixels with order < -k (approximate preview of
//          enlarging; the real enlarge averages neighbours).
//   k = 0: copy.
//   Axis 'x' output is (w-k) x h, axis 'y' output is w x (h-k).
//   |k| is clamped to the number of seams the map holds (maxSeams), so check the
//   returned ImageData's size. Pass `out` to reuse an ImageData of the right size.
//
// renderNaive(srcRGBA, w, h, newW, newH, out?) -> ImageData
//   Plain bilinear resample ("normal resize", squashes everything), for comparison.

export const NEVER_REMOVED = 65535;

function u32View(bytes, n) {
  if (bytes.byteOffset % 4 === 0) return new Uint32Array(bytes.buffer, bytes.byteOffset, n);
  const copy = new Uint8Array(n * 4);
  copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, n * 4));
  return new Uint32Array(copy.buffer);
}

function makeImageData(w, h, out) {
  if (out && out.width === w && out.height === h) return out;
  return new ImageData(w, h);
}

// Cache of the seam count per order map (the number of entries < NEVER_REMOVED in one line).
const seamCounts = new WeakMap();

/** Number of seams the map can remove: removals in the first row (x) or column (y). */
export function orderSeams(order, w, h, axis) {
  const key = axis === 'y' ? 'y' : 'x';
  let c = seamCounts.get(order);
  if (c && c[key] !== undefined) return c[key];
  let n = 0;
  if (key === 'x') {
    for (let x = 0; x < w; x++) if (order[x] !== NEVER_REMOVED) n++;
  } else {
    for (let y = 0, i = 0; y < h; y++, i += w) if (order[i] !== NEVER_REMOVED) n++;
  }
  if (!c) { c = {}; seamCounts.set(order, c); }
  c[key] = n;
  return n;
}

export function renderOrder(srcRGBA, w, h, order, axis, k, out) {
  const n = w * h;
  if (srcRGBA.length !== n * 4) throw new RangeError(`srcRGBA has ${srcRGBA.length} bytes, want ${n * 4}`);
  if (order.length !== n) throw new RangeError(`order has ${order.length} entries, want ${n}`);
  const isY = axis === 'y';
  const seams = orderSeams(order, w, h, isY ? 'y' : 'x');
  k = Math.trunc(k) || 0;
  if (k > seams) k = seams;
  if (k < -seams) k = -seams;

  const src = u32View(srcRGBA, n);
  const ow = isY ? w : w - k;
  const oh = isY ? h - k : h;
  const img = makeImageData(ow, oh, out);
  const dst = new Uint32Array(img.data.buffer, img.data.byteOffset, ow * oh);

  if (k === 0) {
    dst.set(src);
    return img;
  }

  if (!isY) {
    let o = 0;
    if (k > 0) {
      for (let i = 0; i < n; i++) {
        if (order[i] >= k) dst[o++] = src[i];
      }
    } else {
      const m = -k;
      for (let i = 0; i < n; i++) {
        const p = src[i];
        dst[o++] = p;
        if (order[i] < m) dst[o++] = p;
      }
    }
    return img;
  }

  // Axis y: walk the source row by row; each column has its own output row cursor,
  // stored as an output index (row * w + x) that advances by w.
  const cur = new Int32Array(w);
  for (let x = 0; x < w; x++) cur[x] = x;
  if (k > 0) {
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        if (order[i] >= k) {
          dst[cur[x]] = src[i];
          cur[x] += w;
        }
      }
    }
  } else {
    const m = -k;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const p = src[i];
        let c = cur[x];
        dst[c] = p;
        c += w;
        if (order[i] < m) {
          dst[c] = p;
          c += w;
        }
        cur[x] = c;
      }
    }
  }
  return img;
}

export function renderNaive(srcRGBA, w, h, newW, newH, out) {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  if (srcRGBA.length !== w * h * 4) throw new RangeError(`srcRGBA has ${srcRGBA.length} bytes, want ${w * h * 4}`);
  const img = makeImageData(newW, newH, out);
  const d = img.data;
  const s = srcRGBA;

  // Pixel-centre mapping, clamped at the edges; weights in 8-bit fixed point.
  const sx = w / newW;
  const sy = h / newH;
  const x0 = new Int32Array(newW);
  const x1 = new Int32Array(newW);
  const fx = new Int32Array(newW);
  for (let x = 0; x < newW; x++) {
    let p = (x + 0.5) * sx - 0.5;
    if (p < 0) p = 0;
    if (p > w - 1) p = w - 1;
    const a = Math.floor(p);
    x0[x] = a * 4;
    x1[x] = Math.min(a + 1, w - 1) * 4;
    fx[x] = Math.round((p - a) * 256);
  }
  const stride = w * 4;
  let o = 0;
  for (let y = 0; y < newH; y++) {
    let p = (y + 0.5) * sy - 0.5;
    if (p < 0) p = 0;
    if (p > h - 1) p = h - 1;
    const b = Math.floor(p);
    const fy = Math.round((p - b) * 256);
    const gy = 256 - fy;
    const r0 = b * stride;
    const r1 = Math.min(b + 1, h - 1) * stride;
    for (let x = 0; x < newW; x++) {
      const f = fx[x];
      const g = 256 - f;
      const a0 = r0 + x0[x];
      const a1 = r0 + x1[x];
      const b0 = r1 + x0[x];
      const b1 = r1 + x1[x];
      // (top * gy + bottom * fy) with top/bottom = horizontal blends, all * 256 * 256.
      d[o] = ((s[a0] * g + s[a1] * f) * gy + (s[b0] * g + s[b1] * f) * fy + 32768) >> 16;
      d[o + 1] = ((s[a0 + 1] * g + s[a1 + 1] * f) * gy + (s[b0 + 1] * g + s[b1 + 1] * f) * fy + 32768) >> 16;
      d[o + 2] = ((s[a0 + 2] * g + s[a1 + 2] * f) * gy + (s[b0 + 2] * g + s[b1 + 2] * f) * fy + 32768) >> 16;
      d[o + 3] = ((s[a0 + 3] * g + s[a1 + 3] * f) * gy + (s[b0 + 3] * g + s[b1 + 3] * f) * fy + 32768) >> 16;
      o += 4;
    }
  }
  return img;
}
