#!/usr/bin/env node
// Pre-bake the example shelf: fetch each example's manifest once, download its
// sampled 300px page thumbnails, and save them under baked/. The site then
// serves the shelf's hover-scrubbing from these local files, so visitors cost
// the libraries' image servers nothing until they open a book or paste their own.
//
//   node scripts/bake-examples.mjs            # bake anything not yet baked
//   node scripts/bake-examples.mjs --force    # re-bake everything
//
// Requests go one at a time with a pause between them.

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLES } from "../js/examples.js";
import { resolveInput, followToManifest, parseManifest, pageImageUrl, sampleIndices, SMALL } from "../js/iiif.js";

export const BAKED_FRAMES = 24;
const USER_AGENT = "book-scrubber example baker (https://github.com/hadro/book-scrubber)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const slugFor = (input) =>
  input
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .toLowerCase();

const extFor = (type) => (/png/.test(type) ? "png" : /gif/.test(type) ? "gif" : /webp/.test(type) ? "webp" : /svg/.test(type) ? "svg" : "jpg");

async function fetchWithRetry(fetchImpl, url, opts, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetchImpl(url, opts);
      if (res.ok) return res;
      if (i >= tries || (res.status < 500 && res.status !== 429)) throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (i >= tries) throw err;
    }
    await sleep(2000 * i);
  }
}

/**
 * Bake `examples` into `outDir`. Returns the index object that was written.
 * Examples that fail keep whatever was baked for them before.
 */
export async function bake(examples, { outDir, fetchImpl = fetch, force = false, delayMs = 400, log = console.log } = {}) {
  const indexPath = join(outDir, "index.json");
  let index = { frames: BAKED_FRAMES, items: {} };
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {}
  const headers = { "User-Agent": USER_AGENT, Accept: "application/ld+json, application/json, image/*" };

  for (const ex of examples) {
    if (!force && index.items[ex.input]) {
      log(`skip  ${ex.title || ex.input} (already baked)`);
      continue;
    }
    const slug = slugFor(ex.input);
    try {
      let manifestUrl, json;
      for (const url of resolveInput(ex.input)) {
        try {
          json = await (await fetchWithRetry(fetchImpl, url, { headers })).json();
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
        json: await (await fetchWithRetry(fetchImpl, u, { headers })).json(),
      })));
      const m = parseManifest(json);
      const pages = sampleIndices(m.pages.length, BAKED_FRAMES);

      const dir = join(outDir, slug);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const files = [];
      for (let k = 0; k < pages.length; k++) {
        await sleep(delayMs);
        const res = await fetchWithRetry(fetchImpl, pageImageUrl(m.pages[pages[k]], SMALL), { headers });
        const name = `${String(k).padStart(2, "0")}.${extFor(res.headers.get("content-type") || "")}`;
        await writeFile(join(dir, name), Buffer.from(await res.arrayBuffer()));
        files.push(`baked/${slug}/${name}`);
      }

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
      };
      log(`baked ${ex.title || ex.input}: ${files.length} frames from ${m.pages.length} pages`);
    } catch (err) {
      log(`FAIL  ${ex.title || ex.input}: ${err.message}`);
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
