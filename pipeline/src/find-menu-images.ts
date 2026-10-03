// Finds menus published as images on sites whose menu pages had no text menu, and records the
// image URLs so the app can link to them. OCR was tested and was too noisy to store as items.
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

import { OUT_DIR } from './config.ts';
import type { SiteMenus } from './extract-menus.ts';
import { blockVendor, getHtml, robotsAllows, runPool, SAME_SITE_DELAY_MS } from './http.ts';
import type { Probe } from './probe-menus.ts';
import { siteHost } from './sites.ts';

const CONCURRENCY = 16;
const MAX_MENU_PAGES = 2;
const MAX_IMAGES_PER_SITE = 8;
// The file name or alt text has to say it's a menu; food photos otherwise slip in
const MENU_IMAGE =
  /menu|drink|food|bev|wine|cocktail|brunch|lunch|dinner|dessert|happy.?hour|specials/i;
const NOT_A_MENU =
  /logo|icon|favicon|banner|header|hero|social|facebook|instagram|yelp|badge|award/i;

export type SiteImages = { siteHost: string; images: string[]; foundAt: string };

// Largest candidate from srcset, data-src (lazy loading), or src
function imageUrl(img: cheerio.Cheerio<Element>, base: URL) {
  const srcset = img.attr('srcset') ?? img.attr('data-srcset');
  const fromSrcset = srcset
    ?.split(',')
    .map((s) => s.trim().split(/\s+/))
    .sort((a, b) => parseInt(b[1] ?? '0') - parseInt(a[1] ?? '0'))[0]?.[0];
  const src = fromSrcset ?? img.attr('data-src') ?? img.attr('src');
  if (!src || src.startsWith('data:')) return null;
  try {
    return new URL(src, base);
  } catch {
    return null;
  }
}

async function findImages(probe: Probe): Promise<SiteImages> {
  const images = new Set<string>();
  for (const [index, pageHref] of probe.menuPages.slice(0, MAX_MENU_PAGES).entries()) {
    const pageUrl = new URL(pageHref);
    if (!(await robotsAllows(pageUrl))) continue;
    if (index > 0) await sleep(SAME_SITE_DELAY_MS);
    try {
      const page = await getHtml(pageUrl);
      if (blockVendor(page.res, page.html)) break;
      if (!page.res.ok) continue;
      const $ = cheerio.load(page.html);
      $('img').each((_, el) => {
        const img = $(el);
        const url = imageUrl(img, page.finalUrl);
        if (!url || !/\.(jpe?g|png|webp)$/i.test(url.pathname)) return;
        const label = `${decodeURIComponent(url.pathname)} ${img.attr('alt') ?? ''}`;
        if (MENU_IMAGE.test(label) && !NOT_A_MENU.test(label)) images.add(url.href);
      });
    } catch {
      // Skip pages that fail to load
    }
  }
  return {
    siteHost: siteHost(probe.website),
    images: [...images].slice(0, MAX_IMAGES_PER_SITE),
    foundAt: new Date().toISOString(),
  };
}

const probes: Probe[] = (
  await readFile(new URL(process.env.PROBE_FILE ?? 'probe.jsonl', OUT_DIR), 'utf8')
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

// Only sites whose extraction found no text menu
const withMenus = new Set<string>();
for (const file of (process.env.MENUS_FILES ?? 'menus.jsonl,pdf-menus.jsonl').split(',')) {
  try {
    for (const line of (await readFile(new URL(file, OUT_DIR), 'utf8')).trim().split('\n')) {
      const site: SiteMenus = JSON.parse(line);
      if (site.pages.length || site.blocked) withMenus.add(site.siteHost);
    }
  } catch {
    // Missing file: nothing to skip
  }
}
const targets = probes
  .filter((p) => p.outcome === 'ok' && p.menuPages.length && !withMenus.has(siteHost(p.website)))
  .slice(0, Number(process.env.LIMIT) || undefined);
console.log(`Looking for menu images on ${targets.length} sites`);

const results = (await runPool(targets, CONCURRENCY, findImages)).filter((r) => r.images.length);
await writeFile(
  new URL(process.env.IMAGES_FILE ?? 'menu-images.jsonl', OUT_DIR),
  results.map((r) => JSON.stringify(r)).join('\n'),
);
console.log(
  `Sites with menu images: ${results.length}, images: ${results.reduce((n, r) => n + r.images.length, 0)}`,
);
