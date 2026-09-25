# Book Scrubber

Hover over a digitized book and wiggle your mouse to flip through its pages. Click one to open a flipbook with play controls, and to turn it into an animated GIF.

It's a small homage to the animated book thumbnails that used to flicker through Internet Archive search results about ten years ago. It works with **any IIIF manifest**, so books from almost any library can go on the shelf.

## Features

- **Hover-scrubber cards.** Mouse position maps to a page. Pages load "coarse first" (ends, then middle, then quarters, and so on), so you can scrub the whole book almost at once. On phones, drag a finger sideways across a card.
- **Paste your own.** Accepts a IIIF Presentation v2 or v3 manifest URL, or a page URL from:
  - `archive.org/details/…`, or a bare IA identifier
  - `loc.gov/item/…`
  - `digitalcollections.nypl.org/items/…`
  - `biodiversitylibrary.org/item/…`
  - e-codices

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

Edit `js/examples.js`. The `input` field takes anything the paste box accepts.

## Known limits

- **GIFs need CORS.** The scrubber works with any IIIF server. Making a GIF means drawing the images onto a canvas, which works only when the image server sends `Access-Control-Allow-Origin`. When it doesn't, the viewer says so, and scrubbing still works. The fix would be a small proxy, for example a Hugging Face Space with a Python backend.
- **Be kind to servers.** Image requests go through a queue capped at six at a time. Pages load only when you hover or open a book. Flash mode loads more.
- **Level-0 image servers**, which serve only pre-made sizes, are handled when the manifest lists `sizes`. Otherwise the app falls back to the full image.
- IIIF **Collections** aren't supported yet. Paste one of the collection's manifests instead.
