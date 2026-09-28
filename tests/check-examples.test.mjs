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
  const row = await checkExample({ title: "Good", input: "https://example.org/good/manifest.json" }, { fetchImpl: fakeFetch(), retryDelay: 0 });
  assert.equal(row.ok, true);
  assert.equal(row.pages, "12 (v3)");
  assert.equal(row.cors, "yes");
});

test("image server without CORS still counts as working, but is flagged", async () => {
  const row = await checkExample({ title: "NoCors", input: "https://example.org/n/manifest.json" }, { fetchImpl: fakeFetch({ cors: false }), retryDelay: 0 });
  assert.equal(row.ok, true);
  assert.match(row.cors, /^no/);
});

test("broken manifest and broken image are failures", async () => {
  const a = await checkExample({ title: "Missing", input: "https://example.org/missing/manifest.json" }, { fetchImpl: fakeFetch(), retryDelay: 0 });
  assert.equal(a.ok, false);
  assert.equal(a.manifest, "HTTP 404");
  const b = await checkExample({ title: "BadImg", input: "https://example.org/b/manifest.json" }, { fetchImpl: fakeFetch({ imageStatus: 500 }), retryDelay: 0 });
  assert.equal(b.ok, false);
  assert.match(toMarkdown([a, b]), /2 of 2 examples are broken/);
});

test("a server error gets one retry before counting as broken", async () => {
  let calls = 0;
  const flaky = async (url) => {
    if (url.endsWith("manifest.json")) return Response.json(v3Manifest(3, { base: "https://img.example.org/b" }));
    calls++;
    return calls === 1
      ? new Response("busy", { status: 504 })
      : new Response("x", { headers: { "content-type": "image/jpeg", "access-control-allow-origin": "*" } });
  };
  const row = await checkExample({ title: "Flaky", input: "https://example.org/f/manifest.json" }, { fetchImpl: flaky, retryDelay: 0 });
  assert.equal(row.ok, true);
  assert.match(row.image, /after a retry/);
});

test("a 403 is a warning (blocked from CI), not a failure", async () => {
  const refuse = async () => new Response("no", { status: 403 });
  const row = await checkExample({ title: "LoC", input: "https://example.org/loc/manifest.json" }, { fetchImpl: refuse, retryDelay: 0 });
  assert.equal(row.ok, false);
  assert.equal(row.blocked, true);
  const md = toMarkdown([row]);
  assert.match(md, /No examples are broken/);
  assert.match(md, /⚠️ 1 refused the check with HTTP 403/);
  assert.match(md, /\| ⚠️ \| LoC \|/);
  const missing = await checkExample({ title: "Missing", input: "https://example.org/missing/manifest.json" }, { fetchImpl: fakeFetch(), retryDelay: 0 });
  assert.equal(missing.blocked, false);
  assert.match(toMarkdown([row, missing]), /\*\*1 of 2 examples are broken\.\*\*/);
});

test("a hung request is retried once, then reported without waiting forever", async () => {
  // Hold the event loop open like a real socket would (timeout signals don't).
  const hang = (signal) => {
    const socket = setTimeout(() => {}, 60000);
    return new Promise((_, reject) => signal.addEventListener("abort", () => (clearTimeout(socket), reject(signal.reason))));
  };
  let imageCalls = 0;
  const hangOnce = async (url, { signal } = {}) => {
    if (url.endsWith("manifest.json")) return Response.json(v3Manifest(3, { base: "https://img.example.org/b" }));
    if (++imageCalls === 1) return hang(signal);
    return new Response("x", { headers: { "content-type": "image/jpeg", "access-control-allow-origin": "*" } });
  };
  const ok = await checkExample({ title: "HangOnce", input: "https://example.org/h/manifest.json" }, { fetchImpl: hangOnce, retryDelay: 0, timeoutMs: 20 });
  assert.equal(ok.ok, true);
  assert.match(ok.image, /after a retry/);

  const always = async (url, { signal } = {}) => (url.endsWith("manifest.json") ? Response.json(v3Manifest(3)) : hang(signal));
  const bad = await checkExample({ title: "Hangs", input: "https://example.org/h2/manifest.json" }, { fetchImpl: always, retryDelay: 0, timeoutMs: 20 });
  assert.equal(bad.ok, false);
  assert.equal(bad.blocked, false);
  assert.match(bad.image, /no response after 0.02 s, even after a retry/);
});
