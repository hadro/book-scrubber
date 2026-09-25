import {
  resolveInput,
  fetchFirstManifest,
  parseManifest,
  pageImageUrl,
  sampleIndices,
  bisectionOrder,
} from "./iiif.js";
import { EXAMPLES, SOURCES, guessSource } from "./examples.js";
import { makeGif } from "./gif.js";

const CARD_PX = { w: 300, h: 400 };
const STAGE_PX = 1000;
const STAGE_MAX_FRAMES = 150;
const STORAGE_KEY = "book-scrubber:shelf";

const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** A tiny concurrency limiter so we don't hammer anyone's image server. */
function limiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return (fn, { front = false } = {}) =>
    new Promise((resolve, reject) => {
      queue[front ? "unshift" : "push"]({ fn, resolve, reject });
      pump();
    });
}

const imageSlots = limiter(6);
const manifestSlots = limiter(3);
const imageCache = new Map();

/** Load (and remember) an image. Resolves with the URL once it's decoded. */
function loadImage(url, opts) {
  if (!imageCache.has(url)) {
    const p = imageSlots(
      () =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.decoding = "async";
          img.onload = () => resolve(url);
          img.onerror = () => reject(new Error("image failed"));
          img.src = url;
        }),
      opts
    );
    p.catch(() => imageCache.delete(url));
    imageCache.set(url, p);
  }
  return imageCache.get(url);
}

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
// Book: an input string plus its lazily-loaded manifest
// ---------------------------------------------------------------------------

class Book {
  constructor({ input, title, note, source, removable = false }) {
    this.input = input;
    this.title = title || "";
    this.note = note || "";
    this.source = source || guessSource(resolveInput(input)[0] || "");
    this.removable = removable;
    this.data = null;
    this.manifestUrl = resolveInput(input)[0] || input;
  }

  load() {
    if (!this._loading) {
      this._loading = manifestSlots(async () => {
        const candidates = resolveInput(this.input);
        if (!candidates.length) throw new Error("That doesn't look like a URL or an identifier.");
        const { url, json } = await fetchFirstManifest(candidates);
        this.manifestUrl = url;
        this.data = parseManifest(json);
        if (!this.title) this.title = this.data.label;
        return this.data;
      });
      this._loading.catch(() => {});
    }
    return this._loading;
  }
}

// ---------------------------------------------------------------------------
// Shelf cards
// ---------------------------------------------------------------------------

const shelfEl = $("#shelf");
const cards = new Set();
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
    this.frames = [];
    this.urls = [];
    this.loaded = new Set();
    this.current = 0;
    this.preloading = false;

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
    const d = this.book.data;
    const pages = d ? `${d.pages.length} ${d.pages.length === 1 ? "image" : "pages"}` : "";
    $(".card-note", this.el).textContent = [this.book.note, pages].filter(Boolean).join(" · ");
    this.cover.setAttribute("aria-label", `${this.book.title || "Book"}: open flipbook`);
  }

  async init() {
    if (this._init) return this._init;
    this._init = (async () => {
      try {
        await this.book.load();
      } catch (err) {
        this.showError(err);
        return;
      }
      this.setCaption();
      this.buildFrames();
      if (flashTimer) this.preload();
    })();
    return this._init;
  }

  buildFrames() {
    const { pages } = this.book.data;
    this.frames = sampleIndices(pages.length, density);
    this.urls = this.frames.map((i) => pageImageUrl(pages[i], CARD_PX.w, CARD_PX.h));
    this.loaded = new Set();
    this.preloading = false;
    this.ticks.replaceChildren(...this.frames.map(() => document.createElement("i")));

    // The cover goes first, at the front of the queue.
    loadImage(this.urls[0], { front: true })
      .then(() => {
        this.markLoaded(0);
        this.show(0);
        this.img.classList.add("is-ready");
        this.cover.classList.add("is-loaded-cover");
      })
      .catch(() => this.showError(new Error("The first page image wouldn't load.")));
  }

  preload() {
    if (this.preloading || !this.urls.length) return;
    this.preloading = true;
    const urls = this.urls;
    for (const i of bisectionOrder(urls.length)) {
      loadImage(urls[i])
        .then(() => {
          if (this.urls !== urls) return; // density changed meanwhile
          this.markLoaded(i);
          if (this.wanted === i) this.show(i);
        })
        .catch(() => {});
    }
  }

  markLoaded(i) {
    this.loaded.add(i);
    const tick = this.ticks.children[i];
    if (tick) tick.classList.add("is-loaded");
  }

  nearestLoaded(i) {
    if (this.loaded.has(i)) return i;
    for (let d = 1; d < this.frames.length; d++) {
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
    if (this.img.getAttribute("src") !== this.urls[j]) this.img.src = this.urls[j];
    const tick = this.ticks.children[j];
    if (tick) tick.classList.add("is-current");
    const pages = this.book.data.pages;
    this.counter.textContent = `p. ${this.frames[j] + 1} / ${pages.length}`;
  }

  /** Scrub to a 0..1 position across the card. */
  scrubTo(f) {
    if (!this.frames.length) return;
    if (this.book.data.rtl) f = 1 - f;
    const i = Math.min(this.frames.length - 1, Math.max(0, Math.floor(f * this.frames.length)));
    this.wanted = i;
    this.show(i);
  }

  reset() {
    this.wanted = null;
    this.cover.classList.remove("is-scrubbing");
    if (this.frames.length && !flashTimer) this.show(0);
  }

  bindPointer() {
    const c = this.cover;
    let startX = null;
    let moved = false;

    c.addEventListener("pointerenter", () => {
      if (this.book.data) this.preload();
      else this.init().then(() => this.preload());
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
    const end = () => {
      startX = null;
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", () => {
      end();
      this.reset();
    });
    c.addEventListener("pointerleave", () => {
      end();
      this.reset();
    });
    c.addEventListener("click", (e) => {
      if (moved && e.pointerType !== "mouse") {
        moved = false;
        return;
      }
      if (this.book.data) openViewer(this.book);
    });
    c.addEventListener("keydown", (e) => {
      if (!this.frames.length) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        this.preload();
        const step = (e.key === "ArrowRight") !== this.book.data.rtl ? 1 : -1;
        const next = Math.min(this.frames.length - 1, Math.max(0, (this.wanted ?? this.current) + step));
        this.wanted = next;
        this.show(next);
      }
    });
    c.addEventListener("blur", () => this.reset());
  }

  showError(err) {
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
    if (!this.book.title) $(".card-title", this.el).textContent = this.book.input;
  }

  // Flash mode: advance to the next page we already have.
  flashStep() {
    if (!this.visible || !this.frames.length || this.cover.classList.contains("is-scrubbing")) return;
    this.preload();
    if (this.loaded.size < 2) return;
    this.cover.classList.add("is-flashing");
    let next = this.current;
    for (let k = 0; k < this.frames.length; k++) {
      next = (next + 1) % this.frames.length;
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
    if (card.book.data) card.buildFrames();
  }
});

$("#flash-toggle").addEventListener("change", (e) => {
  if (e.target.checked) {
    flashTimer = setInterval(() => cards.forEach((c) => c.flashStep()), 650);
  } else {
    clearInterval(flashTimer);
    flashTimer = null;
    cards.forEach((c) => {
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
    if (open && existing.book.data) openViewer(existing.book);
    return existing;
  }
  if (!resolveInput(input).length) {
    setStatus("Hmm, that doesn't look like a link or an identifier.", true);
    return null;
  }
  const book = new Book({ input, removable: true });
  setStatus("Fetching the manifest…");
  try {
    await book.load();
  } catch (err) {
    setStatus(`Couldn't shelve that one: ${friendlyError(err)}`, true);
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

const viewer = $("#viewer");
const stageFrame = $(".stage-frame", viewer);
const stageImg = $("#stage-img");
const stageLoading = $("#stage-loading");
const stageCounter = $("#stage-counter");
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
  frames: [],
  urls: [],
  loaded: new Set(),
  current: 0,
  wanted: 0,
  gen: 0,
  playing: null,
  dir: 1,
  gifAbort: null,
  gifUrl: null,
};

function openViewer(book) {
  const d = book.data;
  V.book = book;
  V.gen++;
  const gen = V.gen;
  V.frames = sampleIndices(d.pages.length, STAGE_MAX_FRAMES);
  V.urls = V.frames.map((i) => pageImageUrl(d.pages[i], STAGE_PX, STAGE_PX));
  V.loaded = new Set();
  V.current = V.wanted = 0;
  V.dir = 1;

  const src = SOURCES[book.source] || SOURCES.mine;
  const sticker = $("#viewer-sticker");
  sticker.textContent = src.name;
  sticker.style.setProperty("--sticker", src.color);
  $("#viewer-title").textContent = book.title;
  const sampled = V.frames.length < d.pages.length ? ` · scrubbing ${V.frames.length} of them` : "";
  $("#viewer-meta").textContent = [`${d.pages.length} images${sampled}`, d.attribution].filter(Boolean).join(" · ");
  $("#viewer-manifest").href = book.manifestUrl;

  range.max = String(V.frames.length - 1);
  range.value = "0";
  stageImg.removeAttribute("src");
  stageLoading.hidden = false;
  stageCounter.textContent = "–";
  resetGifUi();
  stopPlay();

  for (const i of bisectionOrder(V.urls.length)) {
    const url = V.urls[i];
    loadImage(url, { front: i === 0 })
      .then(() => {
        if (V.gen !== gen) return;
        V.loaded.add(i);
        if (V.loaded.size === 1 || V.wanted === i) viewerShow(V.wanted);
      })
      .catch(() => {});
  }

  if (!viewer.open) viewer.showModal();
  history.replaceState(null, "", `#m=${encodeURIComponent(book.input)}`);
}

function viewerNearest(i) {
  if (V.loaded.has(i)) return i;
  for (let d = 1; d < V.frames.length; d++) {
    if (V.loaded.has(i - d)) return i - d;
    if (V.loaded.has(i + d)) return i + d;
  }
  return -1;
}

function viewerShow(i) {
  V.wanted = i;
  range.value = String(i);
  const j = viewerNearest(i);
  if (j < 0) return;
  stageLoading.hidden = true;
  V.current = j;
  if (stageImg.getAttribute("src") !== V.urls[j]) stageImg.src = V.urls[j];
  const page = V.book.data.pages[V.frames[j]];
  const label = page.label && !/^\d+$/.test(page.label) ? ` · ${page.label}` : "";
  stageCounter.textContent = `p. ${V.frames[j] + 1} / ${V.book.data.pages.length}${label}`;
  stageImg.alt = `${V.book.title}, image ${V.frames[j] + 1}`;
}

function viewerStep(delta) {
  const n = V.frames.length;
  let next = V.wanted + delta;
  if (bounce.checked) {
    if (next >= n || next < 0) {
      V.dir = -V.dir;
      next = V.wanted + delta * -1;
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
    stopPlay();
    const r = stageFrame.getBoundingClientRect();
    let f = (e.clientX - r.left) / r.width;
    if (V.book.data.rtl) f = 1 - f;
    viewerShow(Math.min(V.frames.length - 1, Math.max(0, Math.floor(f * V.frames.length))));
  });
}

viewer.addEventListener("keydown", (e) => {
  if (e.target.matches("input[type=text], select")) return;
  const rtl = V.book && V.book.data.rtl;
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

gifBtn.addEventListener("click", async () => {
  if (!V.book) return;
  resetGifUi();
  const d = V.book.data;
  const n = Number($("#gif-frames").value);
  const width = Number($("#gif-width").value);
  const delay = Number($("#gif-delay").value);
  const idx = sampleIndices(d.pages.length, n);
  const pages = idx.map((i) => d.pages[i]);
  const height = Math.round(width * medianAspect(pages));
  const urls = pages.map((p) => pageImageUrl(p, width, height));

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

for (const input of readShelf()) addCard(new Book({ input, removable: true }));
for (const ex of EXAMPLES) addCard(new Book(ex));

function openFromHash() {
  const m = location.hash.match(/^#m=(.+)$/);
  if (!m) return;
  const input = decodeURIComponent(m[1]);
  const existing = [...cards].find((c) => c.book.input === input);
  if (existing) {
    existing.book.load().then(() => openViewer(existing.book), (err) => setStatus(friendlyError(err), true));
  } else {
    shelveInput(input, { open: true });
  }
}
openFromHash();
