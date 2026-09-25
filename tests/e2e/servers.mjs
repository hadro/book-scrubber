// Test servers: the app itself (static files) and a fake IIIF server whose
// books misbehave in useful ways. Both listen on random local ports.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { v2Manifest, v3Manifest } from "../fixtures.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

/** Serve `root` as a static site. `/baked/*` can be redirected to another folder. */
export async function startStatic(root, { bakedDir = null } = {}) {
  const server = http.createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const base = bakedDir && path.startsWith("/baked/") ? bakedDir : root;
    const rel = bakedDir && path.startsWith("/baked/") ? path.slice("/baked".length) : path;
    const file = normalize(join(base, rel));
    if (!file.startsWith(normalize(base))) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  const origin = await listen(server);
  return { origin, close: () => new Promise((r) => server.close(r)) };
}

// Page artwork. "mixed" books cycle blank, text, text, plate, plate, plate.
const PAPER = "#ece2c8";
const svgPage = (kind, label) => {
  let body = "";
  if (kind === "text") {
    for (let y = 90; y < 720; y += 22) body += `<rect x="70" y="${y}" width="${420 + ((y * 7) % 40)}" height="9" fill="#8c8272"/>`;
  } else if (kind === "plate") {
    body = `<circle cx="300" cy="360" r="190" fill="#1f6fb0" stroke="#16130f" stroke-width="10"/><rect x="120" y="560" width="360" height="150" fill="#b8322a"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="${PAPER}"/>${body}<text x="20" y="790" font-size="12" fill="#b9ad98">${label}</text></svg>`;
};
const KINDS = ["blank", "text", "text", "plate", "plate", "plate"];

// name: [presentation version, pages, image behaviour]
const BOOKS = {
  plain: [3, 60, "ok"],
  oz: [2, 96, "ok"],
  mixed: [3, 120, "ok"],
  nostore: [3, 60, "nostore"],
  nocors: [3, 60, "nocors"],
  broken: [3, 60, "fail"],
  slow: [3, 40, "slow"],
  thumbs: [3, 40, "ok"],
  home: [3, 30, "ok"],
};

export async function startFakeIiif() {
  let stats;
  const reset = () =>
    (stats = { images: 0, manifests: 0, byBook: {}, urls: {}, active: {}, maxActive: {}, timeline: [] });
  reset();
  let origin;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer(async (req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*" };
    const u = new URL(req.url, origin);
    let m;
    if ((m = u.pathname.match(/^\/m\/(\w+)\.json$/)) && BOOKS[m[1]]) {
      stats.manifests++;
      const [v, n] = BOOKS[m[1]];
      const json = (v === 2 ? v2Manifest : v3Manifest)(n, { base: `${origin}/img/${m[1]}`, label: `Book ${m[1]}` });
      if (m[1] === "thumbs") json.items.forEach((c, i) => (c.thumbnail = [{ id: `${origin}/thumb/thumbs/p${i}.svg`, type: "Image", width: 280, height: 373 }]));
      if (m[1] === "home") json.homepage = [{ id: "https://library.example/items/home", type: "Text" }];
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      return res.end(JSON.stringify(json));
    }
    if (u.pathname === "/c/shelf.json") {
      stats.manifests++;
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      return res.end(
        JSON.stringify({
          "@context": "http://iiif.io/api/presentation/3/context.json",
          id: `${origin}/c/shelf.json`,
          type: "Collection",
          label: { en: ["A small collection"] },
          items: ["plain", "oz", "mixed"].map((b) => ({ id: `${origin}/m/${b}.json`, type: "Manifest", label: { en: [`Book ${b}`] } })),
        })
      );
    }
    if ((m = u.pathname.match(/^\/(img|thumb)\/(\w+)\/p(\d+)/)) && BOOKS[m[2]]) {
      const book = m[2];
      const page = Number(m[3]);
      const mode = BOOKS[book][2];
      stats.images++;
      stats.byBook[book] = (stats.byBook[book] || 0) + 1;
      stats.urls[u.pathname] = (stats.urls[u.pathname] || 0) + 1;
      stats.active[book] = (stats.active[book] || 0) + 1;
      stats.maxActive[book] = Math.max(stats.maxActive[book] || 0, stats.active[book]);
      stats.timeline.push([Date.now(), book, stats.active[book]]);
      await sleep(mode === "slow" ? 2500 : 120);
      stats.active[book]--;
      if (mode === "fail") return res.writeHead(500, cors).end("nope");
      const headers = { "Content-Type": "image/svg+xml", "Cache-Control": mode === "nostore" ? "no-store" : "public, max-age=3600" };
      if (mode !== "nocors") Object.assign(headers, cors);
      res.writeHead(200, headers);
      const kind = book === "mixed" ? KINDS[page % KINDS.length] : "plate";
      return res.end(svgPage(kind, `${book} p${page}`));
    }
    res.writeHead(404, cors).end();
  });
  origin = await listen(server);
  return {
    origin,
    manifest: (b) => `${origin}/m/${b}.json`,
    stats: () => stats,
    reset,
    kindOfPage: (page) => KINDS[page % KINDS.length],
    close: () => new Promise((r) => server.close(r)),
  };
}
