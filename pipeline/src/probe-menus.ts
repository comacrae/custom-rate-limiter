// Measures how Chicagoland restaurant websites publish their menus. Does not extract menus.
// Polite by design: honors robots.txt, identifies itself, one request per site at a time,
// and records bot challenges instead of trying to get past them.
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import * as cheerio from 'cheerio';

import { OUT_DIR } from './config.ts';
import type { Restaurant } from './fetch-restaurants.ts';
import { blockVendor, getHtml, robotsAllows, runPool, SAME_SITE_DELAY_MS } from './http.ts';
import { siteHost, siteUrl } from './sites.ts';

const CONCURRENCY = 16;
const MAX_MENU_PAGES = 2;
// A few $ amounts on a homepage are usually specials; a real menu has many
const MIN_MENU_PRICES = 10;

type Outcome = 'ok' | 'blocked' | 'robots_disallowed' | 'unreachable';
// jsonld: schema.org MenuItem markup; html: prices in page text; pdf: linked PDF menu;
// menu_page_no_prices: a menu page without $ prices in its HTML — an unpriced text menu,
// an image menu, a JavaScript-rendered menu, or a hub linking to sub-menus
type Format = 'jsonld' | 'html' | 'pdf' | 'menu_page_no_prices' | 'ordering_link' | 'none';

export type Probe = {
  name: string;
  website: string;
  outcome: Outcome;
  detail?: string;
  platform: string | null;
  format: Format | null;
  menuItems: number;
  maxPrices: number;
  menuPages: string[];
  pdfs: string[];
  ordering: string[];
};

const PLATFORMS: [string, RegExp][] = [
  ['bentobox', /getbento\.com|bentobox/i],
  ['popmenu', /popmenu/i],
  ['owner.com', /owner\.com/i],
  ['spothopper', /spothopper/i],
  ['squarespace', /squarespace/i],
  ['wix', /wixstatic\.com|wix\.com/i],
  ['webflow', /webflow/i],
  ['godaddy', /wsimg\.com/i],
  ['weebly', /weebly/i],
  ['shopify', /cdn\.shopify\.com/i],
  ['wordpress', /wp-content|wp-includes/i],
];

const ORDERING_HOSTS = [
  'toasttab.com',
  'square.site',
  'chownow.com',
  'olo.com',
  'slicelife.com',
  'clover.com',
  'doordash.com',
  'ubereats.com',
  'grubhub.com',
  'seamless.com',
  'order.online',
];

const PRICE = /\$\s?\d{1,3}(?:\.\d{2})?\b/g;
const PDF_MENU_HINT = /menu|dinner|lunch|brunch|breakfast|food|drink|wine|cocktail/i;

function countMenuJsonLd(node: unknown, found: { items: number; menuUrls: string[] }) {
  if (Array.isArray(node)) {
    for (const child of node) countMenuJsonLd(child, found);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const types = [obj['@type']].flat();
  if (types.includes('MenuItem')) found.items++;
  for (const key of ['hasMenu', 'menu']) {
    if (typeof obj[key] === 'string') found.menuUrls.push(obj[key]);
  }
  for (const value of Object.values(obj)) countMenuJsonLd(value, found);
}

function analyze(html: string, pageUrl: URL) {
  const $ = cheerio.load(html);
  const jsonLd = { items: 0, menuUrls: [] as string[] };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      countMenuJsonLd(JSON.parse($(el).text()), jsonLd);
    } catch {
      // Malformed JSON-LD is common; ignore it
    }
  });
  const menuItems = jsonLd.items + $('[itemtype*="schema.org/MenuItem"]').length;

  const pageHost = pageUrl.hostname.replace(/^www\./, '');
  const menuLinks = new Set<string>();
  const pdfs = new Set<string>();
  const ordering = new Set<string>();
  const hrefs = $('a[href]')
    .map((_, a) => ({ href: $(a).attr('href') ?? '', text: $(a).text() }))
    .get()
    .concat(jsonLd.menuUrls.map((href) => ({ href, text: 'menu' })));

  for (const { href, text } of hrefs) {
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (!url.protocol.startsWith('http')) continue;
    url.hash = '';
    const host = url.hostname.replace(/^www\./, '');
    const orderingHost = ORDERING_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
    if (orderingHost) ordering.add(orderingHost);
    else if (url.pathname.toLowerCase().endsWith('.pdf')) {
      if (PDF_MENU_HINT.test(`${url.pathname} ${text}`)) pdfs.add(url.href);
    } else if (
      host === pageHost &&
      /menu/i.test(`${url.pathname} ${text}`) &&
      url.href !== pageUrl.href
    ) {
      menuLinks.add(url.href);
    }
  }

  return {
    menuItems,
    prices: ($('body').text().match(PRICE) ?? []).length,
    platform: PLATFORMS.find(([, re]) => re.test(html))?.[0] ?? null,
    menuLinks: [...menuLinks],
    pdfs: [...pdfs],
    ordering: [...ordering],
  };
}

type Site = { name: string; website: string };

async function probe(r: Site): Promise<Probe> {
  const result: Probe = {
    name: r.name,
    website: r.website,
    outcome: 'ok',
    platform: null,
    format: null,
    menuItems: 0,
    maxPrices: 0,
    menuPages: [],
    pdfs: [],
    ordering: [],
  };

  let url: URL;
  try {
    url = siteUrl(r.website);
  } catch {
    return { ...result, outcome: 'unreachable', detail: 'invalid url' };
  }

  // Listed URLs are often stale deep links or sit behind broken HTTPS; fall back to the
  // homepage, then to plain HTTP. Dead domains (DNS failures) aren't retried.
  const candidates = [url, new URL('/', url), new URL(`http://${url.host}/`)].filter(
    (c, i, all) => all.findIndex((o) => o.href === c.href) === i,
  );
  let home;
  for (const candidate of candidates) {
    if (!(await robotsAllows(candidate))) return { ...result, outcome: 'robots_disallowed' };
    try {
      const page = await getHtml(candidate);
      const blocked = blockVendor(page.res, page.html);
      if (blocked) return { ...result, outcome: 'blocked', detail: blocked };
      if (page.res.ok) {
        home = page;
        result.website = candidate.href;
        break;
      }
      result.outcome = 'unreachable';
      result.detail = `http_${page.res.status}`;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      result.outcome = 'unreachable';
      result.detail = cause ?? (err as Error).name;
      if (cause === 'ENOTFOUND') break;
    }
    await sleep(SAME_SITE_DELAY_MS);
  }
  if (!home) return result;
  result.outcome = 'ok';
  delete result.detail;

  const homeInfo = analyze(home.html, home.finalUrl);
  const pdfs = new Set(homeInfo.pdfs);
  const ordering = new Set(homeInfo.ordering);
  result.platform = homeInfo.platform;
  result.menuItems = homeInfo.menuItems;
  result.maxPrices = homeInfo.prices;
  let menuPageWithoutPrices = false;

  if (result.menuItems === 0) {
    for (const link of homeInfo.menuLinks.slice(0, MAX_MENU_PAGES)) {
      const pageUrl = new URL(link);
      if (!(await robotsAllows(pageUrl))) continue;
      await sleep(SAME_SITE_DELAY_MS);
      try {
        const page = await getHtml(pageUrl);
        if (!page.res.ok || !page.html) continue;
        const info = analyze(page.html, page.finalUrl);
        result.menuPages.push(page.finalUrl.href);
        result.menuItems += info.menuItems;
        result.maxPrices = Math.max(result.maxPrices, info.prices);
        info.pdfs.forEach((p) => pdfs.add(p));
        info.ordering.forEach((o) => ordering.add(o));
        if (info.prices < MIN_MENU_PRICES) menuPageWithoutPrices = true;
        if (info.menuItems > 0) break;
      } catch {
        // One bad menu page shouldn't sink the whole probe
      }
    }
  }

  result.pdfs = [...pdfs];
  result.ordering = [...ordering];
  result.format =
    result.menuItems > 0
      ? 'jsonld'
      : result.maxPrices >= MIN_MENU_PRICES
        ? 'html'
        : result.pdfs.length > 0
          ? 'pdf'
          : menuPageWithoutPrices
            ? 'menu_page_no_prices'
            : result.ordering.length > 0
              ? 'ordering_link'
              : 'none';
  return result;
}

function tally(values: (string | null)[]) {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v ?? '(none)', (counts.get(v ?? '(none)') ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
}

const restaurants: Restaurant[] = JSON.parse(
  await readFile(new URL('restaurants.json', OUT_DIR), 'utf8'),
);

// Chains share one host across locations; probe each host once so no site gets parallel requests
const bySite = new Map<string, Site>();
for (const { name, website } of restaurants) {
  if (!website) continue;
  let host;
  try {
    host = siteHost(website);
  } catch {
    continue;
  }
  if (!bySite.has(host)) bySite.set(host, { name, website });
}
// RETRY_FROM=probe.jsonl re-probes only the sites that were unreachable for a fixable reason
let sites = [...bySite.values()];
if (process.env.RETRY_FROM) {
  const previous: Probe[] = (await readFile(new URL(process.env.RETRY_FROM, OUT_DIR), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  sites = previous
    .filter((p) => p.outcome === 'unreachable' && p.detail !== 'ENOTFOUND')
    .map(({ name, website }) => ({ name, website }));
}
// SKIP_PROBED_FROM=probe.jsonl probes only sites that file doesn't cover (new places)
if (process.env.SKIP_PROBED_FROM) {
  const probed = new Set(
    (await readFile(new URL(process.env.SKIP_PROBED_FROM, OUT_DIR), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => siteHost((JSON.parse(line) as Probe).website)),
  );
  sites = sites.filter((s) => !probed.has(siteHost(s.website)));
}
const queue = sites.slice(0, Number(process.env.LIMIT) || undefined);
console.log(`${restaurants.length} restaurants, probing ${queue.length} unique sites`);

const results = await runPool(queue, CONCURRENCY, probe);

await writeFile(
  new URL(process.env.PROBE_OUT ?? 'probe.jsonl', OUT_DIR),
  results.map((r) => JSON.stringify(r)).join('\n'),
);

const ok = results.filter((r) => r.outcome === 'ok');
const blocked = results.filter((r) => r.outcome === 'blocked');
console.log(
  JSON.stringify(
    {
      sites: results.length,
      outcome: tally(results.map((r) => r.outcome)),
      blockedBy: tally(blocked.map((r) => r.detail ?? null)),
      formatOfReachable: tally(ok.map((r) => r.format)),
      platform: tally(ok.map((r) => r.platform)),
      jsonldByPlatform: tally(ok.filter((r) => r.format === 'jsonld').map((r) => r.platform)),
      orderingLinks: tally(ok.flatMap((r) => r.ordering)),
    },
    null,
    2,
  ),
);
