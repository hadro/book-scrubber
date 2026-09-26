// Minimal IIIF helpers: turn "whatever the user pasted" into a manifest URL,
// then flatten Presentation v2 or v3 manifests into a simple list of pages.

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const idOf = (o) => (o && typeof o === "object" ? o.id || o["@id"] : o);

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

/**
 * Given a pasted string (manifest URL, catalog page URL, or bare identifier),
 * return an ordered list of manifest URLs worth trying.
 */
export function resolveInput(raw) {
  const input = (raw || "").trim();
  if (!input) return [];

  // Bare Internet Archive identifier (no slashes, no spaces, no scheme).
  if (/^[A-Za-z0-9._-]+$/.test(input) && !input.includes("..")) {
    return [iaManifest(input)];
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    return [];
  }
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;

  // Viewer links (Universal Viewer, Mirador, Theseus...) usually carry the
  // manifest in a query parameter: use it directly.
  for (const key of ["manifest", "iiif-content", "iiif_manifest", "manifestUri"]) {
    const v = url.searchParams.get(key);
    if (!v) continue;
    if (/^https?:\/\//.test(v)) return resolveInput(v);
    const decoded = contentStateManifest(v);
    if (decoded) return resolveInput(decoded);
  }
  let m;

  // Internet Archive: /details/{id}, /embed/{id}, /stream/{id}
  if (host === "archive.org" && (m = path.match(/^\/(?:details|embed|stream)\/([^/?#]+)/))) {
    return [iaManifest(decodeURIComponent(m[1]))];
  }

  // Library of Congress: /item/{id}/ or /resource/{id}/ pages
  if (host === "loc.gov" && !path.endsWith("manifest.json")) {
    if ((m = path.match(/^\/item\/([^/]+)/))) {
      return [`https://www.loc.gov/item/${m[1]}/manifest.json`];
    }
  }

  // NYPL Digital Collections item page -> manifest API
  if (host === "digitalcollections.nypl.org" && (m = path.match(/^\/items\/([0-9a-f-]{36})/i))) {
    return [`https://api-collections.nypl.org/manifests/${m[1]}`];
  }

  // Biodiversity Heritage Library doesn't serve item manifests at a predictable
  // address (see inputHint); its scans live at the Internet Archive instead.
  if (host === "biodiversitylibrary.org" && !path.includes("manifest")) return [];

  // e-codices viewer page: /en/list/one/csg/0390  or /en/csg/0390/1r/0/
  if (host === "e-codices.unifr.ch" && !path.includes("/metadata/iiif/")) {
    const segs = path.split("/").filter(Boolean);
    if (/^[a-z]{2}$/.test(segs[0])) segs.shift();
    if (segs[0] === "list" && segs[1] === "one") segs.splice(0, 2);
    if (segs.length >= 2) {
      return [`https://www.e-codices.unifr.ch/metadata/iiif/${segs[0]}-${segs[1]}/manifest.json`];
    }
  }

  // National Gallery of Art Library catalog record: docid=alma{MMS id}
  if (host === "library.nga.gov" && (m = (url.searchParams.get("docid") || "").match(/^alma(\d+)$/))) {
    return [`https://libraryimage.nga.gov/manifest/mms/${m[1]}.json`];
  }

  // Getty object pages use a short id that can't be mapped to the manifest's
  // UUID without reading the page itself (see inputHint).
  if (host === "getty.edu" && path.startsWith("/art/collection/object")) return [];

  // Wellcome Collection work page can't be mapped without their catalogue API,
  // but a bare b-number link to their IIIF server is fine as-is.

  return [url.toString()];
}

/**
 * IIIF Content State: a (usually base64url-encoded) JSON description of what to
 * open, as used by drag-and-drop links. Returns the manifest (or collection)
 * URL it points at, or null.
 */
export function contentStateManifest(value) {
  let json = null;
  const tryParse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };
  json = tryParse(value);
  if (!json) {
    try {
      const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
      json = tryParse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch {
      return null;
    }
  }
  if (!json) return null;
  const isResource = (o) => o && typeof o === "object" && /Manifest|Collection/.test(o.type || o["@type"] || "");
  const find = (o) => {
    if (!o || typeof o !== "object") return null;
    if (isResource(o)) return idOf(o);
    for (const k of ["target", "partOf", "within"]) {
      for (const t of asArray(o[k])) {
        const hit = typeof t === "string" ? null : find(t);
        if (hit) return hit;
      }
    }
    return null;
  };
  return find(json);
}

/**
 * The human-facing item page for a manifest or catalog URL, when the pattern is
 * known (or when the URL already is a web page rather than a manifest).
 */
export function itemPageFromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return /^[A-Za-z0-9._-]+$/.test(raw || "") ? `https://archive.org/details/${raw}` : null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;
  let m;
  if (host === "iiif.archive.org" && (m = path.match(/^\/iiif\/(?:3\/)?([^/]+)\/manifest\.json$/))) {
    return `https://archive.org/details/${m[1]}`;
  }
  if (host === "loc.gov" && (m = path.match(/^\/item\/([^/]+)\/manifest\.json$/))) return `https://www.loc.gov/item/${m[1]}/`;
  if (host === "api-collections.nypl.org" && (m = path.match(/^\/manifests\/([0-9a-f-]{36})/i))) {
    return `https://digitalcollections.nypl.org/items/${m[1]}`;
  }
  if (host === "e-codices.unifr.ch" && (m = path.match(/\/metadata\/iiif\/([a-z]+)-([^/]+)\/manifest\.json$/))) {
    return `https://www.e-codices.unifr.ch/en/list/one/${m[1]}/${m[2]}`;
  }
  if (host === "libraryimage.nga.gov" && (m = path.match(/^\/manifest\/mms\/(\d+)\.json$/))) {
    return `https://library.nga.gov/discovery/fulldisplay?vid=01NGA_INST:NGA&docid=alma${m[1]}`;
  }
  if (host === "collections.library.yale.edu" && (m = path.match(/^\/manifests\/(\d+)/))) {
    return `https://collections.library.yale.edu/catalog/${m[1]}`;
  }
  // Not a manifest-looking address: it's probably the item page itself.
  if (!/manifest|\/iiif\/|\.json$/i.test(path + url.search)) return url.toString();
  return null;
}

export const iaManifest = (id) => `https://iiif.archive.org/iiif/3/${id}/manifest.json`;

/** A friendlier explanation for inputs we know can't be resolved directly. */
export function inputHint(raw) {
  if (/biodiversitylibrary\.org/.test(raw || "")) {
    return "BHL doesn't publish IIIF manifests at a predictable address, but nearly all of its scans also live at the Internet Archive. On the BHL item page, follow the \"View at Internet Archive\" (or download) link and paste that archive.org address instead.";
  }
  if (/getty\.edu\/art\/collection\/object/.test(raw || "")) {
    return "Getty object pages don't reveal their manifest address to other websites. On the object page, click the IIIF logo (or the \"IIIF Manifest\" link) and paste the media.getty.edu/iiif/manifest/… address it points to.";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Try each candidate URL in turn; return {url, json} for the first that works. */
export async function fetchFirstManifest(candidates, { signal } = {}) {
  const errors = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: "application/ld+json, application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return { url, json };
    } catch (err) {
      if (err.name === "AbortError") throw err;
      errors.push(`${url}: ${err.message}`);
    }
  }
  const e = new Error(errors.length ? errors.join("\n") : "Nothing to fetch");
  e.name = "ManifestError";
  throw e;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Language-map / string / array label -> plain string. */
export function labelText(label) {
  if (label == null) return "";
  if (typeof label === "string") return label;
  if (Array.isArray(label)) return label.map(labelText).filter(Boolean).join(" ");
  if (typeof label === "object") {
    if ("@value" in label) return String(label["@value"]);
    const langs = Object.keys(label);
    const pick = label.en || label.none || label[langs[0]];
    return labelText(pick);
  }
  return String(label);
}

function describeService(svc) {
  const s = asArray(svc).find((x) => x && typeof x === "object");
  if (!s) return null;
  const id = idOf(s);
  if (!id) return null;
  const type = s.type || s["@type"] || "";
  const ctx = s["@context"] || "";
  const profile = JSON.stringify(s.profile || "");
  let version = 2;
  if (/ImageService3/.test(type) || /image\/3/.test(ctx)) version = 3;
  const level = /level0/.test(profile) ? 0 : 2;
  return {
    id: id.replace(/\/info\.json$/, "").replace(/\/$/, ""),
    version,
    level,
    width: s.width || null,
    height: s.height || null,
    sizes: Array.isArray(s.sizes) ? s.sizes.filter((z) => z && z.width) : null,
  };
}

/** A canvas thumbnail as {url, width, height}, if the manifest offers one. */
function describeThumb(thumb) {
  const t = asArray(thumb)[0];
  if (!t) return null;
  const url = idOf(t);
  if (!url) return null;
  return { url, width: (t && t.width) || null, height: (t && t.height) || null };
}

const WEB_IMAGE = /^image\/(jpeg|png|gif|webp)/;
const IIIF_IMAGE_URL = /^(https?:\/\/.+?)\/full\/[^/]+\/\d+(?:\.\d+)?\/(?:default|native|color|gray|bitonal)\.(?:jpg|jpeg|png|gif|webp)(?:\?.*)?$/i;

/** From several alternative images (a IIIF Choice), pick one a browser can show. */
function pickChoice(items) {
  const opts = asArray(items).filter(Boolean);
  return (
    opts.find((o) => o.service) ||
    opts.find((o) => WEB_IMAGE.test(o.format || "")) ||
    opts.find((o) => IIIF_IMAGE_URL.test(idOf(o) || "")) ||
    opts[0]
  );
}

function makePage(canvas, body) {
  let service = describeService(body && body.service);
  // No service listed, but the image URL is itself a IIIF Image API request:
  // recover the service from it, so we can ask for small sizes.
  const direct = idOf(body);
  if (!service && direct && IIIF_IMAGE_URL.test(direct)) {
    service = { id: direct.match(IIIF_IMAGE_URL)[1], version: 2, level: 1, width: null, height: null, sizes: null };
  }
  return {
    label: labelText(canvas.label),
    width: canvas.width,
    height: canvas.height,
    // Pixel size of the actual image (not the canvas), when stated.
    imgWidth: (service && service.width) || (body && body.width) || null,
    imgHeight: (service && service.height) || (body && body.height) || null,
    service,
    imageUrl: idOf(body),
    thumb: describeThumb(canvas.thumbnail),
  };
}

function pageFromV2Canvas(canvas) {
  const image = asArray(canvas.images)[0];
  const res = image && image.resource;
  return makePage(canvas, res && (res.default || res));
}

function pageFromV3Canvas(canvas) {
  const page = asArray(canvas.items)[0];
  const anno = page && asArray(page.items)[0];
  let body = asArray(anno && anno.body)[0];
  if (body && body.type === "Choice") body = pickChoice(body.items);
  return makePage(canvas, body);
}

export const isCollection = (json) => /Collection/.test((json && (json.type || json["@type"])) || "");

/** The manifests listed directly in a IIIF Collection (v2 or v3), plus a count of sub-collections. */
export function collectionMembers(json) {
  const out = [];
  let subCollections = 0;
  const add = (m) => {
    const t = m.type || m["@type"] || "";
    if (/Collection/.test(t)) subCollections++;
    else if (/Manifest/.test(t) && idOf(m)) out.push({ id: idOf(m), label: labelText(m.label) });
  };
  asArray(json.items).forEach(add);
  asArray(json.manifests).forEach((m) => add({ "@type": "sc:Manifest", ...m }));
  asArray(json.members).forEach(add);
  subCollections += asArray(json.collections).length;
  return { label: labelText(json.label), manifests: out, subCollections };
}

/**
 * Some catalog records (multi-volume or multi-edition items, like many at LoC)
 * resolve to a Collection rather than a Manifest. Follow it to its first
 * manifest (through at most two levels of nesting).
 *
 * `fetchJson(url)` must resolve to { url, json }.
 * Resolves to { url, json, part } where part is null for a plain manifest, or
 * { collection, label, index, of } describing which part was picked.
 */
export async function followToManifest(first, fetchJson) {
  let { url, json } = first;
  let part = null;
  for (let depth = 0; isCollection(json) && depth < 3; depth++) {
    const { label, manifests } = collectionMembers(json);
    const nested = asArray(json.items).concat(asArray(json.collections)).find((m) => /Collection/.test(m.type || m["@type"] || ""));
    const next = manifests[0] || (nested && { id: idOf(nested), label: labelText(nested.label) });
    if (!next || !next.id) {
      const e = new Error("That collection doesn't list any items.");
      e.name = "ManifestError";
      throw e;
    }
    if (!part) part = { collection: label, label: next.label, index: 1, of: manifests.length || 1 };
    ({ url, json } = await fetchJson(next.id));
  }
  return { url, json, part };
}

/** Flatten a v2 or v3 manifest into {label, pages[], rtl, attribution}. */
export function parseManifest(json) {
  if (!json || typeof json !== "object") throw new Error("Not a JSON object");
  const type = json.type || json["@type"];
  if (/Collection/.test(type)) {
    const e = new Error("That's a IIIF Collection, not a single item. Paste one of its manifests instead.");
    e.name = "ManifestError";
    throw e;
  }

  let canvases, pages;
  if (Array.isArray(json.items)) {
    canvases = json.items.filter((c) => (c.type || "") === "Canvas");
    pages = canvases.map(pageFromV3Canvas);
  } else {
    const seq = asArray(json.sequences)[0];
    canvases = (seq && asArray(seq.canvases)) || [];
    pages = canvases.map(pageFromV2Canvas);
  }
  pages = pages.filter((p) => p.service || p.imageUrl);
  if (!pages.length) {
    const e = new Error("Found a manifest, but no page images in it.");
    e.name = "ManifestError";
    throw e;
  }

  const dir = json.viewingDirection || (asArray(json.sequences)[0] || {}).viewingDirection || "";
  const attribution = labelText(json.requiredStatement ? json.requiredStatement.value : json.attribution);

  const home = asArray(json.homepage)[0] || asArray(json.related).find((r) => !/json/.test((r && r.format) || ""));
  return {
    label: labelText(json.label) || "Untitled",
    homepage: (home && (typeof home === "string" ? home : idOf(home))) || null,
    pages,
    rtl: /right-to-left/.test(dir),
    attribution: attribution.replace(/<[^>]+>/g, "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Image URLs
// ---------------------------------------------------------------------------

/**
 * Two fixed widths for every request. Sticking to a couple of canonical sizes
 * means repeat visitors (and other IIIF viewers) are more likely to hit the
 * image server's cache instead of forcing a fresh resize from the master file.
 */
export const SMALL = 300;
export const BIG = 800;

function sizeUrl(svc, w, h) {
  // Canonical size syntax: "w,h" for Image API 3, "w," for 2. Caches key on
  // the exact URL, so matching what other viewers ask for means more hits.
  const size = svc.version === 3 && h ? `${w},${h}` : `${w},`;
  return `${svc.id}/full/${size}/0/default.jpg`;
}

/**
 * URL for a page image about `width` pixels wide, cheapest option first:
 *   1. a ready-made canvas thumbnail of roughly that size (often a static file),
 *   2. a size the image server advertises as pre-rendered,
 *   3. exactly `width`, in canonical form.
 * Falls back to the raw image URL when there's no usable Image API service.
 */
export function pageImageUrl(page, width) {
  const fits = (w) => w >= width * 0.8 && w <= width * 2.5;
  const t = page.thumb;
  if (t && t.width && fits(t.width)) return t.url;

  const svc = page.service;
  if (svc) {
    if (svc.sizes && svc.sizes.length) {
      const sorted = [...svc.sizes].sort((a, b) => a.width - b.width);
      const fit = sorted.find((z) => z.width >= width * 0.8);
      if (fit && fits(fit.width)) return sizeUrl(svc, fit.width, fit.height);
      if (svc.level === 0) {
        const z = fit || sorted[sorted.length - 1];
        return sizeUrl(svc, z.width, z.height);
      }
    }
    if (svc.level !== 0) {
      const W = page.imgWidth;
      const H = page.imgHeight;
      const w = W ? Math.min(width, W) : width;
      const h = W && H ? Math.round((w * H) / W) : null;
      return sizeUrl(svc, w, h);
    }
  }
  return (
    (width <= SMALL && t && t.url) ||
    page.imageUrl ||
    (svc && `${svc.id}/full/${svc.version === 3 ? "max" : "full"}/0/default.jpg`)
  );
}

/** Pick `n` evenly spaced indices from [0, total). Always includes first and last. */
export function sampleIndices(total, n) {
  if (total <= n) return Array.from({ length: total }, (_, i) => i);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((i * (total - 1)) / (n - 1)));
  return [...new Set(out)];
}

/**
 * Order in which to preload frames so a coarse version of the whole book is
 * scrubbable quickly: ends first, then middle, then quarters, eighths...
 */
export function bisectionOrder(n) {
  if (n <= 0) return [];
  const seen = new Set();
  const out = [];
  const push = (i) => {
    if (i >= 0 && i < n && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  };
  push(0);
  push(n - 1);
  for (let step = n; step >= 1; step = Math.floor(step / 2)) {
    for (let i = Math.floor(step / 2); i < n; i += Math.max(step, 1)) push(i);
    if (step === 1) break;
  }
  for (let i = 0; i < n; i++) push(i);
  return out;
}
