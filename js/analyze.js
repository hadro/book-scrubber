// Cheap page classification from a thumbnail: "blank", "text" or "plate".
//
// The image is shrunk to 48×48 (ignoring an 8% margin, where scan edges and
// rulers live) and three numbers are measured:
//   - spread: standard deviation of brightness (0–255)
//   - colour: spread of the red-green and yellow-blue opponent channels
//     (the variance part of Hasler & Süsstrunk's colourfulness), so evenly
//     yellowed paper doesn't count as colourful
//   - dark: share of pixels well below the page's average brightness
// At this size lines of text blur into an even grey, while illustrations keep
// big dark or coloured areas. The thresholds are heuristics, tuned on
// synthetic pages; expect to adjust them after looking at real books.

const SIZE = 48;
let ctx = null;

export const THRESHOLDS = {
  blankSpread: 7,
  blankColour: 5,
  plateColour: 18,
  plateSpread: 45,
  plateDark: 0.22,
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
  const colour = Math.sqrt(sdRG * sdRG + sdYB * sdYB);
  let darkCount = 0;
  for (let i = 0; i < n; i++) if (lum[i] < mean - 50) darkCount++;
  const dark = darkCount / n;

  const t = THRESHOLDS;
  let kind = "text";
  if (spread < t.blankSpread && colour < t.blankColour) kind = "blank";
  else if (colour > t.plateColour || spread > t.plateSpread || dark > t.plateDark) kind = "plate";
  return { kind, spread: Math.round(spread), colour: Math.round(colour), dark: Math.round(dark * 100) / 100 };
}
