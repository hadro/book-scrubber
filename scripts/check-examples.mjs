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

const USER_AGENT = "book-scrubber example health check (https://github.com/hadro/book-scrubber)";
const SITE_ORIGIN = "https://hadro.github.io";

async function timed(fetchImpl, url, headers) {
  const t0 = Date.now();
  const res = await fetchImpl(url, { headers });
  return { res, ms: Date.now() - t0 };
}

/** Check one example. Never throws; returns a row of findings. */
export async function checkExample(ex, { fetchImpl = fetch } = {}) {
  const row = { title: ex.title || ex.input, ok: false, manifest: "", pages: "", image: "", cors: "", extras: "" };
  const headers = { "User-Agent": USER_AGENT, Accept: "application/ld+json, application/json" };
  let json, url;
  for (const candidate of resolveInput(ex.input)) {
    try {
      const { res, ms } = await timed(fetchImpl, candidate, headers);
      if (!res.ok) {
        row.manifest = `HTTP ${res.status}`;
        continue;
      }
      json = await res.json();
      url = candidate;
      row.manifest = `ok (${ms} ms)`;
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
    const { res, ms } = await timed(fetchImpl, img, { "User-Agent": USER_AGENT, Origin: SITE_ORIGIN });
    row.sample = img;
    const type = res.headers.get("content-type") || "?";
    if (!res.ok || !/^image\//.test(type)) {
      row.image = `HTTP ${res.status} ${type}`;
      return row;
    }
    row.image = `ok (${ms} ms)`;
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
  const samples = rows.filter((r) => r.sample).map((r) => `- ${r.title}: ${r.manifestUrl || ""} → ${r.sample}`);
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
