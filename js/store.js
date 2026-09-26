// A tiny IndexedDB key/value store for manifests, so returning visitors don't
// re-download them. Every call fails soft: private windows, blocked storage and
// old browsers just behave as if nothing is cached.

const DB_NAME = "flipbook";
const STORE = "manifests";
let dbPromise = null;

function open() {
  if (!dbPromise) {
    // Tidy up the cache left by the app's old name (Book Scrubber).
    try {
      indexedDB.deleteDatabase("book-scrubber");
    } catch {}
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}

function run(mode, fn) {
  return open().then(
    (db) =>
      db &&
      new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      })
  );
}

export const cacheGet = (key) => run("readonly", (s) => s.get(key)).catch(() => undefined);
export const cacheSet = (key, value) => run("readwrite", (s) => s.put(value, key)).catch(() => undefined);
