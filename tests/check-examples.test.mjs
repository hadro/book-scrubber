import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExample, toMarkdown } from "../scripts/check-examples.mjs";
import { v3Manifest } from "./fixtures.mjs";

const fakeFetch = ({ cors = true, imageStatus = 200 } = {}) => async (url) => {
  if (url.includes("missing")) return new Response("no", { status: 404 });
  if (url.endsWith("manifest.json")) return Response.json(v3Manifest(12, { base: "https://img.example.org/b" }));
  return new Response("x", { status: imageStatus, headers: { "content-type": "image/jpeg", ...(cors ? { "access-control-allow-origin": "*" } : {}) } });
};

test("healthy example", async () => {
  const row = await checkExample({ title: "Good", input: "https://example.org/good/manifest.json" }, { fetchImpl: fakeFetch() });
  assert.equal(row.ok, true);
  assert.equal(row.pages, "12 (v3)");
  assert.equal(row.cors, "yes");
});

test("image server without CORS still counts as working, but is flagged", async () => {
  const row = await checkExample({ title: "NoCors", input: "https://example.org/n/manifest.json" }, { fetchImpl: fakeFetch({ cors: false }) });
  assert.equal(row.ok, true);
  assert.match(row.cors, /^no/);
});

test("broken manifest and broken image are failures", async () => {
  const a = await checkExample({ title: "Missing", input: "https://example.org/missing/manifest.json" }, { fetchImpl: fakeFetch() });
  assert.equal(a.ok, false);
  assert.equal(a.manifest, "HTTP 404");
  const b = await checkExample({ title: "BadImg", input: "https://example.org/b/manifest.json" }, { fetchImpl: fakeFetch({ imageStatus: 500 }) });
  assert.equal(b.ok, false);
  assert.match(toMarkdown([a, b]), /2 of 2 examples are broken/);
});
