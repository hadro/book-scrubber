// Exports: animated GIF, short video, and contact sheet. All three draw page
// images onto a canvas, so the image server must allow CORS (or the images must
// be same-origin, like the baked shelf).

import { GIFEncoder, quantize, applyPalette } from "../vendor/gifenc.esm.js";

export function corsError() {
  const e = new Error(
    "This library's image server doesn't let other websites re-use its images (no CORS headers), so this can't be made in the browser for this item. Scrubbing still works!"
  );
  e.name = "CorsError";
  return e;
}

function loadCorsImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't load ${url}`));
    img.src = url;
  });
}

function loadsWithoutCors(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

const checkAbort = (signal) => {
  if (signal && signal.aborted) throw new DOMException("Canceled", "AbortError");
};

/** Load page images one at a time (gentle on the server), skipping broken ones. */
export async function loadFrames(urls, { onProgress, signal } = {}) {
  const images = [];
  for (let i = 0; i < urls.length; i++) {
    checkAbort(signal);
    onProgress && onProgress(i, urls.length);
    try {
      images.push(await loadCorsImage(urls[i]));
    } catch {
      // Tell "server forbids cross-origin reuse" apart from "image is broken".
      if (await loadsWithoutCors(urls[i])) throw corsError();
    }
  }
  if (!images.length) throw new Error("None of the pages could be loaded.");
  return images;
}

/** Height of the credit band for a given output width. */
export const creditHeight = (width) => Math.max(16, Math.round(width * 0.055));

function drawPage(ctx, img, x, y, w, h, background) {
  ctx.fillStyle = background;
  ctx.fillRect(x, y, w, h);
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawCredit(ctx, text, x, y, w, h) {
  ctx.fillStyle = "#16130f";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#fffaf0";
  ctx.font = `600 ${Math.round(h * 0.52)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = "middle";
  const pad = Math.round(h * 0.4);
  let t = text;
  while (t.length > 4 && ctx.measureText(t).width > w - pad * 2) t = t.slice(0, -2);
  if (t !== text) t = t.replace(/\s*\S?$/, "") + "…";
  ctx.fillText(t, x + pad, y + h / 2 + 1);
}

function frameCanvas(width, height, credit) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height + (credit ? creditHeight(width) : 0);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const draw = (img) => {
    drawPage(ctx, img, 0, 0, width, height, BG.value);
    if (credit) drawCredit(ctx, credit, 0, height, width, creditHeight(width));
  };
  return { canvas, ctx, draw };
}

const BG = { value: "#f6efe2" };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Animated GIF. */
export async function encodeGif(images, { width, height, delay, background, credit, onProgress, signal }) {
  BG.value = background || BG.value;
  const { canvas, ctx, draw } = frameCanvas(width, height, credit);
  const gif = GIFEncoder();
  for (let i = 0; i < images.length; i++) {
    checkAbort(signal);
    onProgress && onProgress(i, images.length);
    draw(images[i]);
    let data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch {
      throw corsError();
    }
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), canvas.width, canvas.height, { palette, delay });
    await pause(0); // let the UI breathe
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

/** The best video format this browser can record, or null. */
export function videoMime() {
  if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) return null;
  for (const m of ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

/** Short video, recorded in real time (frames × delay). Plays through twice. */
export async function encodeVideo(images, { width, height, delay, background, credit, onProgress, signal }) {
  const mime = videoMime();
  if (!mime) throw new Error("This browser can't record video.");
  BG.value = background || BG.value;
  // Video encoders want even dimensions.
  const w = width - (width % 2);
  const h0 = height + (credit ? creditHeight(w) : 0);
  const { canvas, draw } = frameCanvas(w, height - (h0 % 2), credit);
  draw(images[0]);
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve) => (rec.onstop = resolve));
  rec.start();
  const total = images.length * 2;
  for (let k = 0; k < total; k++) {
    if (signal && signal.aborted) break;
    onProgress && onProgress(k, total);
    draw(images[k % images.length]);
    await pause(delay);
  }
  rec.stop();
  stream.getTracks().forEach((t) => t.stop());
  await done;
  checkAbort(signal);
  return new Blob(chunks, { type: mime.split(";")[0] });
}

/** One JPEG with a grid of pages. */
export async function contactSheet(images, { cellWidth, aspect, background, credit }) {
  const n = images.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cw = cellWidth;
  const chh = Math.round(cw * aspect);
  const gap = Math.round(cw * 0.05);
  const W = cols * cw + (cols + 1) * gap;
  const H = rows * chh + (rows + 1) * gap;
  const band = credit ? creditHeight(Math.min(W, 900)) : 0;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H + band;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  images.forEach((img, i) => {
    const x = gap + (i % cols) * (cw + gap);
    const y = gap + Math.floor(i / cols) * (chh + gap);
    drawPage(ctx, img, x, y, cw, chh, background);
  });
  if (credit) drawCredit(ctx, credit, 0, H, W, band);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  if (!blob) throw corsError();
  return blob;
}
