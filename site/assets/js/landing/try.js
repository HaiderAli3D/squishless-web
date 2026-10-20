// "Try it with your photo": drop anywhere on the page, paste, or choose a file. The files
// are handed to the app through IndexedDB (handoff.js); nothing leaves the device.
import { stashFiles } from '../handoff.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
const isImage = (f) => (f.type ? f.type.startsWith('image/') : IMAGE_EXT.test(f.name || ''));

let warmed = false;
/** Start loading the engine early (only after the visitor shows interest). */
function warmEngine() {
  if (warmed) return;
  warmed = true;
  import('../engine.js')
    .then((m) => m.getEngine())
    .catch(() => { /* the app loads it again anyway */ });
}

export function initTry({ zone, input, pickers, status }) {
  let busy = false;

  function say(msg, tone) {
    status.textContent = msg;
    status.dataset.tone = tone || '';
  }

  async function handOff(fileList) {
    if (busy) return;
    const all = Array.from(fileList || []);
    const files = all.filter(isImage);
    if (!files.length) {
      if (all.length) say('That doesn’t look like a photo. Try a JPG, PNG, WebP or HEIC file.', 'warning');
      return;
    }
    busy = true;
    zone.classList.add('is-busy');
    pickers.forEach((b) => b.setAttribute('aria-busy', 'true'));
    say(files.length === 1 ? 'Opening your photo in the app…' : `Opening ${files.length} photos in the app…`);
    if (await stashFiles(files)) {
      location.href = '/app?from=home';
      return;
    }
    // IndexedDB is unavailable (some private modes): open the app and say what to do.
    say('Your browser wouldn’t let us pass the photo along, so the app opens empty. Drop it in again there.', 'warning');
    setTimeout(() => { location.href = '/app'; }, 2600);
  }

  // file picker
  pickers.forEach((b) => {
    b.addEventListener('click', () => {
      warmEngine();
      input.click();
    });
    b.addEventListener('pointerenter', warmEngine, { once: true });
    b.addEventListener('focus', warmEngine, { once: true });
  });
  input.addEventListener('change', () => {
    if (input.files && input.files.length) handOff(input.files);
    input.value = '';
  });
  zone.addEventListener('pointerenter', warmEngine, { once: true });

  // drag and drop: anywhere on the page, the zone lights up
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    warmEngine();
    zone.classList.add('is-dragover');
    document.documentElement.classList.add('is-dragging-file');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) {
      zone.classList.remove('is-dragover');
      document.documentElement.classList.remove('is-dragging-file');
    }
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('is-dragover');
    document.documentElement.classList.remove('is-dragging-file');
    handOff(e.dataTransfer.files);
  });

  // paste an image from the clipboard
  document.addEventListener('paste', (e) => {
    const files = e.clipboardData ? Array.from(e.clipboardData.files || []) : [];
    if (!files.some(isImage)) return;
    e.preventDefault();
    handOff(files);
  });

  return { handOff };
}
