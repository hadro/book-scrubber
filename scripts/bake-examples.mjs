#!/usr/bin/env node
// Pre-bake the example shelf: fetch each example's manifest once, download its
// sampled 300px page thumbnails, and save them under baked/. The site then
// serves the shelf's hover-scrubbing from these local files, so visitors cost
// the libraries' image servers nothing until they open a book or paste their own.
//
//   node scripts/bake-examples.mjs            # bake anything not yet (fully) baked
//   node scripts/bake-examples.mjs --force    # re-bake everything
//
// Requests go one at a time with a pause between them. A page image that
// won't load is skipped: a book with at least half its frames is saved and
// marked `partial`, and the next run fetches only the missing frames. Each
// book is baked into a temporary folder and swapped in only when it
// succeeds, so a failed re-bake never loses what was there.

import { mkdir, readFile, writeFile, rm, rename, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLES } from "../js/examples.js";
import { resolveInput, followToManifest, parseManifest, pageImageUrl, sampleIndices, SMALL } from "../js/iiif.js";

export const BAKED_FRAMES = 24;
const USER_AGENT = "flipbook example baker (https://github.com/hadro/flipbook)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const slugFor = (input) =>
  input
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .toLowerCase();

const extFor = (type) => (/png/.test(type) ? "png" : /gif/.test(type) ? "gif" : /webp/.test(type) ? "webp" : /svg/.test(type) ? "svg" : "jpg");

/**
 * Fetch and read the whole body, retrying server errors and hangs. Each
 * attempt gets `timeoutMs`: some image servers (the Internet Archive's, now
 * and then) leave a request hanging for minutes while a fresh one is quick.
 * `urls` can list alternatives (the same image at another size); attempts
 * take them in turn. The response's `from` says which one worked.
 */
async function fetchWithRetry(fetchImpl, urls, opts, { tries = 3, timeoutMs = 30000, retryDelayMs = 2000 } = {}) {
  urls = [].concat(urls);
  for (let i = 1; ; i++) {
    const url = urls[(i - 1) % urls.length];
    try {
      const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return Object.assign(new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers }), { from: url });
      // A client error is final, unless there's another URL left to try.
      const retryable = res.status >= 500 || res.status === 429 || urls.length > 1;
      if (i >= tries || !retryable) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { final: true });
    } catch (err) {
      if (err.final) throw err;
      if (i >= tries) throw err.name === "TimeoutError" ? new Error(`no response after ${timeoutMs / 1000} s, ${tries} times, for ${url}`) : err;
    }
    await sleep(retryDelayMs * i);
  }
}

/**
 * Bake `examples` into `outDir`. Returns the index object that was written.
 * Examples that fail keep whatever was baked for them before.
 */
export async function bake(examples, { outDir, fetchImpl = fetch, force = false, delayMs = 400, retryDelayMs = 2000, timeoutMs = 30000, log = console.log } = {}) {
  const get = (url, opts, tries) => fetchWithRetry(fetchImpl, url, opts, { timeoutMs, retryDelayMs, tries });
  const indexPath = join(outDir, "index.json");
  let index = { frames: BAKED_FRAMES, items: {} };
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {}
  const headers = { "User-Agent": USER_AGENT, Accept: "application/ld+json, application/json, image/*" };

  for (const ex of examples) {
    const prev = index.items[ex.input];
    if (!force && prev && !prev.partial) {
      log(`skip  ${ex.title || ex.input} (already baked)`);
      continue;
    }
    const slug = slugFor(ex.input);
    const dir = join(outDir, slug);
    const tmp = join(outDir, `.${slug}.tmp`);
    try {
      let manifestUrl, json;
      for (const url of resolveInput(ex.input)) {
        try {
          json = await (await get(url, { headers })).json();
          manifestUrl = url;
          break;
        } catch (err) {
          log(`      ${url}: ${err.message}`);
        }
      }
      if (!json) throw new Error("no manifest could be fetched");
      // Multi-part records can be collections: use the first part, like the site does.
      ({ url: manifestUrl, json } = await followToManifest({ url: manifestUrl, json }, async (u) => ({
        url: u,
        json: await (await get(u, { headers })).json(),
      })));
      const m = parseManifest(json);
      const wanted = sampleIndices(m.pages.length, BAKED_FRAMES);
      const minFrames = Math.ceil(wanted.length / 2);

      // Frames a previous partial bake of the same book already has.
      const have = new Map();
      if (!force && prev && prev.total === m.pages.length) prev.pages.forEach((p, k) => have.set(p, prev.files[k]));

      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      const pages = [];
      const files = [];
      let missing = 0;
      let reused = 0;
      // Each page can also be fetched 1px wider: a different URL to the server,
      // so a request stuck on one (as the Internet Archive's sometimes are)
      // doesn't doom the page. Whichever size last worked goes first.
      let preferAlt = false;
      let usedAlt = 0;
      for (let k = 0; k < wanted.length; k++) {
        const prefix = String(k).padStart(2, "0");
        const old = have.get(wanted[k]);
        let name = old && `${prefix}.${old.split(".").pop()}`;
        if (old) await copyFile(join(outDir, old.replace(/^baked\//, "")), join(tmp, name)).then(() => reused++, () => (name = null));
        if (!name) {
          await sleep(delayMs);
          try {
            const page = m.pages[wanted[k]];
            const main = pageImageUrl(page, SMALL);
            const alt = pageImageUrl(page, SMALL + 1);
            const urls = alt === main ? [main] : preferAlt ? [alt, main] : [main, alt];
            const res = await get(urls, { headers }, urls.length > 1 ? 4 : 3);
            preferAlt = res.from === alt && alt !== main;
            if (res.from !== main) usedAlt++;
            name =`${prefix}.${extFor(res.headers.get("content-type") || "")}`;
            await writeFile(join(tmp, name), Buffer.from(await res.arrayBuffer()));
          } catch (err) {
            log(`      page ${wanted[k] + 1}: ${err.message}`);
            // Give up early once there's no way to reach the minimum.
            if (++missing > wanted.length - minFrames) throw new Error(`too many page images failed (${missing} of ${wanted.length})`);
            continue;
          }
        }
        pages.push(wanted[k]);
        files.push(`baked/${slug}/${name}`);
      }

      // Swap the finished folder in; the old one stays until this point.
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      index.items[ex.input] = {
        label: m.label,
        total: m.pages.length,
        rtl: m.rtl,
        attribution: m.attribution,
        homepage: m.homepage,
        manifestUrl,
        pages,
        files,
        bakedAt: new Date().toISOString().slice(0, 10),
        ...(missing ? { partial: true } : {}),
      };
      log(
        `baked ${ex.title || ex.input}: ${files.length} of ${wanted.length} frames from ${m.pages.length} pages` +
          (reused ? ` (${reused} kept from last time)` : "") +
          (usedAlt ? ` (${usedAlt} at ${SMALL + 1}px, as ${SMALL}px got stuck)` : "") +
          (missing ? `; ${missing} missing, will retry next run` : "")
      );
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      log(`FAIL  ${ex.title || ex.input}: ${err.message}${prev ? " (keeping the previous bake)" : ""}`);
    }
    await mkdir(outDir, { recursive: true });
    await writeFile(indexPath, JSON.stringify(index, null, 1) + "\n");
  }
  return index;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  await bake(EXAMPLES, { outDir: join(root, "baked"), force: process.argv.includes("--force") });
}
