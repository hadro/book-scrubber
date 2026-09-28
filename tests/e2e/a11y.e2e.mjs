// Accessibility audit: axe-core (WCAG 2.0/2.1/2.2 A and AA rules) against every
// state of the app, in light and dark themes and at phone width, plus checks
// axe can't do on its own (reflow, target size, keyboard reachability).
// Run with `npm run test:e2e`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startStatic, startFakeIiif } from "./servers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const AXE = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app, iiif, browser;

before(async () => {
  iiif = await startFakeIiif();
  app = await startStatic(ROOT);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await app?.close();
  await iiif?.close();
});

async function openApp({ scheme = "light", width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, serviceWorkers: "block" });
  const inputs = [iiif.manifest("plain"), iiif.manifest("mixed"), `${iiif.origin}/m/missing.json`];
  await ctx.addInitScript((s) => localStorage.setItem("flipbook:shelf", JSON.stringify(s)), inputs);
  const page = await ctx.newPage();
  await page.goto(`${app.origin}/?examples=0`);
  // Covers only load near the viewport, which on a phone is below the masthead.
  await page.locator(".card").first().scrollIntoViewIfNeeded();
  await page.waitForSelector(".card .card-img.is-ready");
  // The broken book's card only loads once it's near the viewport.
  await page.locator(".card").nth(2).scrollIntoViewIfNeeded();
  await page.waitForSelector(".card-error:not([hidden])");
  await page.evaluate(() => scrollTo(0, 0));
  return { ctx, page };
}

/** Run axe; return violations as short readable lines. */
async function audit(page, label) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")}: ${(n.failureSummary || "").split("\n").slice(1, 2).join(" ").trim()}`),
      count: v.nodes.length,
    }));
  }, TAGS);
  return result.map((v) => `[${label}] ${v.id} (${v.impact}, ${v.count}x): ${v.help}\n    ${v.nodes.join("\n    ")}`);
}

async function openViewer(page) {
  await page.locator(".card-cover").first().click();
  await page.waitForFunction(() => /p\. \d+ \//.test(document.querySelector("#stage-counter").textContent));
}

for (const scheme of ["light", "dark"]) {
  test(`axe: shelf, viewer and export result (${scheme})`, async () => {
    const { ctx, page } = await openApp({ scheme });
    const problems = [...(await audit(page, `${scheme} shelf`))];
    await page.fill("#paste-input", "not a link");
    await page.click("#paste-form button[type=submit]");
    await page.waitForSelector(".paste-status.is-error");
    problems.push(...(await audit(page, `${scheme} paste error`)));
    await openViewer(page);
    problems.push(...(await audit(page, `${scheme} viewer`)));
    await page.click("#gif-btn");
    await page.waitForSelector("#gif-result:not([hidden])", { timeout: 30000 });
    problems.push(...(await audit(page, `${scheme} export result`)));
    await ctx.close();
    assert.deepEqual(problems, [], "\n" + problems.join("\n"));
  });
}

test("axe: phone width (320px) shelf and viewer, no sideways scrolling (reflow)", async () => {
  const { ctx, page } = await openApp({ width: 320, height: 640 });
  const problems = [...(await audit(page, "320px shelf"))];
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "shelf reflows at 320px");
  await openViewer(page);
  problems.push(...(await audit(page, "320px viewer")));
  const dialogOverflow = await page.evaluate(() => {
    const d = document.querySelector("#viewer");
    return d.scrollWidth > d.clientWidth + 1;
  });
  assert.equal(dialogOverflow, false, "viewer reflows at 320px");
  await ctx.close();
  assert.deepEqual(problems, [], "\n" + problems.join("\n"));
});

/** Targets smaller than 24×24 px that also crowd a neighbor (WCAG 2.5.8). */
const smallTargets = (page) =>
  page.evaluate(() => {
    // With a modal open, the page behind it is inert, so only the dialog's targets count.
    const scope = document.querySelector("dialog[open]") || document;
    const els = [...scope.querySelectorAll("button, a[href], input, select, [tabindex]:not([tabindex='-1'])")].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
    const rects = els.map((e) => {
      // A checkbox/radio inside a label is operated through the whole label.
      const target = e.matches("input[type=checkbox]") && e.closest("label") ? e.closest("label") : e;
      return { e, r: target.getBoundingClientRect() };
    });
    const out = [];
    for (const { e, r } of rects) {
      if (r.width >= 23.5 && r.height >= 23.5) continue; // allow sub-pixel rounding
      if (e.closest("p, li") && e.matches("a") && getComputedStyle(e).display === "inline") continue; // inline text links are exempt
      // Spacing exception: a 24px circle centered on the target must not overlap another target.
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const clash = rects.some((o) => o.e !== e && o.r.width && Math.hypot(Math.max(o.r.x - cx, 0, cx - (o.r.x + o.r.width)), Math.max(o.r.y - cy, 0, cy - (o.r.y + o.r.height))) < 12);
      if (clash) out.push(`${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}.${[...e.classList].join(".")} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });

test("target size: interactive elements are at least 24×24 px or spaced as WCAG 2.5.8 allows", async () => {
  const { ctx, page } = await openApp();
  const small = (await smallTargets(page)).map((t) => `shelf: ${t}`);
  await openViewer(page);
  small.push(...(await smallTargets(page)).map((t) => `viewer: ${t}`));
  await ctx.close();
  assert.deepEqual(small, []);
});

test("keyboard: every control can be reached with Tab, in the viewer too", async () => {
  const { ctx, page } = await openApp();
  const reached = new Set();
  for (let k = 0; k < 40; k++) {
    await page.keyboard.press("Tab");
    reached.add(await page.evaluate(() => document.activeElement.id || document.activeElement.className));
  }
  assert.ok([...reached].some((x) => /card-cover/.test(x)), "cards are focusable");
  assert.ok(reached.has("paste-input") && reached.has("flash-toggle") && reached.has("plates-toggle"), [...reached].join(", "));
  await page.focus(".card-cover");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#viewer").open);
  const inViewer = new Set();
  for (let k = 0; k < 25; k++) {
    await page.keyboard.press("Tab");
    // Tabbing past the last control may move focus to the browser's own UI (body), which is fine;
    // what must not happen is focus landing on page content behind the modal.
    inViewer.add(
      await page.evaluate(() => {
        const a = document.activeElement;
        if (a === document.body) return "browser";
        return document.querySelector("#viewer").contains(a) ? a.id || a.className : "OUTSIDE";
      })
    );
  }
  assert.ok(!inViewer.has("OUTSIDE"), "focus stays in the open viewer");
  for (const id of ["stage-range", "prev-btn", "play-btn", "next-btn", "gif-btn", "gif-format"]) assert.ok(inViewer.has(id), `viewer control #${id} reachable`);
  await ctx.close();
});
