// Cheap page classification from a thumbnail: "blank", "text" or "plate".
//
// The image is shrunk to 48×48 (ignoring an 8% margin, where scan edges and
// rulers live) and three numbers are measured:
//   - spread: standard deviation of brightness (0–255)
//   - color: spread of the red-green and yellow-blue opponent channels
//     (the variance part of Hasler & Süsstrunk's colorfulness), so evenly
//     yellowed paper doesn't count as colorful
//   - dark: share of pixels well below the page's average brightness
//   - picture: the largest connected region noticeably darker than the paper,
//     and how much brightness varies inside it. Photographs and engravings
//     make one big region full of light and shade (a sepia albumen print
//     mounted on card has no strong color or black, but plenty of tone);
//     a block of text makes a region too, but an evenly gray one.
// At this size lines of text blur into an even gray, while illustrations keep
// big dark or colored areas. The thresholds are heuristics, tuned on
// synthetic pages; expect to adjust them after looking at real books.

const SIZE = 48;
let ctx = null;

export const THRESHOLDS = {
  blankSpread: 5, // low on purpose: showing a near-blank page beats hiding faint text
  blankColor: 5,
  plateColor: 18,
  plateSpread: 45,
  plateDark: 0.22,
  pictureArea: 0.08, // share of the page covered by one darker region...
  pictureTone: 16, //  ...with at least this much brightness variation inside it
  pictureDepth: 25, // how much darker than the paper counts as "darker"
};

/** Measure a loaded image. Returns null if the pixels can't be read (no CORS). */
export function analyzeImage(img) {
  if (!ctx) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  let data;
  try {
    ctx.drawImage(img, w * 0.08, h * 0.08, w * 0.84, h * 0.84, 0, 0, SIZE, SIZE);
    data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return null;
  }
  return classify(data);
}

/** Classify raw RGBA pixels. Exported for tests. */
export function classify(data) {
  const n = data.length / 4;
  let sumL = 0, sumL2 = 0, sumRG = 0, sumRG2 = 0, sumYB = 0, sumYB2 = 0;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    lum[i] = l;
    sumL += l; sumL2 += l * l;
    sumRG += rg; sumRG2 += rg * rg;
    sumYB += yb; sumYB2 += yb * yb;
  }
  const mean = sumL / n;
  const spread = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));
  const sdRG = Math.sqrt(Math.max(0, sumRG2 / n - (sumRG / n) ** 2));
  const sdYB = Math.sqrt(Math.max(0, sumYB2 / n - (sumYB / n) ** 2));
  const color = Math.sqrt(sdRG * sdRG + sdYB * sdYB);
  let darkCount = 0;
  for (let i = 0; i < n; i++) if (lum[i] < mean - 50) darkCount++;
  const dark = darkCount / n;

  const t = THRESHOLDS;
  const pic = pictureRegion(lum, t.pictureDepth);
  let kind = "text";
  if (spread < t.blankSpread && color < t.blankColor) kind = "blank";
  else if (color > t.plateColor || spread > t.plateSpread || dark > t.plateDark) kind = "plate";
  else if (pic.area >= t.pictureArea && pic.tone >= t.pictureTone) kind = "plate";
  return {
    kind,
    spread: Math.round(spread),
    color: Math.round(color),
    dark: Math.round(dark * 100) / 100,
    area: Math.round(pic.area * 100) / 100,
    tone: Math.round(pic.tone),
  };
}

/** Largest 4-connected region darker than the paper by `depth`, and the brightness spread inside it. */
function pictureRegion(lum, depth) {
  const n = lum.length;
  const size = Math.round(Math.sqrt(n));
  const paper = Float32Array.from(lum).sort()[Math.floor(n * 0.9)]; // the page's own light tone
  const seen = new Uint8Array(n);
  const inRegion = (i) => paper - lum[i] > depth;
  let best = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !inRegion(s)) continue;
    const comp = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % size;
      for (const j of [x + 1 < size ? i + 1 : -1, x > 0 ? i - 1 : -1, i + size < n ? i + size : -1, i - size]) {
        if (j >= 0 && !seen[j] && inRegion(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  if (!best.length) return { area: 0, tone: 0 };
  const mean = best.reduce((a, i) => a + lum[i], 0) / best.length;
  const tone = Math.sqrt(best.reduce((a, i) => a + (lum[i] - mean) ** 2, 0) / best.length);
  return { area: best.length / n, tone };
}
