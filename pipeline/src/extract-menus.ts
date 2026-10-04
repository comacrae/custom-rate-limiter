// Extracts structured menus from the sites the probe could reach. Same politeness rules as the
// probe: robots.txt, identified user agent, one request per site at a time, no challenge bypass.
import { readFile } from 'node:fs/promises';

import * as cheerio from 'cheerio';

import { OUT_DIR } from './config.ts';
import { blockVendor, getHtml, robotsAllows, runPool, pauseFor, sitemapPages } from './http.ts';
import { jsonlWriter } from './jsonl.ts';
import {
  GENERIC_LABEL,
  labelFromUrl,
  menuSignature,
  parseMenuPage,
  type MenuDraft,
} from './menu-parsers.ts';
import type { Probe } from './probe-menus.ts';
import { isOwnLocationPage, isSisterDomain, nameTokens, siteHost, siteUrl } from './sites.ts';

const CONCURRENCY = 16;
const MAX_PAGES_PER_SITE = 10;
const MAX_SITEMAP_PAGES = 4;
const MENU_LINK =
  /menu|food|drink|brunch|lunch|dinner|breakfast|dessert|wine|cocktail|happy.?hour/i;
// Pages that mention food without being menus, e.g. "food-and-beverage-careers"
const NOT_MENU_LINK =
  /career|job|employ|hiring|franchis|press|news|blog|recipe|gift|privacy|terms|accessib|allergen|nutrition|login|account|cart|checkout/i;

const MAX_LOCATION_PAGES = 3;
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

  // viaMenuLink: reached through a link that looked like a menu, unlike the listed website,
  // which is sometimes an article or directory page rather than the restaurant's homepage
  const menuPages = probe.menuPages.filter((url) => !NOT_MENU_LINK.test(new URL(url).pathname));
  const queue: { url: string; label: string; viaMenuLink: boolean }[] = menuPages.length
    ? menuPages.map((url) => ({ url, label: '', viaMenuLink: true }))
    : [{ url: home.href, label: '', viaMenuLink: false }];
  const visited = new Set<string>();
  const signatures = new Set<string>();
  const pdfs = new Set(probe.pdfs);
  const tokens = nameTokens(probe.name);
  const allowedHosts = new Set([host]);
  let locationHops = 0;

  let pageLimit = MAX_PAGES_PER_SITE;
  for (let pass = 0; pass < 2; pass++) {
    // Second pass: when links led to no menu, look for menu pages in the site's sitemap
    if (pass === 1) {
      if (result.pages.length || result.blocked) break;
      const fromSitemap = (await sitemapPages(home.origin))
        .filter((href) => {
          try {
            const url = new URL(href);
            return (
              siteHost(href) === host &&
              // Sitemaps list every page, so food words alone (recipes, blog posts) aren't enough
              /menu/i.test(url.pathname) &&
              !NOT_MENU_LINK.test(url.pathname) &&
              !visited.has(url.href)
            );
          } catch {
            return false;
          }
        })
        .slice(0, MAX_SITEMAP_PAGES);
      if (!fromSitemap.length) break;
      queue.push(...fromSitemap.map((url) => ({ url, label: '', viaMenuLink: true })));
      pageLimit = visited.size + MAX_SITEMAP_PAGES;
    }
    while (queue.length && visited.size < pageLimit) {
      const { url, label, viaMenuLink } = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const pageUrl = new URL(url);
      if (!(await robotsAllows(pageUrl))) continue;
      if (visited.size > 1) await pauseFor(pageUrl);

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
        if (!link.protocol.startsWith('http') || visited.has(link.href)) return;
        const linkHost = siteHost(link.href);
        // Restaurant groups keep each restaurant on a sister domain ("smythandtheloyalist.com"
        // links to "smythchicago.com"); allow one hop when the domain carries the name
        if (!allowedHosts.has(linkHost)) {
          if (allowedHosts.size < 3 && isSisterDomain(linkHost, tokens)) {
            allowedHosts.add(linkHost);
            queue.push({ url: link.href, label: '', viaMenuLink: false });
          }
          return;
        }
        if (NOT_MENU_LINK.test(link.pathname)) return;
        // Location and city pages on group sites lead to the menus ("/location/the-dining-room-
        // at-moody-tongue/", "/chicago"); they aren't menus themselves
        if (!MENU_LINK.test(`${link.pathname} ${text}`)) {
          if (locationHops < MAX_LOCATION_PAGES && isOwnLocationPage(link.pathname, tokens)) {
            locationHops++;
            queue.push({ url: link.href, label: '', viaMenuLink: false });
          }
          return;
        }
        if (link.pathname.toLowerCase().endsWith('.pdf')) {
          pdfs.add(link.href);
        } else if (!visited.has(link.href)) {
          const linkLabel = text.length <= 40 ? tidyLabel(text) : '';
          queue.push({ url: link.href, label: linkLabel, viaMenuLink: true });
        }
      });

      const parsed = parseMenuPage($, { knownMenuPage: viaMenuLink });
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
      if (menus.length)
        result.pages.push({ url: page.finalUrl.href, parser: parsed.parser, menus });
    }
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
