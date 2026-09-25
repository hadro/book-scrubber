import {
  resolveInput,
  inputHint,
  fetchFirstManifest,
  parseManifest,
  pageImageUrl,
  sampleIndices,
  bisectionOrder,
  SMALL,
  BIG,
} from "./iiif.js";
import { EXAMPLES, SOURCES, guessSource } from "./examples.js";
import { makeGif } from "./gif.js";
import { cacheGet, cacheSet } from "./store.js";

const STAGE_MAX_FRAMES = 150;
const OVERVIEW_FRAMES = 24; // matches the default shelf density, so URLs are shared
const PER_HOST = 3; // simultaneous image requests per server
const HOVER_INTENT_MS = 150; // ignore mouse fly-bys shorter than this
const DWELL_MS = 200; // only fetch big images once scrubbing pauses
const STORAGE_KEY = "book-scrubber:shelf";
const MANIFEST_TTL_MS = 7 * 24 * 3600 * 1000; // re-check remembered manifests weekly

const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------------
// Image loading: per-host queues, shared cache, cancellable while queued
// ---------------------------------------------------------------------------

const loadedUrls = new Set(); // decoded and in the browser cache
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
    img.onload = resolve;
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
      .then(() => {
        if (tryCors) h.cors = true;
      })
      .catch(async (err) => {
        // Unknown server and the CORS attempt failed: maybe it just doesn't
        // send CORS headers. One plain retry settles it for this server
        // (unless it's already failing, when the retry would just add load).
        if (tryCors && h.cors === undefined && h.failures === 0) {
          await fetchImage(job.url, false);
          h.cors = false;
          return;
        }
        throw err;
      })
      .then(
        () => {
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
async function loadManifest(candidates) {
  const key = candidates.join(" ");
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
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
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
  constructor({ input, title, note, source, removable = false }) {
    this.input = input;
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
  get rtl() {
    return this.data ? this.data.rtl : !!(this.baked && this.baked.rtl);
  }

  load() {
    if (!this._loading) {
      this._loading = manifestSlots(async () => {
        const candidates = resolveInput(this.input);
        if (!candidates.length) throw new Error(inputHint(this.input) || "That doesn't look like a URL or an identifier.");
        const { url, json } = await loadManifest(candidates);
        this.manifestUrl = url;
        this.data = parseManifest(json);
        if (!this.title) this.title = this.data.label;
        return this.data;
      });
      this._loading.catch(() => {});
    }
    return this._loading;
  }

  /** The frames a shelf card scrubs through: baked files if we have them, else live thumbnails. */
  reel(density) {
    if (this.baked) return { pages: this.baked.pages, urls: this.baked.files, baked: true };
    const pages = sampleIndices(this.data.pages.length, density);
    return { pages, urls: pages.map((i) => pageImageUrl(this.data.pages[i], SMALL)), baked: false };
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
    $(".card-note", this.el).textContent = [this.book.note, pages].filter(Boolean).join(" · ");
    this.cover.setAttribute("aria-label", `${this.book.title || "Book"}: open flipbook`);
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

  buildFrames() {
    this.stopPreload(true);
    this.reel = this.book.reel(density);
    this.loaded = new Set();
    this.ticks.replaceChildren(...this.reel.pages.map(() => document.createElement("i")));

    loadImage(this.reel.urls[0], { front: true })
      .then(() => {
        this.markLoaded(0);
        this.show(0);
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
    for (const i of bisectionOrder(reel.urls.length)) {
      loadImage(reel.urls[i], { signal })
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
  }

  nearestLoaded(i) {
    const n = this.reel.pages.length;
    if (this.loaded.has(i)) return i;
    for (let d = 1; d < n; d++) {
      if (this.loaded.has(i - d)) return i - d;
      if (this.loaded.has(i + d)) return i + d;
    }
    return -1;
  }

  show(i) {
    const j = this.nearestLoaded(i);
    if (j < 0) return;
    const prev = this.ticks.children[this.current];
    if (prev) prev.classList.remove("is-current");
    this.current = j;
    setImg(this.img, this.reel.urls[j]);
    const tick = this.ticks.children[j];
    if (tick) tick.classList.add("is-current");
    this.counter.textContent = `p. ${this.reel.pages[j] + 1} / ${this.book.total}`;
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
    if (this.reel && !flashTimer) this.show(0);
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

    c.addEventListener("pointerenter", (e) => {
      cancelIntent();
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
      this.stopPreload();
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
    if (this.loaded.size < 2) return;
    this.cover.classList.add("is-flashing");
    let next = this.current;
    for (let k = 0; k < this.reel.pages.length; k++) {
      next = (next + 1) % this.reel.pages.length;
      if (this.loaded.has(next)) break;
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
    // Baked cards have a fixed reel; only live ones resample.
    if (card.reel && !card.reel.baked) {
      card.buildFrames();
      if (flashTimer) card.preload();
    }
  }
});

$("#flash-toggle").addEventListener("change", (e) => {
  if (e.target.checked) {
    flashTimer = setInterval(() => cards.forEach((c) => c.flashStep()), 650);
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

async function shelveInput(input, { open = false } = {}) {
  input = input.trim();
  if (!input) return null;
  const existing = [...cards].find((c) => c.book.input === input);
  if (existing) {
    existing.el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (open) openViewer(existing.book);
    return existing;
  }
  if (!resolveInput(input).length) {
    setStatus(inputHint(input) || "Hmm, that doesn't look like a link or an identifier.", true);
    return null;
  }
  const book = new Book({ input, removable: true });
  setStatus("Fetching the manifest…");
  try {
    await book.load();
  } catch (err) {
    setStatus(`Couldn't shelve that one: ${friendlyError(err)} ${inputHint(input)}`.trim(), true);
    return null;
  }
  const card = addCard(book, { prepend: true, animate: true });
  writeShelf([input, ...readShelf().filter((x) => x !== input)].slice(0, 40));
  setStatus(`Shelved "${book.title}" (${book.data.pages.length} images). Hover it!`);
  card.el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (open) openViewer(book);
  return card;
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
// Viewer (flipbook + GIF maker)
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
  for (let d = 0; d < n; d++) {
    for (const j of d ? [i - d, i + d] : [i]) {
      if (j < 0 || j >= n) continue;
      const url = availableAt(j);
      if (url) return { j, url };
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

async function openViewer(book) {
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
  history.replaceState(null, "", `#m=${encodeURIComponent(book.input)}`);

  // Show the baked preview straight away while the manifest loads.
  if (book.baked) {
    setFrames(book.baked.pages);
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
  const overview = sampleIndices(d.pages.length, OVERVIEW_FRAMES);
  const keepPage = V.frames.length ? V.frames[V.wanted] : null;
  const pages = new Set([...sampleIndices(d.pages.length, STAGE_MAX_FRAMES), ...overview, ...V.bakedMap.keys()]);
  setFrames([...pages].sort((a, b) => a - b), keepPage);
  const sampled = V.frames.length < d.pages.length ? ` · scrubbing ${V.frames.length} of them` : "";
  viewerMeta.textContent = [`${d.pages.length} images${sampled}`, d.attribution].filter(Boolean).join(" · ");

  // A coarse overview so the slider works end to end: the same small images the
  // shelf card uses (usually already cached), or nothing at all for baked books.
  if (!book.baked) {
    for (const k of bisectionOrder(overview.length)) {
      loadImage(smallUrl(overview[k]), { signal: V.ctl.signal })
        .then(() => V.gen === gen && viewerDisplay(V.wanted))
        .catch(() => {});
    }
  }
  viewerShow(V.wanted);
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
  const label = p && p.label && !/^\d+$/.test(p.label) ? ` · ${p.label}` : "";
  stageCounter.textContent = `p. ${page + 1} / ${V.book.total}${label}`;
  stageImg.alt = `${V.book.title}, image ${page + 1}`;
}

/** Show frame i and ask for what's needed around it. */
function viewerShow(i) {
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
  const fps = Number(speed.value);
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
  V.gen++;
  stopPlay();
  abortViewerRequests();
  if (V.gifAbort) V.gifAbort.abort();
  resetGifUi();
  history.replaceState(null, "", location.pathname + location.search);
});

$("#share-btn").addEventListener("click", async (e) => {
  const url = `${location.origin}${location.pathname}#m=${encodeURIComponent(V.book.input)}`;
  try {
    await navigator.clipboard.writeText(url);
    e.target.textContent = "Copied!";
  } catch {
    prompt("Copy this link:", url);
  }
  setTimeout(() => (e.target.textContent = "Copy share link"), 1600);
});

// ---- GIF ----

function resetGifUi() {
  gifProgress.hidden = true;
  gifError.textContent = "";
  gifResult.hidden = true;
  gifBtn.disabled = false;
  gifBtn.textContent = "Make GIF";
  if (V.gifUrl) URL.revokeObjectURL(V.gifUrl);
  V.gifUrl = null;
}

function medianAspect(pages) {
  const ratios = pages.filter((p) => p.width && p.height).map((p) => p.height / p.width).sort((a, b) => a - b);
  const r = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 4 / 3;
  return Math.min(2, Math.max(0.5, r));
}

/**
 * Choose GIF source images, reusing what's already around where possible:
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

gifBtn.addEventListener("click", async () => {
  if (!V.book || (!V.live && !V.book.baked)) return;
  resetGifUi();
  const n = Number($("#gif-frames").value);
  const width = Number($("#gif-width").value);
  const delay = Number($("#gif-delay").value);
  const urls = gifSources(n, width);
  if (urls.some((u) => hosts.get(hostOf(u))?.cors === false)) {
    gifError.textContent =
      "This library's image server doesn't let other websites re-use its images (no CORS headers), so a GIF can't be made in the browser for this item. The scrubber still works!";
    return;
  }
  const height = Math.round(width * medianAspect(V.live ? V.book.data.pages : []));

  const bar = $(".progress-bar", gifProgress);
  const text = $(".progress-text", gifProgress);
  gifProgress.hidden = false;
  gifBtn.disabled = true;
  gifBtn.textContent = "Cooking…";
  const abort = new AbortController();
  V.gifAbort = abort;
  const bgColor = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || "#f6efe2";

  try {
    const blob = await makeGif(urls, {
      width,
      height,
      delay,
      background: bgColor,
      signal: abort.signal,
      onProgress: (done, total, phase) => {
        bar.style.width = `${Math.round((done / total) * 100)}%`;
        text.textContent = phase === "done" ? "Done!" : `${phase === "fetching" ? "Fetching" : "Encoding"} page ${done + 1} of ${total}`;
      },
    });
    V.gifUrl = URL.createObjectURL(blob);
    $("#gif-img").src = V.gifUrl;
    const dl = $("#gif-download");
    dl.href = V.gifUrl;
    dl.download = `${slug(V.book.title)}.gif`;
    $("#gif-size").textContent = `${width}×${height} · ${urls.length} frames · ${Math.round(blob.size / 1024)} KB`;
    gifResult.hidden = false;
    gifProgress.hidden = true;
  } catch (err) {
    if (err.name !== "AbortError") {
      gifError.textContent = err.message;
      gifProgress.hidden = true;
    }
  } finally {
    gifBtn.disabled = false;
    gifBtn.textContent = "Make another GIF";
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
  const m = location.hash.match(/^#m=(.+)$/);
  if (!m) return;
  const input = decodeURIComponent(m[1]);
  const existing = [...cards].find((c) => c.book.input === input);
  if (existing) openViewer(existing.book);
  else shelveInput(input, { open: true });
}

// Long-lived image cache for returning visitors (see sw.js). Optional.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

await loadBaked();
for (const input of readShelf()) addCard(new Book({ input, removable: true }));
for (const ex of EXAMPLES) addCard(new Book(ex));
openFromHash();
