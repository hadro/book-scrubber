# Book Scrubber

Hover over a digitized book and wiggle your mouse to flip through its pages. Click one to open a flipbook with play controls, and to turn it into an animated GIF.

It's a small homage to the animated book thumbnails that used to flicker through Internet Archive search results about ten years ago. It works with **any IIIF manifest**, so books from almost any library can go on the shelf.

## Features

- **Hover-scrubber cards.** Mouse position maps to a page. Pages load "coarse first" (ends, then middle, then quarters, and so on), so you can scrub the whole book almost at once. On phones, drag a finger sideways across a card.
- **Paste your own.** Accepts a IIIF Presentation v2 or v3 manifest URL, or a page URL from:
  - `archive.org/details/…`, or a bare IA identifier
  - `loc.gov/item/…`
  - `digitalcollections.nypl.org/items/…`
  - e-codices
  - National Gallery of Art Library catalog records (`library.nga.gov/discovery/fulldisplay?…docid=alma…`)
  - Any viewer link that carries the manifest in its URL (`?manifest=…`, `?iiif-content=…`), such as Universal Viewer or Mirador links

  Getty object pages can't be resolved automatically. Click the IIIF logo on the page and paste the `media.getty.edu/iiif/manifest/…` link.

  BHL doesn't publish IIIF manifests at a predictable address. Paste the book's archive.org link instead; BHL hosts its scans there.

  Pasted books stay on your shelf in `localStorage`.
- **Flipbook viewer.** Scrubbing, play/pause, speed control, boomerang mode and keyboard controls. Share links (`#m=…`) open an item directly.
- **GIF maker.** Choose frame count, width and speed. The GIF is encoded in the browser with [gifenc](https://github.com/mattdesl/gifenc), vendored in `vendor/`.
- **Flash mode.** Every card cycles its pages at once, like the old IA search results.
- Right-to-left books scrub in the right direction. Light and dark themes follow the OS setting.

## Running locally

It's a static site with no build step:

```sh
python3 -m http.server 8000   # or: npm run serve
# open http://localhost:8000
```

Unit tests cover manifest parsing and URL resolution (Node 18+):

```sh
npm test
```

## Deploying

**GitHub Pages:** Settings → Pages → "Deploy from a branch" → pick the branch and `/ (root)`. The `.nojekyll` file makes Pages serve everything as-is.

**Hugging Face Spaces:** create a *Static* Space and push these files. HF needs this front-matter at the top of the Space's `README.md`:

```yaml
---
title: Book Scrubber
emoji: 📚
colorFrom: pink
colorTo: yellow
sdk: static
pinned: false
---
```

## Adding example books

Edit `js/examples.js`. The `input` field takes anything the paste box accepts. Then re-bake the shelf (next section).

## Baking the example shelf

So the homepage doesn't send every visitor's hovering to the libraries, the example shelf can be served from pre-downloaded thumbnails in `baked/`. That's 24 pages per book at 300px, fetched once.

- **On GitHub:** Actions tab → "Bake example shelf" → Run workflow. It runs the tests, bakes anything not yet baked, and commits the results to the branch you ran it on. Tick "force" to re-bake everything.
- **Locally:** `node scripts/bake-examples.mjs` (add `--force` to re-bake).

The baker sends one request at a time with a pause between them and identifies itself with a descriptive User-Agent. Until `baked/` exists, the site loads everything live, so baking is optional. Opening a book in the viewer always loads its full manifest live.

Before baking, check that you're comfortable re-hosting thumbnails of each example. Most are public domain, but each institution's terms apply.

## Being kind to image servers

Each resized page costs a IIIF server a decode of its master file, so the app keeps requests down:

- **Cheapest image first.** If a manifest lists a ready-made `thumbnail` of about the right size, that's used. Next come sizes the image server advertises as pre-rendered (`sizes`). Otherwise there are just two fixed widths, 300px and 800px, written in the canonical form for the server's Image API version (`w,h` for v3, `w,` for v2), so requests are more likely to hit caches other viewers have already warmed.
- **At most 3 requests at a time per server,** dropping to 2 or 1 when a server responds slowly. A request still waiting in the queue is dropped as soon as nobody needs it.
- **Backs off from failing servers.** After three failures in a row, that server's queue pauses for 2 seconds, doubling each time up to a minute.
- **Hover intent.** A card starts loading its pages only after the mouse rests on it for 150ms, and stops queueing when the mouse leaves.
- **Lazy viewer.** Opening a book loads a 24-page overview (the shelf's images), then small images near where you're scrubbing, plus one 800px image once you pause on a page. Closing it drops everything queued.
- **Remembers what it fetched.**
  - Manifests are kept in the browser (IndexedDB) for a week. If a refresh fails, the old copy is used.
  - A service worker (`sw.js`) keeps page images from CORS-enabled servers for 30 days, capped at 1,500, even when a server's own cache headers are short.
  - Small GIFs reuse images that are already loaded.
- **Stops when nobody's watching.** Playback, flash mode and the request queue pause while the tab is hidden. Browsers set to save data get 12 pages per scrub by default.
- **Baked shelf.** See above.

Measured against a fake IIIF server (with cache headers) in headless Chrome:

| Action | Requests |
|---|---|
| Page load, live shelf | 1 per card |
| Page load, hover and flash mode, baked shelf | 0 |
| Mouse sweeping across 5 cards | 0 |
| Brief hover (400ms), then leave | 6 |
| Full hover on one card | 23 total, then 0 on repeat hovers |
| Open viewer and sit 3s | about 26 (3 with a baked shelf) |
| Open viewer, close after 300ms | 6 |
| Fast mouse sweep across the viewer | about 23 |
| 300px GIF (16 frames) | 0 (reuses loaded images) |
| 480px GIF (16 frames) | about 14 |
| Reloading or reopening the page | 0 manifest requests (a week's cache) |
| Second visit to a server that forbids caching | 0 (service worker) |
| Manifest that lists ready-made thumbnails | shelf uses them: 0 resize requests |
| Server that always fails | about 1 request a second, then less |
| Slow server (3s per image) | drops to 1 request at a time |
| Tab hidden | 0 |

## For IIIF server administrators

Book Scrubber is a static web page. Everything runs in visitors' browsers, so requests come from their IP addresses, carrying this site's address in the `Referer` header. What it asks your server for:

- The manifest, once per book per visitor per week.
- Page images at 300px wide (shelf thumbnails and viewer overview), and at 800px for the page a viewer pauses on. A ready-made `thumbnail` or advertised `sizes` in your manifest are used instead when they're close to those widths. The quickest way to cut Book Scrubber's cost to your server is to publish either one.
- At most 3 requests at a time from any one browser, fewer if you're slow, pausing if you return errors. Nothing is requested for books a visitor isn't looking at.

The example shelf's thumbnails are downloaded once, by the "Bake example shelf" GitHub Action (User-Agent `book-scrubber example baker`), and served from this repository.

If Book Scrubber is causing you trouble, or you'd rather your collection not appear on the example shelf, please [open an issue](https://github.com/hadro/book-scrubber/issues) and it will be dealt with promptly.

## Analytics

Optional [GoatCounter](https://www.goatcounter.com) analytics: no cookies, no personal data. To enable it, set `GOATCOUNTER_CODE` in `js/analytics.js` to your site code (the `mycode` in `mycode.goatcounter.com`). While it's empty, nothing is loaded or sent.

Besides page views, it counts a few events:

| Event | What's recorded |
|---|---|
| `viewer/example/<title>` | An example book opened in the viewer |
| `viewer/pasted/<host>` | A pasted book opened, identified only by its server's hostname |
| `gif/…` | A GIF made (same labels as above) |
| `paste/ok/<host>`, `paste/fail/<host>` | A paste that worked or failed; hostname only, never the full URL |
| `flash-on` | Flash mode switched on |

Page views record the page path only. Share links keep the book in the `#m=…` part of the URL, which GoatCounter doesn't send.

## Known limits

- **GIFs need CORS.** The scrubber works with any IIIF server. Making a GIF means drawing the images onto a canvas, which works only when the image server sends `Access-Control-Allow-Origin`. When it doesn't, the viewer says so, and scrubbing still works. The fix would be a small proxy, for example a Hugging Face Space with a Python backend.
- **Level-0 image servers**, which serve only pre-made sizes, are handled when the manifest lists `sizes`. Otherwise the app falls back to the full image.
- IIIF **Collections** aren't supported yet. Paste one of the collection's manifests instead.
