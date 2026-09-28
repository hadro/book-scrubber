// End-to-end tests: the real app in headless Chromium against a fake IIIF
// server. Run with `npm run test:e2e` (needs `npx playwright install chromium`).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStatic, startFakeIiif } from "./servers.mjs";
import { bake } from "../../scripts/bake-examples.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app, iiif, browser, bakedApp;

before(async () => {
  iiif = await startFakeIiif();
  app = await startStatic(ROOT);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await app?.close();
  await bakedApp?.close();
  await iiif?.close();
});

/** A fresh browser context whose shelf holds the given fake books. */
async function openApp({ shelf = [], hash = "", origin = app.origin, context = {}, blockSW = true, waitReady = true, stallMs } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: blockSW ? "block" : "allow", ...context });
  if (stallMs) await ctx.addInitScript((ms) => (window.FLIPBOOK_STALL_MS = ms), stallMs);
  await ctx.addInitScript((inputs) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("flipbook:shelf", JSON.stringify(inputs));
    }
  }, shelf.map((b) => (b.startsWith("http") ? b : iiif.manifest(b))));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/?examples=0${hash}`);
  if (waitReady) await page.waitForSelector(".card .card-img.is-ready", { timeout: 10000 }).catch(() => {});
  return { ctx, page, errors };
}

async function hover(page, index, ms, fractions = [0.1, 0.5, 0.9]) {
  const cover = page.locator(".card-cover").nth(index);
  await cover.scrollIntoViewIfNeeded();
  const box = await cover.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await sleep(ms);
  const counters = [];
  for (const f of fractions) {
    await page.mouse.move(box.x + box.width * f, box.y + box.height / 2);
    counters.push(await cover.locator(".counter").textContent());
  }
  await page.mouse.move(2, 2);
  return counters;
}

const pageOf = (counter) => Number(counter.match(/p\. (\d+)/)[1]) - 1;

test("shelf: hover scrubbing moves through the book", async () => {
  const { ctx, page, errors } = await openApp({ shelf: ["plain"] });
  const counters = await hover(page, 0, 1500);
  const pages = counters.map(pageOf);
  assert.ok(pages[0] < pages[1] && pages[1] < pages[2], `pages should increase: ${counters}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("cards link to the IIIF manifest and, when known, the item page", async () => {
  const { ctx, page } = await openApp({ shelf: ["home", "plain"] });
  await page.waitForFunction(() => document.querySelectorAll(".card .card-note").length === 2 && [...document.querySelectorAll(".card-note")].every((n) => /pages/.test(n.textContent)));
  const links = await page.$$eval(".card", (cards) =>
    cards.map((c) => ({
      title: c.querySelector(".card-title").textContent,
      page: c.querySelector(".card-link-page").hidden ? null : c.querySelector(".card-link-page").href,
      iiif: c.querySelector(".card-link-iiif").href,
    }))
  );
  const home = links.find((l) => l.title === "Book home");
  const plain = links.find((l) => l.title === "Book plain");
  assert.equal(home.page, "https://library.example/items/home");
  assert.equal(home.iiif, iiif.manifest("home"));
  assert.equal(plain.page, null, "no item page is invented for an unknown server");
  assert.equal(plain.iiif, iiif.manifest("plain"));
  await ctx.close();
});

test("politeness: fly-bys cost nothing, brief hovers little, repeats nothing", async () => {
  const { ctx, page } = await openApp({ shelf: ["plain", "oz", "mixed"] });
  await sleep(500);
  iiif.reset();
  await page.locator(".card-cover").first().scrollIntoViewIfNeeded();
  const boxes = await Promise.all([0, 1, 2].map((i) => page.locator(".card-cover").nth(i).boundingBox()));
  for (const b of boxes) await page.mouse.move(b.x + b.width / 2, b.y + 50, { steps: 2 });
  await page.mouse.move(2, 2);
  await sleep(800);
  assert.equal(iiif.stats().images, 0, "fly-by should not fetch");

  await hover(page, 0, 3000);
  const full = iiif.stats().images;
  assert.ok(full >= 20 && full <= 24, `a full hover fetches the reel once (got ${full})`);
  await hover(page, 0, 800);
  assert.equal(iiif.stats().images, full, "re-hover is free");
  for (const n of Object.values(iiif.stats().maxActive)) assert.ok(n <= 3, "at most 3 at a time per server");
  await ctx.close();
});

test("a deliberate hover finishes loading the card; a quick pass doesn't", async () => {
  const { ctx, page } = await openApp({ shelf: ["typical", "plain"] });
  const covers = page.locator(".card-cover");
  await covers.first().scrollIntoViewIfNeeded();
  const [a, b] = await Promise.all([covers.nth(0).boundingBox(), covers.nth(1).boundingBox()]);
  // Quick pass over card 2 (≈300 ms): queued requests are dropped when the mouse leaves.
  await page.mouse.move(b.x + 20, b.y + 100);
  await sleep(300);
  await page.mouse.move(2, 2);
  // Deliberate look at card 1 (≈900 ms), then away.
  await page.mouse.move(a.x + 20, a.y + 100);
  await sleep(900);
  await page.mouse.move(2, 2);
  await sleep(6500);
  const loaded = (i) => page.locator(".card").nth(i).locator(".ticks i.is-loaded").count();
  assert.equal(await loaded(0), 24, "the deliberately hovered card finished loading");
  assert.ok((await loaded(1)) < 12, `the quickly passed card stopped early (${await loaded(1)})`);
  await ctx.close();
});

test("viewer: opens, steps, and drops queued requests when closed", async () => {
  const { ctx, page } = await openApp({ shelf: ["oz"] });
  await page.locator(".card-cover").first().click();
  await page.waitForFunction(() => /p\. \d+ \/ 96/.test(document.querySelector("#stage-counter").textContent));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.mouse.move(2, 2); // so the card underneath doesn't count as hovered after closing
  iiif.reset();
  await page.keyboard.press("Escape");
  await sleep(1500);
  assert.ok(iiif.stats().images <= 3, `only in-flight requests finish after close (got ${iiif.stats().images})`);
  // Focus goes back to the card that opened it.
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("card-cover")), true);
  await ctx.close();
});

test("pages loaded in the viewer are reused by the shelf card", async () => {
  const { ctx, page } = await openApp({ shelf: ["plain"] });
  const ticksBefore = await page.locator(".card .ticks i").count();
  await page.locator(".card-cover").first().click();
  await page.waitForFunction(() => /p\. \d+ \/ 60/.test(document.querySelector("#stage-counter").textContent));
  // Step through the book in the viewer, pausing a little on each page.
  await page.focus("#play-btn");
  for (let k = 0; k < 59; k++) {
    await page.keyboard.press("ArrowRight");
    await sleep(70);
  }
  await sleep(1500);
  await page.mouse.move(2, 2);
  await page.keyboard.press("Escape");
  await sleep(200); // the dialog's close event fires asynchronously
  const ticksAfter = await page.locator(".card .ticks i").count();
  assert.ok(ticksAfter > ticksBefore, `card gained frames from the viewer (${ticksBefore} -> ${ticksAfter})`);

  iiif.reset();
  const sweep = Array.from({ length: 40 }, (_, k) => (k + 0.5) / 40);
  const shown = new Set((await hover(page, 0, 1500, sweep)).map(pageOf));
  assert.equal(iiif.stats().images, 0, "hovering the card afterwards costs nothing");
  assert.ok(shown.size > 24, `scrubbing reaches more pages than the 24 sampled (${shown.size})`);
  await ctx.close();
});

test("on a long book, every page the viewer loaded is reachable on the card", async () => {
  const { ctx, page } = await openApp({ shelf: ["big"] });
  await page.locator(".card-cover").first().click();
  await page.waitForFunction(() => /p\. \d+ \/ 400/.test(document.querySelector("#stage-counter").textContent));
  await page.focus("#play-btn");
  for (let k = 0; k < 170; k++) {
    await page.keyboard.press("ArrowRight");
    await sleep(50);
  }
  await sleep(1500);
  const loaded = new Set(Object.keys(iiif.stats().urls).filter((u) => u.includes("/big/")).map((u) => Number(u.match(/\/p(\d+)\//)[1])));
  await page.mouse.move(2, 2);
  await page.keyboard.press("Escape");
  await sleep(300);
  const cover = page.locator(".card-cover").first();
  await cover.scrollIntoViewIfNeeded();
  const box = await cover.boundingBox();
  const shown = new Set();
  await page.mouse.move(box.x + 1, box.y + 100);
  await sleep(300);
  for (let x = 0; x <= box.width; x += 0.5) {
    await page.mouse.move(box.x + x, box.y + 100);
    shown.add(pageOf(await cover.locator(".counter").textContent()));
  }
  const missing = [...loaded].filter((p) => !shown.has(p));
  assert.deepEqual(missing, [], `pages loaded in the viewer but unreachable on the card (${loaded.size} loaded)`);
  await ctx.close();
});

test("manifests are remembered across reloads", async () => {
  const { ctx, page } = await openApp({ shelf: ["plain", "oz"] });
  const first = iiif.stats().manifests;
  await page.reload();
  await page.waitForSelector(".card .card-img.is-ready");
  assert.equal(iiif.stats().manifests, first, "no manifest requests on reload");
  await ctx.close();
});

test("service worker keeps images from a server that forbids caching", async () => {
  const { ctx, page } = await openApp({ shelf: ["nostore"], blockSW: false });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector(".card .card-img.is-ready");
  await hover(page, 0, 2500);
  const before = iiif.stats().byBook.nostore;
  const page2 = await ctx.newPage();
  await page2.goto(`${app.origin}/?examples=0`);
  await page2.waitForSelector(".card .card-img.is-ready");
  await hover(page2, 0, 2500);
  assert.equal(iiif.stats().byBook.nostore, before, "second visit served from the service worker");
  await ctx.close();
});

test("no-CORS server: scrubbing works, exports fail fast without requests", async () => {
  const { ctx, page } = await openApp({ shelf: ["nocors"] });
  const counters = await hover(page, 0, 2000);
  assert.notEqual(counters[0], counters[2]);
  await page.locator(".card-cover").first().click();
  await sleep(500);
  const before = iiif.stats().byBook.nocors;
  await page.click("#gif-btn");
  await page.waitForSelector(".gif-error:not(:empty)");
  assert.match(await page.textContent("#gif-error"), /CORS/);
  assert.equal(iiif.stats().byBook.nocors, before);
  await ctx.close();
});

test("exports: GIF, contact sheet and (where supported) video, with credit line", async () => {
  const { ctx, page } = await openApp({ shelf: ["oz"] });
  await page.locator(".card-cover").first().click();
  await sleep(800);
  const make = async (format) => {
    await page.selectOption("#gif-format", format);
    await page.click("#gif-btn");
    await page.waitForSelector("#gif-result:not([hidden]), .gif-error:not(:empty)", { timeout: 30000 });
    assert.equal(await page.textContent("#gif-error"), "");
    return page.evaluate(async () => {
      const a = document.querySelector("#gif-download");
      const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
      return { name: a.download, head: [...buf.slice(0, 6)], size: buf.length };
    });
  };
  const gif = await make("gif");
  assert.equal(String.fromCharCode(...gif.head), "GIF89a");
  assert.match(gif.name, /\.gif$/);
  assert.equal(await page.isDisabled("#gif-delay"), false);
  await page.selectOption("#gif-format", "sheet");
  assert.equal(await page.isDisabled("#gif-delay"), true, "speed is grayed out for contact sheets");
  const sheet = await make("sheet");
  assert.deepEqual(sheet.head.slice(0, 2), [0xff, 0xd8], "contact sheet is a JPEG");
  if (await page.locator('#gif-format option[value="video"]').count()) {
    const video = await make("video");
    assert.ok(video.size > 1000);
    assert.match(video.name, /\.(webm|mp4)$/);
  }
  await ctx.close();
});

test("blank pages are skipped; plates-only keeps just the pictures", async () => {
  const { ctx, page } = await openApp({ shelf: ["mixed"] });
  const sweep = Array.from({ length: 24 }, (_, k) => (k + 0.5) / 24);
  const shown = (await hover(page, 0, 3000, sweep)).map(pageOf);
  assert.ok(shown.every((p) => iiif.kindOfPage(p) !== "blank"), `no blanks: ${shown}`);

  await page.check("#plates-toggle", { force: true });
  const plates = (await hover(page, 0, 300, sweep)).map(pageOf);
  assert.ok(plates.every((p) => iiif.kindOfPage(p) === "plate"), `plates only: ${plates}`);

  // Exports can do the same.
  await page.locator(".card-cover").first().click();
  await sleep(600);
  await page.selectOption("#gif-pages", "plates");
  await page.click("#gif-btn");
  await page.waitForSelector("#gif-result:not([hidden])", { timeout: 30000 });
  const used = (await page.getAttribute("#gif-result", "data-sources")).split(" ").map((u) => Number(u.match(/\/p(\d+)\//)[1]));
  assert.ok(used.every((p) => iiif.kindOfPage(p) === "plate"), `export used plates only: ${used}`);
  await ctx.close();
});

test("a shelf entry that resolves to a collection shows its first part", async () => {
  const { ctx, page } = await openApp({ shelf: [`${iiif.origin}/c/shelf.json`] });
  await page.waitForFunction(() => /1 of 3/.test(document.querySelector(".card-note").textContent));
  assert.equal(await page.textContent(".card-title"), "A small collection");
  assert.match(await page.textContent(".card-note"), /Book plain \(1 of 3\) · 60 pages/);
  await page.locator(".card-cover").first().click();
  await page.waitForFunction(() => /part 1 of 3/.test(document.querySelector("#viewer-meta").textContent));
  await ctx.close();
});

test("plates-only and flash mode start off again after a reload", async () => {
  const { ctx, page } = await openApp({ shelf: ["mixed"] });
  await page.check("#plates-toggle", { force: true });
  await page.check("#flash-toggle", { force: true });
  await page.reload();
  await page.waitForSelector(".card .card-img.is-ready");
  assert.equal(await page.isChecked("#plates-toggle"), false);
  assert.equal(await page.isChecked("#flash-toggle"), false);
  const counters = await hover(page, 0, 2500, Array.from({ length: 24 }, (_, k) => (k + 0.5) / 24));
  assert.ok(counters.map(pageOf).some((p) => iiif.kindOfPage(p) === "text"), "text pages are back after reload");
  await ctx.close();
});

test("a shelf saved before the rename (book-scrubber:shelf) still loads", async () => {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.addInitScript((url) => localStorage.setItem("book-scrubber:shelf", JSON.stringify([url])), iiif.manifest("plain"));
  const page = await ctx.newPage();
  await page.goto(`${app.origin}/?examples=0`);
  await page.waitForSelector(".card .card-img.is-ready");
  assert.equal(await page.textContent(".card-title"), "Book plain");
  await ctx.close();
});

test("pasting a collection shelves its books", async () => {
  const { ctx, page } = await openApp();
  await page.fill("#paste-input", `${iiif.origin}/c/shelf.json`);
  await page.click("#paste-form button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 3);
  assert.match(await page.textContent("#paste-status"), /3 books from the collection "A small collection"/);
  await ctx.close();
});

test("dropping a IIIF viewer link shelves the book", async () => {
  const { ctx, page } = await openApp();
  const link = `https://viewer.example/?manifest=${encodeURIComponent(iiif.manifest("plain"))}`;
  const dt = await page.evaluateHandle((url) => {
    const d = new DataTransfer();
    d.setData("text/uri-list", url);
    return d;
  }, link);
  await page.dispatchEvent("body", "dragenter", { dataTransfer: dt });
  assert.equal(await page.isVisible("#drop-overlay"), true);
  await page.dispatchEvent("body", "drop", { dataTransfer: dt });
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1);
  assert.equal(await page.isVisible("#drop-overlay"), false);
  await ctx.close();
});

test("share links open the viewer at a page; library link shows when known", async () => {
  const { ctx, page } = await openApp({ shelf: ["home"], hash: `#m=${encodeURIComponent(iiif.manifest("home"))}&p=17` });
  await page.waitForFunction(() => /p\. 17 \/ 30/.test(document.querySelector("#stage-counter").textContent), null, { timeout: 10000 });
  assert.equal(await page.getAttribute("#viewer-home", "href"), "https://library.example/items/home");
  await ctx.close();
});

test("failing servers get backed off", async () => {
  iiif.reset();
  const { ctx } = await openApp({ hash: `#m=${encodeURIComponent(iiif.manifest("broken"))}`, waitReady: false });
  await sleep(8000);
  const n = iiif.stats().byBook.broken || 0;
  // The viewer wants 24+ images at once; backing off should keep it well below.
  assert.ok(n > 0 && n <= 12, `backed off (got ${n} in 8s)`);
  await ctx.close();
});

test("slow servers get one request at a time", async () => {
  const { ctx, page } = await openApp({ shelf: ["slow"] });
  const t0 = Date.now();
  await hover(page, 0, 9000);
  const late = iiif.stats().timeline.filter(([t, b]) => b === "slow" && t - t0 > 6000).map(([, , a]) => a);
  assert.ok(late.length && Math.max(...late) === 1, `late concurrency ${late}`);
  await ctx.close();
});

test("ready-made thumbnails are used instead of resizing", async () => {
  const { ctx, page } = await openApp({ shelf: ["thumbs"] });
  await hover(page, 0, 2000);
  const urls = Object.keys(iiif.stats().urls).filter((u) => u.includes("/thumbs/"));
  assert.ok(urls.length > 10 && urls.every((u) => u.startsWith("/thumb/")), "only thumbnails requested");
  await ctx.close();
});

test("hidden tab: playback stops and requests pause", async () => {
  const { ctx, page } = await openApp({ shelf: ["plain"] });
  await page.locator(".card-cover").first().click();
  await sleep(400);
  await page.click("#play-btn");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(500);
  const before = iiif.stats().images;
  await sleep(2000);
  assert.equal(iiif.stats().images, before);
  assert.match(await page.textContent("#play-btn"), /Play/);
  await ctx.close();
});

test("reduced motion slows flash mode", async () => {
  const { ctx, page } = await openApp({ shelf: ["plain"], context: { reducedMotion: "reduce" } });
  await hover(page, 0, 2000);
  await page.check("#flash-toggle", { force: true });
  const seen = new Set();
  for (let k = 0; k < 12; k++) {
    seen.add(await page.getAttribute(".card-img", "src"));
    await sleep(250);
  }
  assert.ok(seen.size <= 3, `at most a couple of flips in 3s (saw ${seen.size})`);
  await ctx.close();
});

test("touch: dragging scrubs, tapping opens", async () => {
  const { ctx, page } = await openApp({ shelf: ["plain"], context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } });
  const cover = page.locator(".card-cover").first();
  await cover.scrollIntoViewIfNeeded();
  await sleep(300);
  const b = await cover.boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const y = b.y + b.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x + 5, y }] });
  await sleep(1200);
  for (let f = 0.1; f <= 0.9; f += 0.2) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: b.x + b.width * f, y }] });
    await sleep(60);
  }
  const counter = await cover.locator(".counter").textContent();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.ok(pageOf(counter) > 30, `dragged deep into the book: ${counter}`);
  assert.equal(await page.evaluate(() => document.querySelector("#viewer").open), false);
  await cover.tap();
  await sleep(400);
  assert.equal(await page.evaluate(() => document.querySelector("#viewer").open), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no sideways scroll");
  await ctx.close();
});

test("baked shelf: hovering and flash mode cost the image server nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baked-"));
  await bake([{ title: "plain", input: iiif.manifest("plain") }], { outDir: dir, delayMs: 0, log: () => {} });
  bakedApp = await startStatic(ROOT, { bakedDir: dir });
  iiif.reset();
  const { ctx, page } = await openApp({ shelf: ["plain"], origin: bakedApp.origin });
  await hover(page, 0, 1500);
  await page.check("#flash-toggle", { force: true });
  await sleep(1500);
  assert.equal(iiif.stats().images, 0);
  await ctx.close();
});

test("a hung image request is abandoned and retried, so it can't block the server's queue", async () => {
  iiif.reset();
  const t0 = Date.now();
  const { ctx, page, errors } = await openApp({ shelf: ["stall"], stallMs: 500, waitReady: false });
  await page.waitForSelector(".card .card-img.is-ready", { timeout: 8000 });
  assert.ok(Date.now() - t0 < 8000);
  // The cover was asked for twice: the hung attempt, then the retry that worked.
  const coverHits = Object.entries(iiif.stats().urls).filter(([u]) => /\/stall\/p0\//.test(u));
  assert.deepEqual(coverHits.map(([, n]) => n), [2]);
  // Hovering still loads the rest of the book despite every first request
  // hanging (stalled requests retry after the rest of the queue).
  await hover(page, 0, 7000);
  const loaded = await page.locator(".card .ticks i.is-loaded").count();
  assert.ok(loaded >= 4, `frames loaded after stalls: ${loaded}`);
  assert.equal(await page.locator(".card-error:not([hidden])").count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
