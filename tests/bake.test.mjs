import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bake, slugFor, BAKED_FRAMES } from "../scripts/bake-examples.mjs";
import { sampleIndices } from "../js/iiif.js";
import { v2Manifest } from "./fixtures.mjs";

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (url.includes("broken")) return new Response("nope", { status: 404 });
    if (url.endsWith("manifest.json")) return Response.json(v2Manifest(100, { base: "https://img.example.org/b" }));
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
  };
}

test("bake writes sampled thumbnails and an index; failures don't clobber", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "bake-"));
  const calls = [];
  const examples = [
    { title: "Good", input: "https://example.org/good/manifest.json" },
    { title: "Broken", input: "https://example.org/broken/manifest.json" },
  ];
  const index = await bake(examples, { outDir, fetchImpl: fakeFetch(calls), delayMs: 0, log: () => {} });

  const item = index.items[examples[0].input];
  assert.equal(item.total, 100);
  assert.equal(item.pages.length, BAKED_FRAMES);
  assert.equal(item.files.length, BAKED_FRAMES);
  assert.equal(item.files[0], `baked/${slugFor(examples[0].input)}/00.jpg`);
  assert.ok(calls.some((u) => u === "https://img.example.org/b/p99/full/300,/0/default.jpg"));
  assert.equal(index.items[examples[1].input], undefined);

  const onDisk = JSON.parse(await readFile(join(outDir, "index.json"), "utf8"));
  assert.deepEqual(Object.keys(onDisk.items), [examples[0].input]);
  assert.equal((await readdir(join(outDir, slugFor(examples[0].input)))).length, BAKED_FRAMES);

  // Second run skips what's already baked: no new requests.
  const before = calls.length;
  await bake([examples[0]], { outDir, fetchImpl: fakeFetch(calls), delayMs: 0, log: () => {} });
  assert.equal(calls.length, before);
});

test("a hung request times out and is retried instead of stalling the bake", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "bake-"));
  const seen = new Map();
  const hangFirst = async (url, { signal } = {}) => {
    seen.set(url, (seen.get(url) || 0) + 1);
    if (seen.get(url) === 1 && !url.endsWith("manifest.json")) {
      // Hold the event loop open like a real socket would (timeout signals don't).
      const socket = setTimeout(() => {}, 60000);
      return new Promise((_, reject) => signal.addEventListener("abort", () => (clearTimeout(socket), reject(signal.reason))));
    }
    return fakeFetch([])(url);
  };
  const ex = { title: "Hangs", input: "https://example.org/hang/manifest.json" };
  const index = await bake([ex], { outDir, fetchImpl: hangFirst, delayMs: 0, timeoutMs: 20, log: () => {} });
  assert.equal(index.items[ex.input].files.length, BAKED_FRAMES);
  assert.ok([...seen.values()].every((n) => n <= 2));
});

test("a partial bake is saved, then completed by the next run without refetching what it has", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "bake-"));
  const ex = { title: "Flaky", input: "https://example.org/flaky/manifest.json" };
  const broken = new Set(sampleIndices(100, BAKED_FRAMES).slice(1, 4).map((p) => `p${p}`)); // 3 of the sampled pages
  const calls = [];
  const flaky = async (url) => {
    calls.push(url);
    if ([...broken].some((p) => url.includes(`/${p}/`))) return new Response("gone", { status: 404 });
    return fakeFetch([])(url);
  };
  const first = await bake([ex], { outDir, fetchImpl: flaky, delayMs: 0, log: () => {} });
  const item = first.items[ex.input];
  assert.equal(item.partial, true);
  assert.equal(item.files.length, item.pages.length);
  const missing = sampleIndices(100, BAKED_FRAMES).filter((p) => !item.pages.includes(p));
  assert.equal(missing.length, 3);
  assert.equal((await readdir(join(outDir, slugFor(ex.input)))).length, item.files.length);

  // Next run: the server has recovered. Only the missing frames are fetched.
  broken.clear();
  calls.length = 0;
  const second = await bake([ex], { outDir, fetchImpl: flaky, delayMs: 0, log: () => {} });
  const done = second.items[ex.input];
  assert.equal(done.partial, undefined);
  assert.equal(done.files.length, BAKED_FRAMES);
  assert.equal(calls.filter((u) => !u.endsWith("manifest.json")).length, missing.length);
  assert.equal((await readdir(join(outDir, slugFor(ex.input)))).length, BAKED_FRAMES);
  assert.deepEqual((await readdir(outDir)).sort(), ["index.json", slugFor(ex.input)].sort()); // no temp folder left
});

test("a failed re-bake keeps the previous bake intact", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "bake-"));
  const ex = { title: "Good", input: "https://example.org/good/manifest.json" };
  const first = await bake([ex], { outDir, fetchImpl: fakeFetch([]), delayMs: 0, log: () => {} });
  const allImagesFail = async (url) => (url.endsWith("manifest.json") ? fakeFetch([])(url) : new Response("down", { status: 404 }));
  const second = await bake([ex], { outDir, fetchImpl: allImagesFail, force: true, delayMs: 0, log: () => {} });
  assert.deepEqual(second.items[ex.input], first.items[ex.input]);
  assert.equal((await readdir(join(outDir, slugFor(ex.input)))).length, BAKED_FRAMES);
  assert.deepEqual((await readdir(outDir)).sort(), ["index.json", slugFor(ex.input)].sort());
});
