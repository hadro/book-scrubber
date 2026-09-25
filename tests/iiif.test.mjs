import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveInput,
  parseManifest,
  pageImageUrl,
  sampleIndices,
  bisectionOrder,
  labelText,
  inputHint,
} from "../js/iiif.js";
import { v2Manifest, v3Manifest } from "./fixtures.mjs";

test("resolveInput: bare IA identifier and archive.org URLs", () => {
  assert.deepEqual(resolveInput("kunstformenderna00haec"), [
    "https://iiif.archive.org/iiif/3/kunstformenderna00haec/manifest.json",
  ]);
  assert.deepEqual(resolveInput("https://archive.org/details/foo_bar/page/n5/mode/2up"), [
    "https://iiif.archive.org/iiif/3/foo_bar/manifest.json",
  ]);
});

test("resolveInput: LoC, NYPL, BHL, e-codices pages", () => {
  assert.deepEqual(resolveInput("https://www.loc.gov/item/03032405/"), [
    "https://www.loc.gov/item/03032405/manifest.json",
  ]);
  assert.deepEqual(
    resolveInput("https://digitalcollections.nypl.org/items/dce441f0-83d3-0132-efca-58d385a7b928"),
    ["https://api-collections.nypl.org/manifests/dce441f0-83d3-0132-efca-58d385a7b928"]
  );
  assert.deepEqual(resolveInput("https://www.biodiversitylibrary.org/item/98364#page/1/mode/1up"), []);
  assert.match(inputHint("https://www.biodiversitylibrary.org/item/98364"), /Internet Archive/);
  assert.deepEqual(resolveInput("https://www.e-codices.unifr.ch/en/list/one/csg/0390"), [
    "https://www.e-codices.unifr.ch/metadata/iiif/csg-0390/manifest.json",
  ]);
});

test("resolveInput: NGA catalog records, viewer links, Getty hint", () => {
  assert.deepEqual(
    resolveInput("https://library.nga.gov/discovery/fulldisplay?context=L&vid=01NGA_INST:NGA&docid=alma99826713504896"),
    ["https://libraryimage.nga.gov/manifest/mms/99826713504896.json"]
  );
  assert.deepEqual(
    resolveInput("https://libraryimage.nga.gov/uv/?manifest=https%3A%2F%2Flibraryimage.nga.gov%2Fmanifest%2Fmms%2F991861883504896.json"),
    ["https://libraryimage.nga.gov/manifest/mms/991861883504896.json"]
  );
  assert.deepEqual(resolveInput("https://viewer.example.org/?iiif-content=https://archive.org/details/foo"), [
    "https://iiif.archive.org/iiif/3/foo/manifest.json",
  ]);
  assert.deepEqual(resolveInput("https://www.getty.edu/art/collection/object/104J2P"), []);
  assert.match(inputHint("https://www.getty.edu/art/collection/object/104J2P"), /IIIF/);
  const getty = "https://media.getty.edu/iiif/manifest/53be857e-41e8-4198-b45d-2e0f52d3051b";
  assert.deepEqual(resolveInput(getty), [getty]);
});

test("resolveInput: manifest URLs pass through; junk is rejected", () => {
  const url = "https://example.org/iiif/book1/manifest.json";
  assert.deepEqual(resolveInput(url), [url]);
  assert.deepEqual(resolveInput("https://www.loc.gov/item/123/manifest.json"), [
    "https://www.loc.gov/item/123/manifest.json",
  ]);
  assert.deepEqual(resolveInput("not a url at all"), []);
  assert.deepEqual(resolveInput("   "), []);
});

test("labelText handles strings, v3 language maps and v2 @value objects", () => {
  assert.equal(labelText("Plain"), "Plain");
  assert.equal(labelText({ en: ["English"], fr: ["Français"] }), "English");
  assert.equal(labelText({ none: ["n/a"] }), "n/a");
  assert.equal(labelText({ de: ["Deutsch"] }), "Deutsch");
  assert.equal(labelText([{ "@value": "A", "@language": "en" }]), "A");
});

test("parseManifest: Presentation v2", () => {
  const m = parseManifest(v2Manifest(5));
  assert.equal(m.label, "A v2 book");
  assert.equal(m.pages.length, 5);
  assert.equal(m.pages[0].service.id, "https://img.example.org/iiif/p0");
  assert.equal(m.pages[0].service.version, 2);
  assert.equal(m.attribution, "Some Library");
  assert.equal(pageImageUrl(m.pages[2], 300), "https://img.example.org/iiif/p2/full/300,/0/default.jpg");
});

test("parseManifest: Presentation v3 with ImageService3, RTL", () => {
  const m = parseManifest(v3Manifest(7, { rtl: true }));
  assert.equal(m.label, "A v3 book");
  assert.equal(m.pages.length, 7);
  assert.equal(m.rtl, true);
  assert.equal(m.pages[3].service.version, 3);
  assert.equal(m.pages[3].label, "p. 4");
  assert.equal(m.attribution, "Provided by a museum");
});

test("parseManifest: v3 canvas without an image service falls back to the raw image", () => {
  const json = v3Manifest(2);
  delete json.items[1].items[0].items[0].body.service;
  const m = parseManifest(json);
  assert.equal(pageImageUrl(m.pages[1], 300), "https://img.example.org/iiif3/p1/full/max/0/default.jpg");
});

test("parseManifest: level0 service uses a pre-baked size", () => {
  const json = v2Manifest(1);
  json.sequences[0].canvases[0].images[0].resource.service = {
    "@id": "https://static.example.org/p0",
    profile: "http://iiif.io/api/image/2/level0.json",
    sizes: [{ width: 150, height: 200 }, { width: 250, height: 333 }, { width: 600, height: 800 }, { width: 1200, height: 1600 }],
  };
  const m = parseManifest(json);
  assert.equal(pageImageUrl(m.pages[0], 300), "https://static.example.org/p0/full/600,/0/default.jpg");
});

test("parseManifest: rejects collections and empty manifests", () => {
  assert.throws(() => parseManifest({ type: "Collection", items: [] }), /Collection/);
  assert.throws(() => parseManifest({ type: "Manifest", items: [] }), /no page images/);
});

test("sampleIndices spreads evenly and includes ends", () => {
  assert.deepEqual(sampleIndices(5, 10), [0, 1, 2, 3, 4]);
  const s = sampleIndices(400, 24);
  assert.equal(s.length, 24);
  assert.equal(s[0], 0);
  assert.equal(s.at(-1), 399);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1]);
});

test("bisectionOrder is a permutation that starts coarse", () => {
  for (const n of [1, 2, 3, 7, 24, 150]) {
    const order = bisectionOrder(n);
    assert.equal(order.length, n);
    assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
  }
  const o = bisectionOrder(24);
  assert.deepEqual(o.slice(0, 2), [0, 23]);
  assert.equal(o[2], 12);
});
