// Hands files from the landing page to the app across a navigation, via IndexedDB.
//
//   landing: if (await stashFiles(files)) location.href = '/app?from=home';
//   app:     const files = await takeFiles();   // File[] (cleared afterwards) or []
//
// Everything stays on the device. When IndexedDB is unavailable (some private modes,
// blocked storage) stashFiles resolves false and takeFiles resolves [], so the caller can
// fall back (e.g. open the app empty and ask for the files again). Neither ever rejects.
//
// A hand-off that is never taken (navigation stopped, tab closed, /app opened directly)
// must not keep the photo: every page that imports this module without ?from=home in its
// URL deletes a stashed entry once it is STALE_MS old (clearStale), without reading it.

const DB_NAME = 'squishless-handoff';
const STORE = 'files';
const KEY = 'pending';
/** Small record next to KEY ({ savedAt }), so stale checks never load the photo bytes. */
const META_KEY = 'pending-meta';
const OPEN_TIMEOUT_MS = 3000;
/** Stashed files older than this are ignored (a forgotten hand-off should not reappear). */
const MAX_AGE_MS = 60 * 60 * 1000;
/**
 * Pages opened without ?from=home delete a stash older than this. Long enough for the
 * landing page's own navigation to /app?from=home, short enough that nothing lingers.
 */
const STALE_MS = 15 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    let idb;
    try {
      idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
    } catch {
      idb = null;
    }
    if (!idb) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('IndexedDB did not open in time'));
      }
    }, OPEN_TIMEOUT_MS);
    let req;
    try {
      req = idb.open(DB_NAME, 1);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      if (done) {
        req.result.close();
        return;
      }
      done = true;
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(req.error || new Error('IndexedDB open failed'));
      }
    };
    req.onblocked = () => { /* another tab holds an old version; onsuccess follows */ };
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Stores files (File or Blob objects) for the next page. Replaces anything stashed before.
 * Resolves true when stored, false when IndexedDB is unavailable or failed.
 */
export async function stashFiles(files) {
  const list = Array.from(files || []).filter((f) => typeof Blob !== 'undefined' && f instanceof Blob);
  let db;
  try {
    // Store plain bytes, not the File/Blob: some WebKit builds cannot put Blobs into
    // IndexedDB at all, while an ArrayBuffer works everywhere.
    const items = [];
    for (const f of list) {
      const bytes = await f.arrayBuffer();
      items.push({
        name: f.name || 'image',
        type: f.type || '',
        lastModified: typeof f.lastModified === 'number' ? f.lastModified : Date.now(),
        bytes,
      });
    }
    db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const done = txDone(tx);
    const savedAt = Date.now();
    const store = tx.objectStore(STORE);
    store.put({ savedAt, items }, KEY);
    store.put({ savedAt }, META_KEY);
    await done;
    return true;
  } catch {
    return false;
  } finally {
    if (db) db.close();
  }
}

/** Returns the stashed files as File objects and clears them; [] if none or unavailable. */
export async function takeFiles() {
  let db;
  try {
    db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const done = txDone(tx);
    const store = tx.objectStore(STORE);
    const record = await request(store.get(KEY));
    store.delete(KEY);
    store.delete(META_KEY);
    await done;
    if (!record || !Array.isArray(record.items)) return [];
    if (typeof record.savedAt === 'number' && Date.now() - record.savedAt > MAX_AGE_MS) return [];
    const files = [];
    for (const it of record.items) {
      if (!it || !(it.bytes instanceof ArrayBuffer)) continue;
      const bytes = it.bytes;
      const opts = { type: it.type || '', lastModified: it.lastModified || Date.now() };
      let file;
      try {
        file = new File([bytes], it.name || 'image', opts);
      } catch {
        file = new Blob([bytes], { type: opts.type });
        file.name = it.name || 'image';
      }
      files.push(file);
    }
    return files;
  } catch {
    return [];
  } finally {
    if (db) db.close();
  }
}

/** True when the hand-off database may exist (skips creating it just to clean it). */
async function mayHaveDb() {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return false;
    if (typeof indexedDB.databases !== 'function') return true;
    const list = await indexedDB.databases();
    return list.some((d) => d && d.name === DB_NAME);
  } catch {
    return true;
  }
}

/**
 * Deletes stashed files saved more than maxAgeMs ago (0 = any), without reading them.
 * Resolves the age in ms of a younger entry that was kept, or -1 when none is left.
 * Never rejects.
 */
export async function clearStale(maxAgeMs = 0) {
  let db;
  try {
    if (!(await mayHaveDb())) return -1;
    db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const done = txDone(tx);
    const store = tx.objectStore(STORE);
    const [meta, count] = await Promise.all([request(store.get(META_KEY)), request(store.count(KEY))]);
    let kept = -1;
    if (count || meta) {
      const age = meta && typeof meta.savedAt === 'number' ? Date.now() - meta.savedAt : Infinity;
      if (age >= maxAgeMs || age < 0 || !count) {
        store.delete(KEY);
        store.delete(META_KEY);
      } else {
        kept = age;
      }
    }
    await done;
    return kept;
  } catch {
    return -1;
  } finally {
    if (db) db.close();
  }
}

// Clean-up on every page that is not taking a hand-off (see the header comment). If a
// fresh entry is found (another tab is handing off right now), look again once it is stale.
function autoClear() {
  clearStale(STALE_MS).then((age) => {
    if (age >= 0) setTimeout(autoClear, Math.max(1000, STALE_MS - age + 500));
  });
}
try {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('from') !== 'home') {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(autoClear, { timeout: 3000 });
    else setTimeout(autoClear, 1000);
  }
} catch {
  /* no location or storage: nothing to clean */
}
