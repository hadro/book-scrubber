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
  contentStateManifest,
  collectionMembers,
  isCollection,
  itemPageFromUrl,
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
  assert.equal(pageImageUrl(m.pages[0], 300), "https://static.example.org/p0/full/250,/0/default.jpg");
});

test("pageImageUrl: canonical v3 sizes, advertised sizes, and thumbnails", () => {
  const json = v3Manifest(1);
  const body = json.items[0].items[0].items[0].body;
  body.service[0].width = 2000;
  body.service[0].height = 3000;
  let page = parseManifest(json).pages[0];
  assert.equal(pageImageUrl(page, 300), "https://img.example.org/iiif3/p0/full/300,450/0/default.jpg");
  // Never ask for more than the full width.
  body.service[0].width = 200;
  body.service[0].height = 300;
  page = parseManifest(json).pages[0];
  assert.equal(pageImageUrl(page, 300), "https://img.example.org/iiif3/p0/full/200,300/0/default.jpg");

  // Advertised sizes win when one is close enough.
  body.service[0].sizes = [{ width: 125, height: 188 }, { width: 500, height: 750 }, { width: 1000, height: 1500 }];
  page = parseManifest(json).pages[0];
  assert.equal(pageImageUrl(page, 300), "https://img.example.org/iiif3/p0/full/500,750/0/default.jpg");
  assert.equal(pageImageUrl(page, 800), "https://img.example.org/iiif3/p0/full/1000,1500/0/default.jpg");

  // A ready-made thumbnail of about the right size beats everything.
  json.items[0].thumbnail = [{ id: "https://cdn.example.org/thumb0.jpg", type: "Image", width: 320, height: 480 }];
  page = parseManifest(json).pages[0];
  assert.equal(pageImageUrl(page, 300), "https://cdn.example.org/thumb0.jpg");
  assert.notEqual(pageImageUrl(page, 800), "https://cdn.example.org/thumb0.jpg");
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

test("content state links (plain and base64url) resolve to their manifest", () => {
  const state = { id: "https://x.org/anno", type: "Annotation", motivation: ["contentState"], target: { id: "https://x.org/canvas/1", type: "Canvas", partOf: [{ id: "https://x.org/manifest.json", type: "Manifest" }] } };
  const b64 = Buffer.from(JSON.stringify(state)).toString("base64url");
  assert.equal(contentStateManifest(b64), "https://x.org/manifest.json");
  assert.equal(contentStateManifest(JSON.stringify({ id: "https://x.org/m2", type: "Manifest" })), "https://x.org/m2");
  assert.deepEqual(resolveInput(`https://viewer.example/?iiif-content=${b64}`), ["https://x.org/manifest.json"]);
  assert.equal(contentStateManifest("not base64 at all!!"), null);
});

test("collections: v3 items and v2 manifests lists", () => {
  const v3 = { type: "Collection", label: { en: ["Albums"] }, items: [
    { id: "https://x.org/a", type: "Manifest", label: { en: ["A"] } },
    { id: "https://x.org/sub", type: "Collection" },
    { id: "https://x.org/b", type: "Manifest", label: { en: ["B"] } },
  ] };
  assert.ok(isCollection(v3));
  assert.deepEqual(collectionMembers(v3), { label: "Albums", manifests: [{ id: "https://x.org/a", label: "A" }, { id: "https://x.org/b", label: "B" }], subCollections: 1 });
  const v2 = { "@type": "sc:Collection", label: "Old", manifests: [{ "@id": "https://x.org/c", label: "C" }], collections: [{}] };
  assert.deepEqual(collectionMembers(v2), { label: "Old", manifests: [{ id: "https://x.org/c", label: "C" }], subCollections: 1 });
});

test("homepage comes from v3 homepage or v2 related", () => {
  const v3 = v3Manifest(1);
  v3.homepage = [{ id: "https://lib.example/item/1", type: "Text" }];
  assert.equal(parseManifest(v3).homepage, "https://lib.example/item/1");
  const v2 = v2Manifest(1);
  v2.related = "https://lib.example/item/2";
  assert.equal(parseManifest(v2).homepage, "https://lib.example/item/2");
});

test("item pages are derived from manifest and catalog URLs", () => {
  assert.equal(itemPageFromUrl("https://iiif.archive.org/iiif/3/b33498854/manifest.json"), "https://archive.org/details/b33498854");
  assert.equal(itemPageFromUrl("https://www.loc.gov/item/03032405/manifest.json"), "https://www.loc.gov/item/03032405/");
  assert.equal(
    itemPageFromUrl("https://api-collections.nypl.org/manifests/dce441f0-83d3-0132-efca-58d385a7b928"),
    "https://digitalcollections.nypl.org/items/dce441f0-83d3-0132-efca-58d385a7b928"
  );
  assert.equal(itemPageFromUrl("https://www.e-codices.unifr.ch/metadata/iiif/csg-0040/manifest.json"), "https://www.e-codices.unifr.ch/en/list/one/csg/0040");
  assert.equal(
    itemPageFromUrl("https://libraryimage.nga.gov/manifest/mms/99826713504896.json"),
    "https://library.nga.gov/discovery/fulldisplay?vid=01NGA_INST:NGA&docid=alma99826713504896"
  );
  assert.equal(itemPageFromUrl("https://archive.org/details/foo"), "https://archive.org/details/foo");
  assert.equal(itemPageFromUrl("kunstformenderna00haec"), "https://archive.org/details/kunstformenderna00haec");
  assert.equal(itemPageFromUrl("https://media.getty.edu/iiif/manifest/3/ad56409c"), null);
  assert.equal(itemPageFromUrl("https://example.org/iiif/book/manifest.json"), null);
});
