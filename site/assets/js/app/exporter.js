// Encoding, file names, downloads, ZIP and Web Share.

import { getEngine } from '../engine.js';
import { buildZip } from '../zip.js';
import { baseName } from './util.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** The mime type to request for a photo under a format setting. */
export function wantedType(format, photoType) {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  // "Same as the photo": formats a browser can write; anything else becomes PNG.
  return EXT[photoType] ? photoType : 'image/png';
}

export function fileName(name, w, h, type) {
  return `${baseName(name)}-${w}x${h}.${EXT[type] || 'png'}`;
}

/** Encodes a result. Resolves { blob, name, fellBack } (fellBack: WebP unsupported). */
export async function encodeResult(photo, result, { format, quality }) {
  const type = wantedType(format, photo.type);
  const q = type === 'image/png' ? undefined : quality / 100;
  const blob = await getEngine().encode(result.img, { type, quality: q });
  const got = blob.type || type;
  return { blob, name: fileName(photo.name, result.w, result.h, got), fellBack: got !== type };
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function zipEntries(entries) {
  return buildZip(entries);
}

let shareSupport;
/** Web Share Level 2 with image files (phones, some desktops). */
export function canShareFiles() {
  if (shareSupport !== undefined) return shareSupport;
  shareSupport = false;
  try {
    if (navigator.canShare && navigator.share) {
      const f = new File([new Uint8Array([0])], 'test.jpg', { type: 'image/jpeg' });
      shareSupport = !!navigator.canShare({ files: [f] });
    }
  } catch { shareSupport = false; }
  return shareSupport;
}

export async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type, lastModified: Date.now() });
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) throw new Error('Sharing files is not supported here');
  await navigator.share({ files: [file], title: name });
}
