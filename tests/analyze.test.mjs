import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../js/analyze.js";

const S = 48;
const PAPER = [236, 226, 200];
function page(paint) {
  const d = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const [r, g, b] = paint(x, y) || PAPER;
      const i = (y * S + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  return d;
}
const noise = (x, y) => ((x * 7919 + y * 104729) % 7) - 3;

test("blank paper (with a little noise) is blank", () => {
  assert.equal(classify(page((x, y) => PAPER.map((c) => c + noise(x, y)))).kind, "blank");
});

test("a page of text blurred to thumbnail size is text", () => {
  // Text at 48px: faint grey rows with gaps, inside margins.
  const d = page((x, y) => (x > 5 && x < 42 && y > 4 && y < 44 && y % 3 !== 0 ? PAPER.map((c) => c - 45) : null));
  assert.equal(classify(d).kind, "text");
});

test("a colour plate is a plate", () => {
  const d = page((x, y) => ((x - 24) ** 2 + (y - 22) ** 2 < 180 ? [40, 110, 170] : x > 30 && y > 30 ? [200, 60, 50] : null));
  assert.equal(classify(d).kind, "plate");
});

test("a black-and-white engraving is a plate", () => {
  const d = page((x, y) => (x > 6 && x < 42 && y > 6 && y < 42 && (x * y) % 5 < 3 ? [40, 38, 35] : null));
  assert.equal(classify(d).kind, "plate");
});

test("a photo mounted on an album page is a plate", () => {
  const d = page((x, y) => (x > 8 && x < 40 && y > 10 && y < 34 ? [90 + (x % 9) * 8, 80 + (y % 7) * 9, 70] : null));
  assert.equal(classify(d).kind, "plate");
});
