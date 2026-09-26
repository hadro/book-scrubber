import {
  resolveInput,
  inputHint,
  itemPageFromUrl,
  isCollection,
  collectionMembers,
  followToManifest,
  fetchFirstManifest,
  parseManifest,
  pageImageUrl,
  sampleIndices,
  bisectionOrder,
  SMALL,
  BIG,
} from "./iiif.js";
import { EXAMPLES, SOURCES, guessSource } from "./examples.js";
import { loadFrames, encodeGif, encodeVideo, contactSheet, videoMime, corsError } from "./export.js";
import { cacheGet, cacheSet } from "./store.js";
import { initAnalytics, track } from "./analytics.js";
import { analyzeImage } from "./analyze.js";

const STAGE_MAX_FRAMES = 150;
const REEL_MAX = 150; // most frames a shelf card will hold (or one per pixel of card width, if wider)
const OVERVIEW_FRAMES = 24; // matches the default shelf density, so URLs are shared
const PER_HOST = 3; // simultaneous image requests per server
const HOVER_INTENT_MS = 150; // ignore mouse fly-bys shorter than this
const KEEP_LOADING_MS = 600; // after a hover this long, finish loading the card even once the mouse leaves
const MIN_PLATES = 3; // plates-only needs at least this many plates on a card, else it shows all non-blank pages
const DWELL_MS = 200; // only fetch big images once scrubbing pauses
const STORAGE_KEY = "flipbook:shelf";
const LEGACY_STORAGE_KEY = "book-scrubber:shelf"; // before the rename to Flipbook
const MANIFEST_TTL_MS = 7 * 24 * 3600 * 1000; // re-check remembered manifests weekly

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// ---------------------------------------------------------------------------
// Image loading: per-host queues, shared cache, cancellable while queued
// ---------------------------------------------------------------------------

const loadedUrls = new Set(); // decoded and in the browser cache
const pageStats = new Map(); // url -> { kind: "blank" | "text" | "plate", ... } when readable
const inflight = new Map(); // url -> job (queued or loading)
const hosts = new Map(); // host -> per-server state, see hostState()

const hostOf = (url) => {
  try {
    return new URL(url, location.href).host;
  } catch {
    return "";
  }
};

/**
 * Per-server bookkeeping:
 *  - cors: undefined until we know; true if the server sends CORS headers
 *    (then images load in CORS mode, which the service worker can cache
 *    efficiently and the GIF maker can reuse); false if it doesn't.
 *  - latency: moving average of load times, used to lower concurrency for
 *    slow servers.
 *  - failures / pausedUntil: back off after repeated errors.
 */
function hostState(host) {
  let h = hosts.get(host);
  if (!h) {
    h = { active: 0, waiting: [], cors: host === location.host ? false : undefined, latency: 0, failures: 0, pausedUntil: 0, timer: null };
    hosts.set(host, h);
  }
  return h;
}

/** The crossorigin attribute to use for an image URL, matching how the loader fetched it. */
function corsAttr(url) {
  const h = hosts.get(hostOf(url));
  return h && h.cors ? "anonymous" : null;
}

/** Set an <img>'s src without mismatching the cached copy's CORS mode. */
function setImg(img, url) {
  if (img.getAttribute("src") === url) return;
  const mode = corsAttr(url);
  if (img.crossOrigin !== mode) img.crossOrigin = mode;
  img.src = url;
}

function concurrencyFor(h) {
  if (h.latency > 2500) return 1;
  if (h.latency > 1000) return 2;
  return PER_HOST;
}

function fetchImage(url, cors) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function pump(h) {
  if (document.hidden) return; // resumes on visibilitychange
  const now = Date.now();
  if (h.pausedUntil > now) {
    if (!h.timer) h.timer = setTimeout(() => ((h.timer = null), pump(h)), h.pausedUntil - now);
    return;
  }
  while (h.active < concurrencyFor(h) && h.waiting.length) {
    const job = h.waiting.shift();
    job.started = true;
    h.active++;
    const t0 = performance.now();
    const tryCors = h.cors !== false;
    fetchImage(job.url, tryCors)
      .then((img) => {
        if (tryCors) h.cors = true;
        return img;
      })
      .catch(async (err) => {
        // Unknown server and the CORS attempt failed: maybe it just doesn't
        // send CORS headers. One plain retry settles it for this server
        // (unless it's already failing, when the retry would just add load).
        if (tryCors && h.cors === undefined && h.failures === 0) {
          await fetchImage(job.url, false);
          h.cors = false;
          return null; // loaded, but its pixels can't be read
        }
        throw err;
      })
      .then(
        (img) => {
          // Classify the page (blank / text / plate) when we're allowed to read it.
          if (img && (h.cors === true || job.host === location.host)) {
            const stats = analyzeImage(img);
            if (stats) pageStats.set(job.url, stats);
          }
          h.failures = 0;
          const ms = performance.now() - t0;
          h.latency = h.latency ? h.latency * 0.7 + ms * 0.3 : ms;
          loadedUrls.add(job.url);
          job.resolve(job.url);
        },
        () => {
          // Three failures in a row: pause this server, doubling up to a minute.
          h.failures++;
          if (h.failures >= 3) h.pausedUntil = Date.now() + Math.min(60000, 2000 * 2 ** (h.failures - 3));
          job.reject(new Error("image failed"));
        }
      )
      .finally(() => {
        h.active--;
        inflight.delete(job.url);
        pump(h);
      });
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) hosts.forEach(pump);
  else stopPlay(); // don't flip pages nobody is watching
});

function cancelJob(job) {
  const h = hostState(job.host);
  const i = h.waiting.indexOf(job);
  if (i >= 0) h.waiting.splice(i, 1);
  inflight.delete(job.url);
  job.reject(new DOMException("Cancelled", "AbortError"));
}

/**
 * A job stays queued while anyone still wants it. Callers without a signal pin
 * it; callers with a signal release their claim when the signal aborts. Once
 * nobody wants it (and it hasn't started), it's dropped before hitting the server.
 */
function claim(job, signal) {
  if (!signal) {
    job.pinned = true;
    return;
  }
  job.owners++;
  signal.addEventListener(
    "abort",
    () => {
      job.owners--;
      if (!job.started && !job.pinned && job.owners <= 0) cancelJob(job);
    },
    { once: true }
  );
}

/** Load an image. Resolves with its URL once decoded. */
function loadImage(url, { front = false, signal } = {}) {
  if (loadedUrls.has(url)) return Promise.resolve(url);
  if (signal && signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  let job = inflight.get(url);
  if (!job) {
    job = { url, host: hostOf(url), owners: 0, pinned: false, started: false };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.promise.catch(() => {});
    inflight.set(url, job);
    const h = hostState(job.host);
    h.waiting[front ? "unshift" : "push"](job);
    claim(job, signal);
    pump(h);
  } else {
    claim(job, signal);
    if (front && !job.started) {
      const h = hostState(job.host);
      const i = h.waiting.indexOf(job);
      if (i > 0) h.waiting.unshift(...h.waiting.splice(i, 1));
    }
  }
  return job.promise;
}

const manifestSlots = (() => {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= 3 || !queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
})();

/**
 * Fetch a manifest, remembering it in IndexedDB. A remembered copy is used
 * as-is for a week; after that we re-fetch, but fall back to the old copy if
 * the server is unreachable.
 */
const manifestMemo = new Map(); // this page view: key -> promise

function loadManifest(candidates) {
  const key = candidates.join(" ");
  if (!manifestMemo.has(key)) {
    const p = loadManifestUncached(candidates, key);
    manifestMemo.set(key, p);
    p.catch(() => manifestMemo.delete(key));
  }
  return manifestMemo.get(key);
}

async function loadManifestUncached(candidates, key) {
  const cached = await cacheGet(key);
  if (cached && Date.now() - cached.at < MANIFEST_TTL_MS) return cached;
  try {
    const fresh = await fetchFirstManifest(candidates);
    cacheSet(key, { ...fresh, at: Date.now() });
    return fresh;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return "Couldn't reach the server. It may be down, or it may not allow requests from other websites (CORS).";
  }
  if (/HTTP 404/.test(msg)) return "No manifest at that address (404).";
  if (/HTTP \d+/.test(msg)) return `The server said no (${msg.match(/HTTP \d+/)[0]}).`;
  if (/JSON/i.test(msg)) return "That address didn't return IIIF JSON.";
  return msg.split("\n")[0];
}

function readShelf() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}
function writeShelf(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {}
}

const slug = (s) =>
  (s || "book")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "book";

// ---------------------------------------------------------------------------
// Book: an input string, its lazily-loaded manifest, and any pre-baked frames
// ---------------------------------------------------------------------------

let BAKED = {};

class Book {
  constructor({ input, title, note, source, page, removable = false }) {
    this.input = input;
    this.page = page || null;
    this.title = title || "";
    this.note = note || "";
    this.source = source || guessSource(resolveInput(input)[0] || "");
    this.removable = removable;
    this.data = null;
    this.baked = BAKED[input] || null;
    this.manifestUrl = (this.baked && this.baked.manifestUrl) || resolveInput(input)[0] || input;
    if (!this.title && this.baked) this.title = this.baked.label;
  }

  get total() {
    return this.data ? this.data.pages.length : this.baked ? this.baked.total : 0;
  }
  /** The item's web page at its institution: set explicitly, named in the manifest, or derived from the URL. */
  get itemPage() {
    return (
      this.page ||
      (this.data && this.data.homepage) ||
      (this.baked && this.baked.homepage) ||
      itemPageFromUrl(this.input) ||
      itemPageFromUrl(this.manifestUrl)
    );
  }

  get rtl() {
    return this.data ? this.data.rtl : !!(this.baked && this.baked.rtl);
  }

  load() {
    if (!this._loading) {
      this._loading = manifestSlots(async () => {
        const candidates = resolveInput(this.input);
        if (!candidates.length) throw new Error(inputHint(this.input) || "That doesn't look like a URL or an identifier.");
        // Multi-part records can resolve to a collection: take its first part.
        const { url, json, part } = await followToManifest(await loadManifest(candidates), (u) => loadManifest([u]));
        this.manifestUrl = url;
        this.data = parseManifest(json);
        this.part = part;
        if (!this.title) this.title = (part && part.collection) || this.data.label;
        return this.data;
      });
      this._loading.catch(() => {});
    }
    return this._loading;
  }

  /**
   * The frames a shelf card scrubs through. Each frame lists every URL that
   * shows that page (baked file, 300px, 800px); whichever is already loaded
   * gets used. `fetch` marks the sampled frames the card may download itself.
   * Pages already loaded elsewhere (usually by the viewer) are added as extra
   * frames for free. At most `max` frames in all: if more pages are loaded
   * than that, the extras are picked evenly across the whole book.
   */
  reel(density, max = REEL_MAX) {
    const live = this.data && this.data.pages;
    const liveUrls = (p) => (live ? [pageImageUrl(live[p], SMALL), pageImageUrl(live[p], BIG)] : []);
    const frames = new Map(); // page -> { cands, fetch }
    if (this.baked) this.baked.pages.forEach((p, k) => frames.set(p, { cands: [this.baked.files[k], ...liveUrls(p)], fetch: true }));
    else for (const p of sampleIndices(live.length, density)) frames.set(p, { cands: liveUrls(p), fetch: true });
    if (live) {
      const extras = [];
      for (let p = 0; p < live.length; p++) {
        if (frames.has(p)) continue;
        const cands = liveUrls(p);
        if (cands.some((u) => loadedUrls.has(u))) extras.push([p, cands]);
      }
      const room = Math.max(0, max - frames.size);
      const keep = extras.length > room ? sampleIndices(extras.length, room).map((k) => extras[k]) : extras;
      for (const [p, cands] of keep) frames.set(p, { cands, fetch: false });
    }
    const pages = [...frames.keys()].sort((a, b) => a - b);
    return {
      pages,
      cands: pages.map((p) => frames.get(p).cands),
      fetch: new Set(pages.flatMap((p, i) => (frames.get(p).fetch ? [i] : []))),
      baked: !!this.baked,
    };
  }
}

// ---------------------------------------------------------------------------
// Shelf cards
// ---------------------------------------------------------------------------

const shelfEl = $("#shelf");
const cards = new Set();
// Visitors whose browser asks to save data get the lightest scrub by default.
if (navigator.connection && navigator.connection.saveData) $("#density").value = "12";
let density = Number($("#density").value);
let flashTimer = null;
// Plates-only and flash mode always start off: they're per-visit toggles, not settings.
let platesOnly = false;

const visibility = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const card = entry.target.__card;
      card.visible = entry.isIntersecting;
      if (entry.isIntersecting) card.init();
    }
  },
  { rootMargin: "300px" }
);

class Card {
  constructor(book) {
    this.book = book;
    this.visible = false;
    this.reel = null;
    this.loaded = new Set();
    this.current = 0;
    this.ctl = null;
    this.failed = false;

    const el = $("#card-template").content.firstElementChild.cloneNode(true);
    el.__card = this;
    this.el = el;
    this.cover = $(".card-cover", el);
    this.img = $(".card-img", el);
    this.counter = $(".counter", el);
    this.ticks = $(".ticks", el);
    this.errorEl = $(".card-error", el);

    const src = SOURCES[book.source] || SOURCES.mine;
    el.style.setProperty("--sticker", src.color);
    $(".sticker", el).textContent = src.short;
    $(".sticker", el).title = src.name;
    this.setCaption();

    if (book.removable) {
      const rm = $(".card-remove", el);
      rm.hidden = false;
      rm.addEventListener("click", () => removeCard(this));
    }

    this.bindPointer();
  }

  setCaption() {
    $(".card-title", this.el).textContent = this.book.title || "Loading…";
    const n = this.book.total;
    const pages = n ? `${n} ${n === 1 ? "image" : "pages"}` : "";
    const p = this.book.part;
    const part = p && p.of > 1 ? `${p.label || "part 1"} (1 of ${p.of})` : "";
    $(".card-note", this.el).textContent = [this.book.note, part, pages].filter(Boolean).join(" · ");
    this.cover.setAttribute("aria-label", `${this.book.title || "Book"}: open book`);
    const page = $(".card-link-page", this.el);
    page.hidden = !this.book.itemPage;
    if (!page.hidden) page.href = this.book.itemPage;
    $(".card-link-iiif", this.el).href = this.book.manifestUrl;
    const where = (SOURCES[this.book.source] || {}).name;
    page.title = where && this.book.source !== "mine" ? `View at ${where}` : "View the item's page";
  }

  init() {
    if (!this._init) {
      this._init = (async () => {
        if (!this.book.baked) {
          try {
            await this.book.load();
          } catch (err) {
            this.showError(err);
            throw err;
          }
        }
        this.setCaption();
        this.buildFrames();
        if (flashTimer) this.preload();
      })();
      this._init.catch(() => {});
    }
    return this._init;
  }

  /** A URL for frame i that's already loaded, if any. */
  loadedUrl(i) {
    return this.reel.cands[i].find((u) => loadedUrls.has(u));
  }

  buildFrames() {
    this.stopPreload(true);
    // One frame per pixel of card width at most, so every frame can be reached by the mouse.
    const width = Math.round(this.cover.getBoundingClientRect().width) || 0;
    this.reel = this.book.reel(density, Math.max(REEL_MAX, width));
    this.loaded = new Set();
    this.ticks.replaceChildren(...this.reel.pages.map(() => document.createElement("i")));
    // Anything already loaded (by the viewer, an earlier reel, the baked shelf) counts straight away.
    this.reel.pages.forEach((_, i) => this.loadedUrl(i) && this.loaded.add(i));
    [...this.loaded].forEach((i) => this.ticks.children[i].classList.add("is-loaded"));
    this.refreshTicks();

    const cover = this.loadedUrl(0) || this.reel.cands[0][0];
    loadImage(cover, { front: true })
      .then(() => {
        this.markLoaded(0);
        this.show(0, true);
        this.img.classList.add("is-ready");
        this.cover.classList.add("is-loaded-cover");
      })
      .catch(() => this.showError(new Error("The first page image wouldn't load.")));
  }

  /** Fetch the rest of the reel, coarse-first. Cancelled (if still queued) by stopPreload. */
  preload() {
    if (this.ctl || !this.reel) return;
    this.ctl = new AbortController();
    const { signal } = this.ctl;
    const reel = this.reel;
    for (const i of bisectionOrder(reel.pages.length)) {
      if (this.loaded.has(i)) continue;
      if (this.loadedUrl(i)) {
        this.markLoaded(i);
        continue;
      }
      if (!reel.fetch.has(i)) continue; // extra frames are never fetched just for the card
      loadImage(reel.cands[i][0], { signal })
        .then(() => {
          if (this.reel !== reel) return;
          this.markLoaded(i);
          if (this.wanted === i) this.show(i);
        })
        .catch(() => {});
    }
  }

  stopPreload(force = false) {
    if (flashTimer && !force) return; // flash mode keeps cards loading
    if (this.ctl) this.ctl.abort();
    this.ctl = null;
  }

  markLoaded(i) {
    this.loaded.add(i);
    const tick = this.ticks.children[i];
    if (tick) tick.classList.add("is-loaded");
    this.refreshTicks();
  }

  kindOf(i) {
    const st = pageStats.get(this.loadedUrl(i) || this.reel.cands[i][0]);
    return st && st.kind;
  }

  /** Frames that may be shown now: never blanks; in plates-only mode just plates (if any). */
  eligible() {
    const nonBlank = [...this.loaded].filter((i) => this.kindOf(i) !== "blank");
    if (platesOnly) {
      const plates = nonBlank.filter((i) => this.kindOf(i) === "plate");
      // A book with hardly any detected plates would leave an empty-looking card.
      if (plates.length >= MIN_PLATES) return new Set(plates);
    }
    return new Set(nonBlank.length ? nonBlank : this.loaded);
  }

  /** Whether plates-only filtering is actually narrowing this card right now. */
  platesActive() {
    return platesOnly && [...this.loaded].filter((i) => this.kindOf(i) === "plate").length >= MIN_PLATES;
  }

  refreshTicks() {
    if (!this.reel) return;
    const ok = this.eligible();
    [...this.ticks.children].forEach((t, i) => t.classList.toggle("is-skipped", this.loaded.has(i) && !ok.has(i)));
  }

  nearestIn(set, i) {
    const n = this.reel.pages.length;
    for (let d = 0; d < n; d++) {
      if (set.has(i - d)) return i - d;
      if (set.has(i + d)) return i + d;
    }
    return -1;
  }

  /** Show frame i, or the nearest frame we're allowed to show. `any` allows blanks (the cover). */
  show(i, any = false) {
    const j = this.nearestIn(any ? this.loaded : this.eligible(), i);
    if (j < 0) return;
    const prev = this.ticks.children[this.current];
    if (prev) prev.classList.remove("is-current");
    this.current = j;
    setImg(this.img, this.loadedUrl(j) || this.reel.cands[j][0]);
    const tick = this.ticks.children[j];
    if (tick) tick.classList.add("is-current");
    this.counter.textContent = `p. ${this.reel.pages[j] + 1} / ${this.book.total}${this.platesActive() ? " · plates" : ""}`;
  }

  /** Scrub to a 0..1 position across the card. */
  scrubTo(f) {
    if (!this.reel) return;
    if (this.book.rtl) f = 1 - f;
    const n = this.reel.pages.length;
    const i = Math.min(n - 1, Math.max(0, Math.floor(f * n)));
    this.wanted = i;
    this.show(i);
  }

  reset() {
    this.wanted = null;
    this.cover.classList.remove("is-scrubbing");
    if (this.reel && !flashTimer) this.show(0, true);
  }

  bindPointer() {
    const c = this.cover;
    let startX = null;
    let moved = false;
    let intent = null;
    const cancelIntent = () => {
      clearTimeout(intent);
      intent = null;
    };

    let enteredAt = 0;
    c.addEventListener("pointerenter", (e) => {
      cancelIntent();
      enteredAt = performance.now();
      // A mouse just passing over shouldn't trigger two dozen downloads.
      const delay = e.pointerType === "mouse" ? HOVER_INTENT_MS : 0;
      intent = setTimeout(() => this.init().then(() => this.preload(), () => {}), delay);
    });
    c.addEventListener("pointerdown", (e) => {
      startX = e.clientX;
      moved = false;
    });
    c.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse" && startX === null) return;
      if (startX !== null && Math.abs(e.clientX - startX) > 8) moved = true;
      const r = c.getBoundingClientRect();
      c.classList.add("is-scrubbing");
      this.scrubTo((e.clientX - r.left) / r.width);
    });
    const leave = () => {
      startX = null;
      cancelIntent();
      // A deliberate look: let the card's reel finish in the background (still
      // at most 3 requests at a time per server). A quick pass: drop what's queued.
      if (performance.now() - enteredAt < KEEP_LOADING_MS) this.stopPreload();
      this.reset();
    };
    c.addEventListener("pointerup", () => (startX = null));
    c.addEventListener("pointercancel", leave);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("click", (e) => {
      if (moved && e.pointerType !== "mouse") {
        moved = false;
        return;
      }
      if (!this.failed) openViewer(this.book);
    });
    c.addEventListener("keydown", (e) => {
      if (!this.reel) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        this.preload();
        const step = (e.key === "ArrowRight") !== this.book.rtl ? 1 : -1;
        const next = Math.min(this.reel.pages.length - 1, Math.max(0, (this.wanted ?? this.current) + step));
        this.wanted = next;
        this.show(next);
      }
    });
    c.addEventListener("blur", () => {
      this.stopPreload();
      this.reset();
    });
  }

  showError(err) {
    this.failed = true;
    this.errorEl.hidden = false;
    this.errorEl.replaceChildren();
    const big = document.createElement("span");
    big.className = "big";
    big.textContent = "?!";
    const msg = document.createElement("span");
    msg.textContent = "This one wandered off the shelf";
    const detail = document.createElement("small");
    detail.textContent = friendlyError(err);
    this.errorEl.append(big, msg, detail);
    this.errorEl.title = String((err && err.message) || err);
    this.cover.classList.add("is-loaded-cover");
    this.cover.style.cursor = "help";
    if (!this.book.title) $(".card-title", this.el).textContent = this.book.note || this.book.input;
  }

  // Flash mode: advance to the next page we already have.
  flashStep() {
    if (document.hidden || !this.visible || !this.reel || this.cover.classList.contains("is-scrubbing")) return;
    this.preload();
    const ok = this.eligible();
    if (ok.size < 2) return;
    this.cover.classList.add("is-flashing");
    let next = this.current;
    for (let k = 0; k < this.reel.pages.length; k++) {
      next = (next + 1) % this.reel.pages.length;
      if (ok.has(next)) break;
    }
    this.show(next);
  }
}

function addCard(book, { prepend = false, animate = false } = {}) {
  const card = new Card(book);
  cards.add(card);
  if (animate) card.el.classList.add("is-new");
  if (prepend) shelfEl.prepend(card.el);
  else shelfEl.append(card.el);
  visibility.observe(card.el);
  return card;
}

function removeCard(card) {
  card.stopPreload(true);
  cards.delete(card);
  visibility.unobserve(card.el);
  card.el.remove();
  writeShelf(readShelf().filter((x) => x !== card.book.input));
}

// ---------------------------------------------------------------------------
// Shelf controls
// ---------------------------------------------------------------------------

$("#density").addEventListener("change", (e) => {
  density = Number(e.target.value);
  for (const card of cards) {
    if (card.reel) {
      card.buildFrames();
      if (flashTimer) card.preload();
    }
  }
});

// Browsers restore checkbox states on reload; reset them to match.
$("#plates-toggle").checked = false;
$("#flash-toggle").checked = false;
$("#plates-toggle").addEventListener("change", (e) => {
  platesOnly = e.target.checked;
  cards.forEach((c) => c.refreshTicks());
  if (platesOnly) track("plates-on", "Plates only on");
});

$("#flash-toggle").addEventListener("change", (e) => {
  if (e.target.checked) {
    // Slower flashing for people who've asked their OS for less motion.
    flashTimer = setInterval(() => cards.forEach((c) => c.flashStep()), reduceMotion.matches ? 2000 : 650);
    track("flash-on", "Flash mode on");
  } else {
    clearInterval(flashTimer);
    flashTimer = null;
    cards.forEach((c) => {
      c.stopPreload(true);
      c.cover.classList.remove("is-flashing");
      c.reset();
    });
  }
});

// ---------------------------------------------------------------------------
// Paste form
// ---------------------------------------------------------------------------

const pasteForm = $("#paste-form");
const pasteInput = $("#paste-input");
const pasteStatus = $("#paste-status");

function setStatus(text, isError = false) {
  pasteStatus.textContent = text;
  pasteStatus.classList.toggle("is-error", isError);
}

/** Anonymous label for analytics: example title, or just the host for pasted books. */
function bookTag(book) {
  if (!book.removable) return `example/${slug(book.title || book.note)}`;
  return `pasted/${hostOf(book.manifestUrl) || "unknown"}`;
}

const SHELF_MAX = 100;
const COLLECTION_MAX = 36;

async function shelveInput(input, { open = false, page = null } = {}) {
  input = input.trim();
  if (!input) return null;
  const existing = [...cards].find((c) => c.book.input === input);
  if (existing) {
    existing.el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (open) openViewer(existing.book, { page });
    return existing;
  }
  const candidates = resolveInput(input);
  if (!candidates.length) {
    setStatus(inputHint(input) || "Hmm, that doesn't look like a link or an identifier.", true);
    return null;
  }
  setStatus("Fetching the manifest…");
  let fetched;
  try {
    fetched = await loadManifest(candidates);
  } catch (err) {
    setStatus(`Couldn't shelve that one: ${friendlyError(err)} ${inputHint(input)}`.trim(), true);
    track(`paste/fail/${hostOf(candidates[0]) || "unknown"}`);
    return null;
  }
  if (isCollection(fetched.json)) return shelveCollection(fetched);

  const book = new Book({ input, removable: true });
  try {
    await book.load(); // served from the memo above
  } catch (err) {
    setStatus(`Couldn't shelve that one: ${friendlyError(err)} ${inputHint(input)}`.trim(), true);
    track(`paste/fail/${hostOf(candidates[0]) || "unknown"}`);
    return null;
  }
  const card = addCard(book, { prepend: true, animate: true });
  track(`paste/ok/${hostOf(book.manifestUrl) || "unknown"}`);
  writeShelf([input, ...readShelf().filter((x) => x !== input)].slice(0, SHELF_MAX));
  setStatus(`Shelved "${book.title}" (${book.data.pages.length} images). Hover it!`);
  card.el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (open) openViewer(book, { page });
  return card;
}

/** A IIIF Collection: shelve its first COLLECTION_MAX manifests as separate books. */
function shelveCollection({ url, json }) {
  const { label, manifests, subCollections } = collectionMembers(json);
  track(`paste/collection/${hostOf(url) || "unknown"}`);
  if (!manifests.length) {
    setStatus(
      subCollections
        ? `"${label}" only contains other collections (${subCollections}). Paste one of those instead.`
        : `"${label}" is an empty collection.`,
      true
    );
    return null;
  }
  const have = new Set([...cards].map((c) => c.book.input));
  const picked = manifests.slice(0, COLLECTION_MAX).filter((m) => !have.has(m.id));
  let first = null;
  for (const m of [...picked].reverse()) {
    first = addCard(new Book({ input: m.id, title: m.label, removable: true }), { prepend: true, animate: true });
  }
  writeShelf([...picked.map((m) => m.id), ...readShelf().filter((x) => !picked.some((m) => m.id === x))].slice(0, SHELF_MAX));
  const more = manifests.length > COLLECTION_MAX ? ` (the first ${COLLECTION_MAX} of ${manifests.length})` : "";
  setStatus(`Shelved ${picked.length} books from the collection "${label}"${more}. Hover away!`);
  if (first) first.el.scrollIntoView({ behavior: "smooth", block: "center" });
  return first;
}

// ---- Drag and drop: IIIF logos, viewer links, manifest URLs ----
{
  const overlay = $("#drop-overlay");
  let depth = 0;
  const isLink = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === "text/uri-list" || t === "text/plain");
  window.addEventListener("dragenter", (e) => {
    if (!isLink(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener("dragover", (e) => {
    if (isLink(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    depth = 0;
    overlay.hidden = true;
    if (!isLink(e)) return;
    e.preventDefault();
    const uris = (e.dataTransfer.getData("text/uri-list") || "").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
    const text = (uris[0] || e.dataTransfer.getData("text/plain") || "").trim();
    if (!text) return;
    track("drop");
    pasteInput.value = text;
    shelveInput(text).then((ok) => ok && (pasteInput.value = ""));
  });
}

pasteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("button[type=submit]", pasteForm);
  button.disabled = true;
  const ok = await shelveInput(pasteInput.value);
  button.disabled = false;
  if (ok) pasteInput.value = "";
});

// ---------------------------------------------------------------------------
// Viewer (big page view + exports)
// ---------------------------------------------------------------------------
//
// The viewer never bulk-downloads the book. It shows the best image it already
// has for a page (big > small > baked, or the nearest page that has one), and
// only asks the server for:
//   - small images near where you are scrubbing (queued requests are dropped
//     as soon as you move on), and
//   - a big image once you pause on a page.
// Closing the viewer drops everything still queued.

const viewer = $("#viewer");
const stageFrame = $(".stage-frame", viewer);
const stageImg = $("#stage-img");
const stageLoading = $("#stage-loading");
const stageCounter = $("#stage-counter");
const viewerMeta = $("#viewer-meta");
const range = $("#stage-range");
const playBtn = $("#play-btn");
const speed = $("#speed");
const speedOut = $("#speed-out");
const bounce = $("#bounce-toggle");
const gifBtn = $("#gif-btn");
const gifProgress = $("#gif-progress");
const gifError = $("#gif-error");
const gifResult = $("#gif-result");

const V = {
  book: null,
  frames: [], // page indices the slider steps through
  bakedMap: new Map(), // page index -> baked file
  live: false, // manifest loaded
  wanted: 0,
  gen: 0,
  playing: null,
  dir: 1,
  ctl: null, // lives as long as the viewer is open on this book
  scrubCtl: null, // replaced on every move
  dwell: null,
  gifAbort: null,
  gifUrl: null,
};

const smallUrl = (page) => pageImageUrl(V.book.data.pages[page], SMALL);
const bigUrl = (page) => pageImageUrl(V.book.data.pages[page], BIG);

function candidates(j) {
  const page = V.frames[j];
  const out = [];
  if (V.live) out.push(bigUrl(page), smallUrl(page));
  if (V.bakedMap.has(page)) out.push(V.bakedMap.get(page));
  return out;
}

function availableAt(j) {
  return candidates(j).find((u) => loadedUrls.has(u));
}

function nearestAvailable(i) {
  const n = V.frames.length;
  const isBlank = (url) => (pageStats.get(url) || {}).kind === "blank";
  // First look for the nearest non-blank page we have; blanks only as a last resort.
  for (const allowBlank of [false, true]) {
    for (let d = 0; d < n; d++) {
      for (const j of d ? [i - d, i + d] : [i]) {
        if (j < 0 || j >= n) continue;
        const url = availableAt(j);
        if (url && (allowBlank || !isBlank(url))) return { j, url };
      }
    }
  }
  return null;
}

function setFrames(pages, keepPage) {
  V.frames = pages;
  range.max = String(Math.max(0, pages.length - 1));
  let i = 0;
  if (keepPage != null) {
    i = pages.findIndex((p) => p >= keepPage);
    if (i < 0) i = pages.length - 1;
  }
  V.wanted = i;
}

/** "#m=<book>" plus "&p=<page>" (1-based) when a page is given. */
const shareHash = (book, page) => `#m=${encodeURIComponent(book.input)}${page != null ? `&p=${page + 1}` : ""}`;

async function openViewer(book, { page = null } = {}) {
  if (!viewer.open) V.opener = document.activeElement;
  V.startPage = page;
  track(`viewer/${bookTag(book)}`, `Opened: ${book.removable ? hostOf(book.manifestUrl) : book.title || book.note}`);
  V.gen++;
  const gen = V.gen;
  abortViewerRequests();
  V.ctl = new AbortController();
  V.book = book;
  V.live = false;
  V.dir = 1;
  V.bakedMap = new Map(book.baked ? book.baked.pages.map((p, k) => [p, book.baked.files[k]]) : []);

  const src = SOURCES[book.source] || SOURCES.mine;
  const sticker = $("#viewer-sticker");
  sticker.textContent = src.name;
  sticker.style.setProperty("--sticker", src.color);
  $("#viewer-title").textContent = book.title || "Loading…";
  $("#viewer-manifest").href = book.manifestUrl;
  viewerMeta.textContent = "Loading the manifest…";
  stageImg.removeAttribute("src");
  stageLoading.hidden = false;
  stageCounter.textContent = "–";
  resetGifUi();
  stopPlay();
  if (!viewer.open) viewer.showModal();
  history.replaceState(null, "", shareHash(book, page));
  const home = $("#viewer-home");
  home.hidden = !book.itemPage;
  if (!home.hidden) home.href = book.itemPage;

  // Show the baked preview straight away while the manifest loads.
  if (book.baked) {
    setFrames(book.baked.pages, page);
    for (const url of book.baked.files) {
      loadImage(url, { signal: V.ctl.signal })
        .then(() => V.gen === gen && viewerDisplay(V.wanted))
        .catch(() => {});
    }
  }

  try {
    await book.load();
  } catch (err) {
    if (V.gen !== gen) return;
    if (book.baked) {
      viewerMeta.textContent = `Showing the saved preview only; the full manifest wouldn't load. ${friendlyError(err)}`;
    } else {
      stageLoading.hidden = true;
      stageCounter.textContent = "?!";
      viewerMeta.textContent = friendlyError(err);
      gifBtn.disabled = true;
    }
    return;
  }
  if (V.gen !== gen) return;

  const d = book.data;
  V.live = true;
  $("#viewer-title").textContent = book.title;
  $("#viewer-manifest").href = book.manifestUrl;
  home.hidden = !book.itemPage;
  if (!home.hidden) home.href = book.itemPage;
  const overview = sampleIndices(d.pages.length, OVERVIEW_FRAMES);
  // A shared link's page wins, unless the visitor already moved.
  const start = V.startPage != null && V.startPage < d.pages.length ? V.startPage : null;
  const keepPage = start != null ? start : V.frames.length ? V.frames[V.wanted] : null;
  const pages = new Set([...sampleIndices(d.pages.length, STAGE_MAX_FRAMES), ...overview, ...V.bakedMap.keys()]);
  if (start != null) pages.add(start);
  setFrames([...pages].sort((a, b) => a - b), keepPage);
  const sampled = V.frames.length < d.pages.length ? ` · scrubbing ${V.frames.length} of them` : "";
  const part = book.part && book.part.of > 1 ? `Showing part 1 of ${book.part.of}${book.part.label ? ` (${book.part.label})` : ""}` : "";
  viewerMeta.textContent = [part, `${d.pages.length} images${sampled}`, d.attribution].filter(Boolean).join(" · ");

  // A coarse overview so the slider works end to end: the same small images the
  // shelf card uses (usually already cached), or nothing at all for baked books.
  if (!book.baked) {
    for (const k of bisectionOrder(overview.length)) {
      loadImage(smallUrl(overview[k]), { signal: V.ctl.signal })
        .then(() => V.gen === gen && viewerDisplay(V.wanted))
        .catch(() => {});
    }
  }
  viewerShow(V.wanted, false);
}

function abortViewerRequests() {
  clearTimeout(V.dwell);
  if (V.scrubCtl) V.scrubCtl.abort();
  if (V.ctl) V.ctl.abort();
  V.scrubCtl = V.ctl = null;
}

/** Paint the best image we already have for frame i. No network. */
function viewerDisplay(i) {
  range.value = String(i);
  const hit = nearestAvailable(i);
  if (!hit) return;
  stageLoading.hidden = true;
  setImg(stageImg, hit.url);
  const page = V.frames[hit.j];
  const p = V.live && V.book.data.pages[page];
  // Show printed page labels ("xii", "Plate 4") but not ones that just repeat the number.
  const label = p && p.label && !new RegExp(`^\\D{0,6}${page + 1}\\.?$`).test(p.label.trim()) ? ` · ${p.label}` : "";
  stageCounter.textContent = `p. ${page + 1} / ${V.book.total}${label}`;
  stageImg.alt = `${V.book.title}, image ${page + 1}`;
  range.setAttribute("aria-valuetext", `Page ${V.frames[i] + 1} of ${V.book.total}`);
}

/** Show frame i and ask for what's needed around it. */
function viewerShow(i, fromUser = true) {
  if (fromUser) V.startPage = null;
  V.wanted = i;
  viewerDisplay(i);
  if (!V.live) return;

  const gen = V.gen;
  if (V.scrubCtl) V.scrubCtl.abort();
  V.scrubCtl = new AbortController();
  const { signal } = V.scrubCtl;
  const n = V.frames.length;
  const refresh = () => V.gen === gen && viewerDisplay(V.wanted);
  const want = (j, size, front = false) => {
    if (j < 0 || j >= n) return;
    const page = V.frames[j];
    const url = size === BIG ? bigUrl(page) : smallUrl(page);
    if (size === SMALL && (V.bakedMap.has(page) || loadedUrls.has(bigUrl(page)))) return;
    loadImage(url, { signal, front }).then(refresh, () => {});
  };

  want(i, SMALL, true);
  // Look a little ahead: further while playing, one either side while scrubbing.
  if (V.playing) for (let k = 1; k <= 3; k++) want(i + V.dir * k, SMALL);
  else {
    want(i + 1, SMALL);
    want(i - 1, SMALL);
  }

  // Big images only once you pause on a page.
  clearTimeout(V.dwell);
  V.dwell = setTimeout(() => {
    if (V.gen !== gen || V.wanted !== i) return;
    history.replaceState(null, "", shareHash(V.book, V.frames[i]));
    want(i, BIG, true);
    if (!V.playing) want(i + V.dir, BIG);
  }, DWELL_MS);
}

function viewerStep(delta) {
  const n = V.frames.length;
  if (!n) return;
  let next = V.wanted + delta;
  if (bounce.checked) {
    if (next >= n || next < 0) {
      V.dir = -V.dir;
      next = V.wanted - delta;
    }
    next = Math.max(0, Math.min(n - 1, next));
  } else {
    next = (next + n) % n;
  }
  viewerShow(next);
}

function startPlay() {
  stopPlay();
  const fps = reduceMotion.matches ? Math.min(3, Number(speed.value)) : Number(speed.value);
  V.playing = setInterval(() => viewerStep(V.dir), 1000 / fps);
  playBtn.textContent = "❚❚ Pause";
}
function stopPlay() {
  if (V.playing) clearInterval(V.playing);
  V.playing = null;
  playBtn.textContent = "▶ Play";
}

playBtn.addEventListener("click", () => (V.playing ? stopPlay() : startPlay()));
speed.addEventListener("input", () => {
  speedOut.textContent = `${speed.value} fps`;
  if (V.playing) startPlay();
});
range.addEventListener("input", () => {
  stopPlay();
  viewerShow(Number(range.value));
});

{
  let dragging = false;
  stageFrame.addEventListener("pointerdown", () => (dragging = true));
  window.addEventListener("pointerup", () => (dragging = false));
  stageFrame.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" && !dragging) return;
    if (!V.frames.length) return;
    const r = stageFrame.getBoundingClientRect();
    let f = (e.clientX - r.left) / r.width;
    if (V.book.rtl) f = 1 - f;
    const i = Math.min(V.frames.length - 1, Math.max(0, Math.floor(f * V.frames.length)));
    if (i === V.wanted) return;
    stopPlay();
    viewerShow(i);
  });
}

viewer.addEventListener("keydown", (e) => {
  if (e.target.matches("input[type=text], select")) return;
  const rtl = V.book && V.book.rtl;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    if (e.target === range) return; // native range handles it
    e.preventDefault();
    stopPlay();
    viewerStep((e.key === "ArrowRight") !== rtl ? 1 : -1);
  } else if (e.key === " " && !e.target.matches("button, a")) {
    e.preventDefault();
    V.playing ? stopPlay() : startPlay();
  }
});

viewer.addEventListener("click", (e) => {
  if (e.target === viewer || e.target.closest("[data-close]")) viewer.close();
});

viewer.addEventListener("close", () => {
  // Pages the viewer loaded become extra (free) frames on this book's shelf card.
  for (const c of cards) {
    if (c.book === V.book && c.reel) {
      c.buildFrames();
      if (flashTimer) c.preload();
    }
  }
  V.gen++;
  stopPlay();
  abortViewerRequests();
  if (V.gifAbort) V.gifAbort.abort();
  resetGifUi();
  history.replaceState(null, "", location.pathname + location.search);
  if (V.opener && V.opener.isConnected) V.opener.focus();
});

$("#share-btn").addEventListener("click", async (e) => {
  const url = `${location.origin}${location.pathname}${shareHash(V.book, V.frames.length ? V.frames[V.wanted] : null)}`;
  try {
    await navigator.clipboard.writeText(url);
    e.target.textContent = "Copied!";
  } catch {
    prompt("Copy this link:", url);
  }
  setTimeout(() => (e.target.textContent = "Copy share link"), 1600);
});

// ---- Exports: GIF, video, contact sheet ----

const gifFormat = $("#gif-format");
if (!videoMime()) gifFormat.querySelector('option[value="video"]').remove();
const FORMAT_LABEL = { gif: "GIF", video: "video", sheet: "contact sheet" };
gifFormat.addEventListener("change", () => {
  resetGifUi();
  const delay = $("#gif-delay");
  delay.disabled = gifFormat.value === "sheet";
  delay.title = delay.disabled ? "Contact sheets don't move, so there's no speed to set" : "";
});

function resetGifUi() {
  gifProgress.hidden = true;
  gifError.textContent = "";
  gifResult.hidden = true;
  gifBtn.disabled = false;
  gifBtn.textContent = `Make ${FORMAT_LABEL[gifFormat.value]}`;
  if (V.gifUrl) URL.revokeObjectURL(V.gifUrl);
  V.gifUrl = null;
}

function medianAspect(pages) {
  const ratios = pages.filter((p) => p.width && p.height).map((p) => p.height / p.width).sort((a, b) => a - b);
  const r = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 4 / 3;
  return Math.min(2, Math.max(0.5, r));
}

/** "Title · Institution" for the credit line. */
function creditText(book) {
  const src = SOURCES[book.source];
  let who = src && book.source !== "mine" ? src.name : "";
  if (!who && book.data && book.data.attribution) who = book.data.attribution.replace(/\s+/g, " ").slice(0, 70);
  if (!who) who = hostOf(book.manifestUrl);
  return [book.title, who].filter(Boolean).join(" · ");
}

/**
 * Choose export images, reusing what's already around where possible:
 * baked files (no server cost), then the shelf's 300px size, then the viewer's
 * 800px size. Only those two widths are ever requested.
 */
function gifSources(n, width) {
  const baked = V.book.baked;
  if (baked && (!V.live || (width <= SMALL && n <= baked.files.length))) {
    return sampleIndices(baked.files.length, n).map((k) => baked.files[k]);
  }
  const pages = V.book.data.pages;
  if (width <= SMALL && n <= OVERVIEW_FRAMES) {
    // Pick from the overview pages: the exact images the shelf and viewer already fetched.
    const overview = sampleIndices(pages.length, OVERVIEW_FRAMES);
    return sampleIndices(overview.length, n).map((k) => smallUrl(overview[k]));
  }
  const size = width <= SMALL ? SMALL : BIG;
  return sampleIndices(pages.length, n).map((i) => pageImageUrl(pages[i], size));
}

/**
 * Like gifSources, but first looks at a pool of small thumbnails (at most 72,
 * mostly ones the shelf and viewer already loaded) to drop blank pages, or keep
 * only plates, before choosing `n` evenly from what's left.
 */
async function pickPages(n, width, mode, signal, onProgress) {
  if (mode === "all") return gifSources(n, width);
  const baked = V.book.baked;
  const total = V.book.total;
  const wantBig = width > SMALL && V.live;
  let pool = baked ? baked.pages.map((page, k) => ({ page, small: baked.files[k] })) : null;
  if (V.live && (!pool || n * 2 > pool.length)) {
    const idx = new Set([...sampleIndices(total, OVERVIEW_FRAMES), ...sampleIndices(total, Math.min(72, Math.max(24, n * 3)))]);
    pool = [...idx].sort((a, b) => a - b).map((page) => ({ page, small: smallUrl(page) }));
  }
  let done = 0;
  await Promise.all(
    pool.map((c) =>
      loadImage(c.small, { signal })
        .catch(() => null)
        .finally(() => onProgress && onProgress(++done, pool.length))
    )
  );
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const kind = (c) => (pageStats.get(c.small) || {}).kind;
  const loaded = pool.filter((c) => loadedUrls.has(c.small));
  const nonBlank = loaded.filter((c) => kind(c) !== "blank");
  let chosen = nonBlank.length >= 2 ? nonBlank : loaded;
  if (mode === "plates") {
    const plates = nonBlank.filter((c) => kind(c) === "plate");
    if (plates.length >= 2) chosen = plates;
  }
  const picks = sampleIndices(chosen.length, n).map((k) => chosen[k]);
  return picks.map((c) => (wantBig ? bigUrl(c.page) : c.small));
}

gifBtn.addEventListener("click", async () => {
  if (!V.book || (!V.live && !V.book.baked)) return;
  resetGifUi();
  const format = gifFormat.value;
  const n = Number($("#gif-frames").value);
  const width = Number($("#gif-width").value);
  const delay = Number($("#gif-delay").value);
  const mode = $("#gif-pages").value;
  const credit = $("#gif-credit").checked ? creditText(V.book) : "";
  const aspect = medianAspect(V.live ? V.book.data.pages : []);
  const height = Math.round(width * aspect);

  const bar = $(".progress-bar", gifProgress);
  const text = $(".progress-text", gifProgress);
  const progress = (label) => (done, total) => {
    bar.style.width = `${Math.round((done / total) * 100)}%`;
    text.textContent = `${label} ${Math.min(done + 1, total)} of ${total}`;
  };
  gifProgress.hidden = false;
  gifBtn.disabled = true;
  gifBtn.textContent = "Cooking…";
  const abort = new AbortController();
  V.gifAbort = abort;
  const background = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || "#f6efe2";

  try {
    // Known no-CORS server: say so before fetching anything.
    const probe = V.live ? smallUrl(V.frames[0] || 0) : null;
    if (probe && hosts.get(hostOf(probe))?.cors === false) throw corsError();
    const urls = await pickPages(n, width, mode, abort.signal, progress("Looking at page"));
    if (urls.some((u) => hosts.get(hostOf(u))?.cors === false)) throw corsError();
    const images = await loadFrames(urls, { signal: abort.signal, onProgress: progress("Fetching page") });
    const opts = { width, height, delay, background, credit, signal: abort.signal };
    let blob;
    if (format === "video") blob = await encodeVideo(images, { ...opts, onProgress: progress("Recording frame") });
    else if (format === "sheet") blob = await contactSheet(images, { cellWidth: Math.min(width, 300), aspect, background, credit });
    else blob = await encodeGif(images, { ...opts, onProgress: progress("Encoding page") });

    V.gifUrl = URL.createObjectURL(blob);
    track(`${format}/${bookTag(V.book)}`, `${FORMAT_LABEL[format]}: ${V.book.removable ? hostOf(V.book.manifestUrl) : V.book.title || V.book.note}`);
    const video = $("#gif-video");
    const img = $("#gif-img");
    video.hidden = format !== "video";
    img.hidden = format === "video";
    if (format === "video") video.src = V.gifUrl;
    else img.src = V.gifUrl;
    const ext = format === "video" ? (blob.type.includes("mp4") ? "mp4" : "webm") : format === "sheet" ? "jpg" : "gif";
    const dl = $("#gif-download");
    dl.href = V.gifUrl;
    dl.download = `${slug(V.book.title)}.${ext}`;
    dl.textContent = `Download ${ext.toUpperCase()}`;
    const what = format === "sheet" ? `${images.length} pages` : `${width}×${height} · ${images.length} frames`;
    $("#gif-size").textContent = `${what} · ${Math.round(blob.size / 1024)} KB`;
    gifResult.dataset.sources = urls.join(" ");
    gifResult.hidden = false;
    gifProgress.hidden = true;
  } catch (err) {
    if (err.name !== "AbortError") {
      gifError.textContent = err.message;
      gifProgress.hidden = true;
    }
  } finally {
    gifBtn.disabled = false;
    gifBtn.textContent = `Make another ${FORMAT_LABEL[format]}`;
    if (V.gifAbort === abort) V.gifAbort = null;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadBaked() {
  try {
    const res = await fetch("baked/index.json", { cache: "no-cache" });
    if (res.ok) BAKED = (await res.json()).items || {};
  } catch {}
}

function openFromHash() {
  const m = location.hash.match(/^#m=([^&]+)(?:&p=(\d+))?/);
  if (!m) return;
  const input = decodeURIComponent(m[1]);
  const page = m[2] ? Math.max(0, Number(m[2]) - 1) : null;
  const existing = [...cards].find((c) => c.book.input === input);
  if (existing) openViewer(existing.book, { page });
  else shelveInput(input, { open: true, page });
}

// Long-lived image cache for returning visitors (see sw.js). Optional.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

initAnalytics();
await loadBaked();
for (const input of readShelf()) addCard(new Book({ input, removable: true }));
// ?examples=0 hides the starter shelf (used by the tests; handy for embedding too).
if (new URLSearchParams(location.search).get("examples") !== "0") {
  for (const ex of EXAMPLES) addCard(new Book(ex));
}
openFromHash();
