#!/usr/bin/env node
// Renders tools/social-card.html to img/social-card.png (1200×630, for link
// previews) and img/apple-touch-icon.png (180×180). Needs the dev dependencies:
//   npm install && node scripts/make-social-card.mjs
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto(pathToFileURL(join(root, "tools/social-card.html")).href);
await page.evaluate(() => document.fonts.ready);
await page.locator("#card").screenshot({ path: join(root, "img/social-card.png") });
await page.locator("#icon").screenshot({ path: join(root, "img/apple-touch-icon.png") });
await browser.close();
console.log("wrote img/social-card.png and img/apple-touch-icon.png");
