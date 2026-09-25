import { GIFEncoder, quantize, applyPalette } from "../vendor/gifenc.esm.js";

/** Load an image with CORS so it can be drawn to a canvas and read back. */
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

function corsError() {
  const e = new Error(
    "This library's image server doesn't let other websites re-use its images (no CORS headers), so a GIF can't be made in the browser for this item. The scrubber still works!"
  );
  e.name = "CorsError";
  return e;
}

/**
 * Build an animated GIF from a list of image URLs.
 *
 * @param {string[]} urls
 * @param {object} opts
 * @param {number} opts.width   output width in px
 * @param {number} opts.height  output height in px
 * @param {number} opts.delay   ms per frame
 * @param {string} opts.background  letterbox color
 * @param {(done:number,total:number,phase:string)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Blob>}
 */
export async function makeGif(urls, { width, height, delay, background = "#f6efe2", onProgress, signal }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const gif = GIFEncoder();
  const total = urls.length;
  let skipped = 0;

  for (let i = 0; i < total; i++) {
    if (signal && signal.aborted) throw new DOMException("Cancelled", "AbortError");
    onProgress && onProgress(i, total, "fetching");

    let img;
    try {
      img = await loadCorsImage(urls[i]);
    } catch {
      // Tell "server forbids cross-origin reuse" apart from "image is broken".
      if (await loadsWithoutCors(urls[i])) throw corsError();
      skipped++;
      continue;
    }

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);

    let data;
    try {
      data = ctx.getImageData(0, 0, width, height).data;
    } catch {
      throw corsError();
    }

    onProgress && onProgress(i, total, "encoding");
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, { palette, delay });
    // Let the UI breathe between frames.
    await new Promise((r) => setTimeout(r, 0));
  }

  if (skipped === total) throw new Error("None of the pages could be loaded for the GIF.");
  gif.finish();
  onProgress && onProgress(total, total, "done");
  return new Blob([gif.bytes()], { type: "image/gif" });
}
