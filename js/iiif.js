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

  // Wellcome Collection work page can't be mapped without their catalogue API,
  // but a bare b-number link to their IIIF server is fine as-is.

  return [url.toString()];
}

export const iaManifest = (id) => `https://iiif.archive.org/iiif/3/${id}/manifest.json`;

/** A friendlier explanation for inputs we know can't be resolved directly. */
export function inputHint(raw) {
  if (/biodiversitylibrary\.org/.test(raw || "")) {
    return "BHL doesn't publish IIIF manifests at a predictable address, but nearly all of its scans also live at the Internet Archive. On the BHL item page, follow the \"View at Internet Archive\" (or download) link and paste that archive.org address instead.";
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
  const s = asArray(svc).find((x) => x && typeof x === "object") ;
  if (!s) return null;
  const id = idOf(s);
  if (!id) return null;
  const type = s.type || s["@type"] || "";
  const ctx = s["@context"] || "";
  const profile = JSON.stringify(s.profile || "");
  let version = 2;
  if (/ImageService3/.test(type) || /image\/3/.test(ctx)) version = 3;
  let level = 2;
  if (/level0/.test(profile) || /level0/.test(String(s.profile || ""))) level = 0;
  return { id: id.replace(/\/info\.json$/, "").replace(/\/$/, ""), version, level, sizes: s.sizes || null };
}

function pageFromV2Canvas(canvas) {
  const image = asArray(canvas.images)[0];
  const res = image && image.resource;
  const choice = res && (res.default || res);
  return {
    label: labelText(canvas.label),
    width: canvas.width,
    height: canvas.height,
    service: describeService(choice && choice.service),
    imageUrl: idOf(choice),
    thumbnail: idOf(asArray(canvas.thumbnail)[0]),
  };
}

function pageFromV3Canvas(canvas) {
  const page = asArray(canvas.items)[0];
  const anno = page && asArray(page.items)[0];
  let body = anno && anno.body;
  body = asArray(body)[0];
  if (body && body.type === "Choice") body = asArray(body.items)[0];
  return {
    label: labelText(canvas.label),
    width: canvas.width,
    height: canvas.height,
    service: describeService(body && body.service),
    imageUrl: idOf(body),
    thumbnail: idOf(asArray(canvas.thumbnail)[0]),
  };
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

  return {
    label: labelText(json.label) || "Untitled",
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

/**
 * URL for a page image `width` pixels wide (width-only IIIF size, "w,").
 * Falls back to the raw image URL when there's no usable Image API service.
 */
export function pageImageUrl(page, width) {
  const svc = page.service;
  if (svc && svc.level !== 0) {
    return `${svc.id}/full/${width},/0/default.jpg`;
  }
  if (svc && svc.level === 0 && Array.isArray(svc.sizes) && svc.sizes.length) {
    // Level 0 servers only serve pre-made sizes: pick the smallest that's wide enough.
    const sorted = [...svc.sizes].sort((a, b) => a.width - b.width);
    const fit = sorted.find((s) => s.width >= width) || sorted[sorted.length - 1];
    return `${svc.id}/full/${fit.width},${svc.version === 3 ? fit.height : ""}/0/default.jpg`;
  }
  return (width <= SMALL && page.thumbnail) || page.imageUrl || (svc && `${svc.id}/full/full/0/default.jpg`);
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
