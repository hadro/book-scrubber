// Used by tests/analyze.test.mjs.
// Synthetic full-size pages, box-downsampled to 48×48 like the browser does.
export const S = 48, F = 10, BIG = S * F; // render at 480, shrink ×10
function render(paint) {
  const big = new Float32Array(BIG * BIG * 3);
  for (let y = 0; y < BIG; y++) for (let x = 0; x < BIG; x++) {
    const [r, g, b] = paint(x / BIG, y / BIG, x, y);
    const i = (y * BIG + x) * 3; big[i] = r; big[i + 1] = g; big[i + 2] = b;
  }
  const out = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) {
      const i = ((y * F + dy) * BIG + x * F + dx) * 3; r += big[i]; g += big[i + 1]; b += big[i + 2];
    }
    const n = F * F, o = (y * S + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return out;
}
const CREAM = [232, 222, 198];
const noise = (x, y) => (((x * 7919 + y * 104729) % 13) - 6);
// Frith-style albumen print: sepia photo on a cream mount, photo ~60% of width.
export const sepiaPhoto = (fade = 0) => render((u, v, x, y) => {
  if (u > 0.18 && u < 0.82 && v > 0.2 && v < 0.62) {
    // sky (light) top third, buildings mid-tone, shadows dark, plus texture
    let t = v < 0.33 ? 0.85 : v < 0.5 ? 0.55 + 0.2 * Math.sin(u * 40) : 0.35 + 0.25 * Math.sin(u * 23 + v * 30);
    t = Math.min(1, t + fade + noise(x, y) / 120);
    return [70 + 150 * t, 50 + 140 * t, 30 + 115 * t]; // sepia ramp
  }
  return CREAM.map((c) => c + noise(x, y) / 2);
});
// Dense printed text: black strokes, 11px lines in a 480px page.
export const textPage = (ink = 30) => render((u, v, x, y) => {
  if (u > 0.12 && u < 0.88 && v > 0.1 && v < 0.9 && y % 11 < 6 && ((x * 13 + (y >> 3) * 7) % 9) < 5) return [ink, ink, ink];
  return CREAM.map((c) => c + noise(x, y) / 2);
});
// Caption page: a few lines only.
export const captionPage = () => render((u, v, x, y) => (u > 0.3 && u < 0.7 && v > 0.45 && v < 0.5 && y % 11 < 6 && (x % 7) < 4 ? [40, 40, 40] : CREAM.map((c) => c + noise(x, y) / 2)));
export const blankPage = () => render((u, v, x, y) => CREAM.map((c) => c + noise(x, y)));
