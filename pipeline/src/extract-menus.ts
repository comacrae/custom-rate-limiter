// Extracts structured menus from the sites the probe could reach. Same politeness rules as the
// probe: robots.txt, identified user agent, one request per site at a time, no challenge bypass.
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import * as cheerio from 'cheerio';

import { OUT_DIR } from './config.ts';
import { blockVendor, getHtml, robotsAllows, runPool, SAME_SITE_DELAY_MS } from './http.ts';
import { jsonlWriter } from './jsonl.ts';
import {
  GENERIC_LABEL,
  labelFromUrl,
  menuSignature,
  parseMenuPage,
  type MenuDraft,
} from './menu-parsers.ts';
import type { Probe } from './probe-menus.ts';
import { siteHost, siteUrl } from './sites.ts';

const CONCURRENCY = 16;
const MAX_PAGES_PER_SITE = 8;
const MENU_LINK =
  /menu|food|drink|brunch|lunch|dinner|breakfast|dessert|wine|cocktail|happy.?hour/i;

// "VIEW CATERING MENU" → "CATERING MENU"
const tidyLabel = (label: string) => label.replace(/^(view|see|our|click for|download)\s+/i, '');

export type ExtractedPage = { url: string; parser: string; menus: MenuDraft[] };

export type SiteMenus = {
  siteHost: string;
  website: string;
  fetchedAt: string;
  pages: ExtractedPage[];
  pdfs: string[];
  blocked?: string;
};

async function extractSite(probe: Probe): Promise<SiteMenus> {
  const home = siteUrl(probe.website);
  const host = siteHost(probe.website);
  const result: SiteMenus = {
    siteHost: host,
    website: probe.website,
    fetchedAt: new Date().toISOString(),
    pages: [],
    pdfs: [...probe.pdfs],
  };

  const queue: { url: string; label: string }[] = probe.menuPages.length
    ? probe.menuPages.map((url) => ({ url, label: '' }))
    : [{ url: home.href, label: '' }];
  const visited = new Set<string>();
  const signatures = new Set<string>();
  const pdfs = new Set(probe.pdfs);

  while (queue.length && visited.size < MAX_PAGES_PER_SITE) {
    const { url, label } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    const pageUrl = new URL(url);
    if (!(await robotsAllows(pageUrl))) continue;
    if (visited.size > 1) await sleep(SAME_SITE_DELAY_MS);

    let page;
    try {
      page = await getHtml(pageUrl);
    } catch {
      continue;
    }
    const blocked = blockVendor(page.res, page.html);
    if (blocked) {
      result.blocked = blocked;
      break;
    }
    if (!page.res.ok || !page.html) continue;

    const $ = cheerio.load(page.html);
    // Collect more menu pages and PDFs before parsing, since the generic parser prunes the DOM
    $('a[href]').each((_, a) => {
      let link: URL;
      try {
        link = new URL($(a).attr('href') ?? '', page.finalUrl);
      } catch {
        return;
      }
      link.hash = '';
      const text = $(a).text().replace(/\s+/g, ' ').trim();
      if (!link.protocol.startsWith('http') || siteHost(link.href) !== host) return;
      if (link.pathname.toLowerCase().endsWith('.pdf')) {
        if (MENU_LINK.test(`${link.pathname} ${text}`)) pdfs.add(link.href);
      } else if (MENU_LINK.test(`${link.pathname} ${text}`) && !visited.has(link.href)) {
        queue.push({ url: link.href, label: text.length <= 40 ? tidyLabel(text) : '' });
      }
    });

    // Pages other than the homepage were reached through menu links
    const parsed = parseMenuPage($, { knownMenuPage: page.finalUrl.pathname !== '/' });
    if (!parsed) continue;
    const fallbackName =
      (label && !GENERIC_LABEL.test(label) ? label : '') || labelFromUrl(page.finalUrl);
    const menus = parsed.menus
      .map((m) => ({ ...m, name: m.name || fallbackName }))
      .filter((m) => {
        const signature = menuSignature(m);
        if (signatures.has(signature)) return false;
        signatures.add(signature);
        return true;
      });
    if (menus.length) result.pages.push({ url: page.finalUrl.href, parser: parsed.parser, menus });
  }

  result.pdfs = [...pdfs];
  return result;
}

const probeFile = new URL(process.env.PROBE_FILE ?? 'probe.jsonl', OUT_DIR);
const probes: Probe[] = (await readFile(probeFile, 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
// SKIP_DONE_FROM=menus.jsonl re-runs only sites that produced no menus in that earlier run
const done = new Set<string>();
if (process.env.SKIP_DONE_FROM) {
  for (const line of (await readFile(new URL(process.env.SKIP_DONE_FROM, OUT_DIR), 'utf8'))
    .trim()
    .split('\n')) {
    const site: SiteMenus = JSON.parse(line);
    if (site.pages.length || site.blocked) done.add(site.siteHost);
  }
}
const targets = probes
  .filter((p) => p.outcome === 'ok' && !done.has(siteHost(p.website)))
  .slice(0, Number(process.env.LIMIT) || undefined);
console.log(`Extracting menus from ${targets.length} reachable sites`);

const write = await jsonlWriter<SiteMenus>(process.env.MENUS_FILE ?? 'menus.jsonl');
const results = await runPool(targets, CONCURRENCY, extractSite, write);

const withMenus = results.filter((r) => r.pages.length);
const items = withMenus.reduce(
  (n, r) =>
    n + r.pages.reduce((m, p) => m + p.menus.reduce((k, menu) => k + menu.items.length, 0), 0),
  0,
);
const byParser: Record<string, number> = {};
for (const r of withMenus)
  for (const p of r.pages) byParser[p.parser] = (byParser[p.parser] ?? 0) + 1;
console.log(
  JSON.stringify(
    {
      sites: results.length,
      sitesWithMenus: withMenus.length,
      menuItems: items,
      pagesByParser: byParser,
      sitesWithPdfs: results.filter((r) => r.pdfs.length).length,
      blockedDuringExtraction: results.filter((r) => r.blocked).length,
    },
    null,
    2,
  ),
);
