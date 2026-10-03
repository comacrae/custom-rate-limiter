// Parses the menu PDFs found during extraction. Same politeness rules as the other crawlers.
import { readFile } from 'node:fs/promises';

import { OUT_DIR } from './config.ts';
import type { SiteMenus } from './extract-menus.ts';
import { blockVendor, getPdf, robotsAllows, runPool, pauseFor } from './http.ts';
import { jsonlWriter } from './jsonl.ts';
import { labelFromUrl, menuSignature } from './menu-parsers.ts';
import { parsePdfMenu } from './pdf-parser.ts';

const CONCURRENCY = 12;
const MAX_PDFS_PER_SITE = 4;

async function extractPdfs(site: SiteMenus): Promise<SiteMenus> {
  const result: SiteMenus = { ...site, fetchedAt: new Date().toISOString(), pages: [], pdfs: [] };
  // Skip PDFs that repeat a menu already found in HTML
  const signatures = new Set(site.pages.flatMap((p) => p.menus.map(menuSignature)));

  for (const [index, href] of site.pdfs.slice(0, MAX_PDFS_PER_SITE).entries()) {
    const url = new URL(href);
    if (!(await robotsAllows(url))) continue;
    if (index > 0) await pauseFor(url);
    try {
      const { res, bytes } = await getPdf(url);
      const blocked = blockVendor(res, '');
      if (blocked) {
        result.blocked = blocked;
        break;
      }
      if (!bytes) continue;
      const items = await parsePdfMenu(bytes);
      const menu = { name: labelFromUrl(url), items };
      if (!items.length || signatures.has(menuSignature(menu))) continue;
      signatures.add(menuSignature(menu));
      result.pages.push({ url: href, parser: 'pdf', menus: [menu] });
    } catch {
      // Corrupt or unusual PDFs shouldn't stop the run
    }
  }
  return result;
}

const sites: SiteMenus[] = (
  await readFile(new URL(process.env.MENUS_FILE ?? 'menus.jsonl', OUT_DIR), 'utf8')
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const targets = sites
  .filter((s) => s.pdfs.length && !s.blocked)
  .slice(0, Number(process.env.LIMIT) || undefined);
console.log(`Parsing PDFs from ${targets.length} sites`);

const write = await jsonlWriter<SiteMenus>(process.env.PDF_MENUS_FILE ?? 'pdf-menus.jsonl');
const results = (
  await runPool(targets, CONCURRENCY, extractPdfs, (r) => r.pages.length && write(r))
).filter((r) => r.pages.length);
const items = results.reduce(
  (n, r) => n + r.pages.reduce((m, p) => m + p.menus[0].items.length, 0),
  0,
);
console.log(
  `Sites with PDF menus: ${results.length}, menus: ${results.reduce((n, r) => n + r.pages.length, 0)}, items: ${items}`,
);
