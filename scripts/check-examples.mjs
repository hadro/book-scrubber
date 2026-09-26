#!/usr/bin/env node
// Health check for the example shelf: can each manifest and a page image be
// fetched, and will the browser features work (CORS for GIFs, ready-made
// thumbnails/sizes for politeness)? Writes a Markdown table to the GitHub
// Actions job summary when run there, and exits non-zero if anything is broken.
//
//   node scripts/check-examples.mjs

import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EXAMPLES } from "../js/examples.js";
import { resolveInput, followToManifest, parseManifest, pageImageUrl, SMALL } from "../js/iiif.js";

const USER_AGENT = "flipbook example health check (https://github.com/hadro/book-scrubber)";
const SITE_ORIGIN = "https://hadro.github.io";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch with one retry after a pause on 5xx/429 (IIIF servers often time out on a first, uncached request). */
async function timed(fetchImpl, url, headers, { retryDelay = 5000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    const res = await fetchImpl(url, { headers });
    if (attempt >= 2 || !(res.status >= 500 || res.status === 429)) return { res, ms: Date.now() - t0, retried: attempt > 1 };
    await sleep(retryDelay);
  }
}

function describeStatus(status) {
  if (status === 403) return "HTTP 403 (refused; may be bot protection, so check it in a browser)";
  if (status === 504 || status === 502 || status === 503) return `HTTP ${status} (server timed out, even after a retry)`;
  return `HTTP ${status}`;
}

/** Check one example. Never throws; returns a row of findings. */
export async function checkExample(ex, { fetchImpl = fetch, retryDelay = 5000 } = {}) {
  const row = { title: ex.title || ex.input, ok: false, manifest: "", pages: "", image: "", cors: "", extras: "" };
  const headers = { "User-Agent": USER_AGENT, Accept: "application/ld+json, application/json" };
  let json, url;
  for (const candidate of resolveInput(ex.input)) {
    try {
      row.manifestUrl = candidate;
      const { res, ms, retried } = await timed(fetchImpl, candidate, headers, { retryDelay });
      if (!res.ok) {
        row.manifest = describeStatus(res.status);
        continue;
      }
      json = await res.json();
      url = candidate;
      row.manifest = `ok (${ms} ms${retried ? ", after a retry" : ""})`;
      break;
    } catch (err) {
      row.manifest = String(err.message || err).slice(0, 60);
    }
  }
  if (!json) return row;

  let m;
  try {
    const followed = await followToManifest({ url, json }, async (u) => ({ url: u, json: await (await fetchImpl(u, { headers })).json() }));
    if (followed.part) row.manifest += ` (collection: part 1 of ${followed.part.of})`;
    json = followed.json;
    url = followed.url;
    m = parseManifest(json);
  } catch (err) {
    row.manifest = `unusable: ${err.message}`;
    return row;
  }
  const version = Array.isArray(json.items) ? "v3" : "v2";
  row.title = ex.title || m.label;
  row.pages = `${m.pages.length} (${version})`;
  const withThumbs = m.pages.filter((p) => p.thumb).length;
  const withSizes = m.pages.filter((p) => p.service && p.service.sizes && p.service.sizes.length).length;
  row.extras = [withThumbs && `thumbnails ${withThumbs}/${m.pages.length}`, withSizes && `sizes ${withSizes}/${m.pages.length}`].filter(Boolean).join(", ") || "none";

  const img = pageImageUrl(m.pages[Math.min(1, m.pages.length - 1)], SMALL);
  try {
    row.sample = img;
    const { res, ms, retried } = await timed(fetchImpl, img, { "User-Agent": USER_AGENT, Origin: SITE_ORIGIN }, { retryDelay });
    const type = res.headers.get("content-type") || "?";
    if (!res.ok || !/^image\//.test(type)) {
      row.image = res.ok ? `not an image (${type})` : describeStatus(res.status);
      return row;
    }
    row.image = `ok (${ms} ms${retried ? ", after a retry" : ""})`;
    const acao = res.headers.get("access-control-allow-origin");
    row.cors = acao === "*" || acao === SITE_ORIGIN ? "yes" : "no (GIFs won't work)";
    row.ok = true;
  } catch (err) {
    row.image = String(err.message || err).slice(0, 60);
  }
  row.manifestUrl = url;
  return row;
}

export function toMarkdown(rows) {
  const lines = [
    "| | Example | Manifest | Pages | Image | CORS | Thumbnails/sizes |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.title} | ${r.manifest} | ${r.pages} | ${r.image} | ${r.cors} | ${r.extras} |`),
  ];
  const bad = rows.filter((r) => !r.ok).length;
  const samples = rows.filter((r) => r.manifestUrl).map((r) => `- ${r.title}: ${r.manifestUrl}${r.sample ? ` → ${r.sample}` : ""}`);
  return `## Example shelf health\n\n${bad ? `**${bad} of ${rows.length} examples are broken.**` : `All ${rows.length} examples work.`}\n\n${lines.join("\n")}\n\n<details><summary>Manifest and sample image URLs</summary>\n\n${samples.join("\n")}\n</details>\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = [];
  for (const ex of EXAMPLES) rows.push(await checkExample(ex));
  const md = toMarkdown(rows);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
}
