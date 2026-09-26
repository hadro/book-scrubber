# Book Scrubber

Hover over a digitized book and wiggle your mouse to flip through its pages. Click one to open a flipbook with play controls, and to turn it into an animated GIF, a short video or a contact sheet.

It's a small homage to the animated book thumbnails that used to flicker through Internet Archive search results about ten years ago. It works with **any IIIF manifest**, so books from almost any library can go on the shelf.

## Features

- **Links to the source.** Every card links to its IIIF manifest and, when known, the item's page at its institution. The item page comes from, in order: a `page` set in `js/examples.js`, the manifest's `homepage` (v3) or `related` (v2), or the URL itself for IA, LoC, NYPL, e-codices, NGA and Yale. The viewer shows the same links.
- **Hover-scrubber cards.** Mouse position maps to a page. Pages load "coarse first" (ends, then middle, then quarters, and so on), so you can scrub the whole book almost at once. On phones, drag a finger sideways across a card.
- **Skips blank pages; "plates only" mode.** Each thumbnail is measured as it loads (brightness spread, colour and dark areas at 48×48 px) and labelled blank, text or plate. Blank pages are never shown while scrubbing. Turn on "Plates only" to scrub just the illustrations; the setting is remembered, and cards show "· plates" while it's filtering. Books with fewer than 3 detected plates show all non-blank pages instead. This works for servers that allow CORS and for the baked shelf; `js/analyze.js` has the thresholds.
- **Paste your own, or drag it in.** Accepts a IIIF Presentation v2 or v3 manifest or **collection** (its first 36 books go on the shelf), or a page URL from:
  - `archive.org/details/…`, or a bare IA identifier
  - `loc.gov/item/…`
  - `digitalcollections.nypl.org/items/…`
  - e-codices
  - National Gallery of Art Library catalog records (`library.nga.gov/discovery/fulldisplay?…docid=alma…`)
  - Any viewer link that carries the manifest in its URL (`?manifest=…`, `?iiif-content=…`, including encoded IIIF Content State), such as Universal Viewer or Mirador links

  You can also drag a IIIF logo or any of those links onto the page.

  Getty object pages can't be resolved automatically. Click the IIIF logo on the page and paste the `media.getty.edu/iiif/manifest/…` link.

  BHL doesn't publish IIIF manifests at a predictable address. Paste the book's archive.org link instead; BHL hosts its scans there.

  Pasted books stay on your shelf in `localStorage`.
- **Flipbook viewer.** Scrubbing, play/pause, speed control, boomerang mode and keyboard controls. Share links open the book at the page you're on (`#m=…&p=42`). The viewer also links to the item page and the manifest.
- **Exports.** GIF, video (WebM or MP4, whichever the browser can record) or a contact-sheet JPEG. Choose frames, width, speed and pages (no blanks, plates only, or all). A credit line with the title and institution is added by default. GIFs are encoded in the browser with [gifenc](https://github.com/mattdesl/gifenc), vendored in `vendor/`.
- **Flash mode.** Every card cycles its pages at once, like the old IA search results.
- Right-to-left books scrub in the right direction. Light and dark themes follow the OS setting.
- **Accessible.** Arrow keys scrub a focused card, and focus returns to the card when the viewer closes. The OS "reduce motion" setting slows flash mode and playback and turns off decorative animation.
- **Link previews.** Open Graph and Twitter card metadata, with a share image (`img/social-card.png`).

## Running locally

It's a static site with no build step:

```sh
python3 -m http.server 8000   # or: npm run serve
# open http://localhost:8000
```

Tests (Node 20+):

```sh
npm test                          # unit tests: parsing, URL resolution, page analysis, baking, health check
npx playwright install chromium   # once
npm run test:e2e                  # the real app in headless Chromium against a fake IIIF server
```

The end-to-end tests never contact real libraries. They start a local fake IIIF server whose books have blank, text and plate pages, and servers that lack CORS, fail, are slow, or forbid caching. They check scrubbing, politeness (request counts, backoff, caching), exports, collections, drag and drop, share links, touch and reduced motion. Both suites run on every push via `.github/workflows/test.yml`.

`?examples=0` in the URL hides the starter shelf.

## Deploying

**GitHub Pages:** one-time setup: Settings → Pages → Source: **GitHub Actions**. After that, every push to `main` deploys via `.github/workflows/pages.yml`, which also includes `baked/` when it exists.

The link-preview metadata in `index.html` assumes the site lives at `https://hadro.github.io/book-scrubber/`. Update those URLs if it moves or gets a custom domain. To change the share image, edit `tools/social-card.html` and run `npm run social-card`.

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

## Example health check

`.github/workflows/check-examples.yml` runs every Monday and can also be started by hand. For each example it fetches the manifest and a page image the way a browser on the live site would. It reports what works, which servers allow GIFs (CORS), and which offer ready-made thumbnails or sizes. A failing run means an example needs replacing; GitHub emails you when that happens. Locally: `npm run check-examples`.

## Being kind to image servers

Each resized page costs a IIIF server a decode of its master file, so the app keeps requests down:

- **Cheapest image first.** If a manifest lists a ready-made `thumbnail` of about the right size, that's used. Next come sizes the image server advertises as pre-rendered (`sizes`). Otherwise there are just two fixed widths, 300px and 800px, written in the canonical form for the server's Image API version (`w,h` for v3, `w,` for v2), so requests are more likely to hit caches other viewers have already warmed.
- **At most 3 requests at a time per server,** dropping to 2 or 1 when a server responds slowly. A request still waiting in the queue is dropped as soon as nobody needs it.
- **Backs off from failing servers.** After three failures in a row, that server's queue pauses for 2 seconds, doubling each time up to a minute.
- **Hover intent.** A card starts loading its pages only after the mouse rests on it for 150ms. If you move away within 600ms, whatever is still queued is dropped. After a longer, deliberate look, the card finishes loading its reel in the background, at most 3 requests at a time.
- **Lazy viewer.** Opening a book loads a 24-page overview (the shelf's images), then small images near where you're scrubbing, plus one 800px image once you pause on a page. Closing it drops everything queued.
- **Remembers what it fetched.**
  - Manifests are kept in the browser (IndexedDB) for a week. If a refresh fails, the old copy is used.
  - A service worker (`sw.js`) keeps page images from CORS-enabled servers for 30 days, capped at 1,500, even when a server's own cache headers are short.
  - Small GIFs reuse images that are already loaded.
  - Shelf cards reuse whatever the viewer loaded. A card frame shows its page from any size already loaded (baked, 300px or 800px). After you close the viewer, every page it loaded becomes an extra frame on that book's card, up to 150, so scrubbing gets finer without new downloads.
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
| `gif/…`, `video/…`, `sheet/…` | An export made (same labels as above) |
| `paste/collection/<host>` | A collection pasted |
| `drop` | Something dropped onto the page |
| `plates-on` | Plates-only mode switched on |
| `paste/ok/<host>`, `paste/fail/<host>` | A paste that worked or failed; hostname only, never the full URL |
| `flash-on` | Flash mode switched on |

Page views record the page path only. Share links keep the book in the `#m=…` part of the URL, which GoatCounter doesn't send.

## Known limits

- **GIFs need CORS.** The scrubber works with any IIIF server. Making a GIF means drawing the images onto a canvas, which works only when the image server sends `Access-Control-Allow-Origin`. When it doesn't, the viewer says so, and scrubbing still works. The fix would be a small proxy, for example a Hugging Face Space with a Python backend.
- **Level-0 image servers**, which serve only pre-made sizes, are handled when the manifest lists `sizes`. Otherwise the app falls back to the full image.
- **Collections** are read one level deep. Nested sub-collections aren't opened, so paste one of those directly.
- **Page detection is heuristic.** Unusual scans (dark backgrounds, colour charts, heavy bleed-through) can be misjudged. When a book has no detected plates, "plates only" falls back to all non-blank pages.
- **Link previews are site-wide.** Crawlers don't run JavaScript, so a shared book link previews as Book Scrubber, not as the book itself. Per-book previews would need a server.
