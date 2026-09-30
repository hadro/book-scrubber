import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetGrid } from "../js/export.js";

const cell = ({ col, row }) => `${row},${col}`;

test("sheetGrid: a near-square grid filled row by row, left to right", () => {
  const { cols, rows, cells } = sheetGrid(5);
  assert.deepEqual([cols, rows], [3, 2]);
  assert.deepEqual(cells.map(cell), ["0,0", "0,1", "0,2", "1,0", "1,1"]);
});

test("sheetGrid: right-to-left books start at the top right, last row ends on the left", () => {
  const { cols, rows, cells } = sheetGrid(5, { rtl: true });
  assert.deepEqual([cols, rows], [3, 2]);
  assert.deepEqual(cells.map(cell), ["0,2", "0,1", "0,0", "1,2", "1,1"]);
});

test("sheetGrid: a single page", () => {
  assert.deepEqual(sheetGrid(1, { rtl: true }).cells.map(cell), ["0,0"]);
});
