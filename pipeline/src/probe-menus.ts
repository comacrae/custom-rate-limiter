// Measures how Chicagoland restaurant websites publish their menus. Does not extract menus.
// Polite by design: honors robots.txt, identifies itself, one request per site at a time,
// and records bot challenges instead of trying to get past them.
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import * as cheerio from 'cheerio';
import robotsParserModule from 'robots-parser';

import { OUT_DIR, USER_AGENT } from './config.ts';
import type { Restaurant } from './fetch-restaurants.ts';

// robots-parser is CommonJS (module.exports = fn) but its types declare an ES default export
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;

const CONCURRENCY = 16;
const SAME_SITE_DELAY_MS = 1000;
const MAX_MENU_PAGES = 2;
// A few $ amounts on a homepage are usually specials; a real menu has many
const MIN_MENU_PRICES = 10;

type Outcome = 'ok' | 'blocked' | 'robots_disallowed' | 'unreachable';
// jsonld: schema.org MenuItem markup; html: prices in page text; pdf: linked PDF menu;
// menu_page_no_prices: a menu page without $ prices in its HTML — an unpriced text menu,
// an image menu, a JavaScript-rendered menu, or a hub linking to sub-menus
type Format = 'jsonld' | 'html' | 'pdf' | 'menu_page_no_prices' | 'ordering_link' | 'none';

type Probe = {
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

const robotsCache = new Map<string, Promise<ReturnType<typeof robotsParser> | null>>();

async function loadRobots(origin: string) {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const res = await fetch(robotsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    // Convention: 4xx means no rules; 5xx means stay away
    if (res.status >= 500) return null;
    return robotsParser(robotsUrl, res.ok ? await res.text() : '');
  } catch {
    // Unreachable host: let the page fetch report it
    return robotsParser(robotsUrl, '');
  }
}

async function robotsAllows(url: URL) {
  let robots = robotsCache.get(url.origin);
  if (!robots) {
    robots = loadRobots(url.origin);
    robotsCache.set(url.origin, robots);
  }
  const parsed = await robots;
  return parsed !== null && parsed.isAllowed(url.href, USER_AGENT) !== false;
}

function blockVendor(res: Response, html: string) {
  if (res.headers.get('cf-mitigated')) return 'cloudflare';
  if (![401, 403, 429, 503].includes(res.status)) return null;
  if (/cloudflare/i.test(res.headers.get('server') ?? '')) return 'cloudflare';
  if (/datadome/i.test(html)) return 'datadome';
  if (/perimeterx|px-captcha/i.test(html)) return 'perimeterx';
  return `http_${res.status}`;
}

async function getHtml(url: URL) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(20_000),
  });
  const isHtml = /html/i.test(res.headers.get('content-type') ?? '');
  const html = isHtml ? await res.text() : '';
  if (!isHtml) await res.body?.cancel();
  return { res, html, finalUrl: new URL(res.url) };
}

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

async function probe(r: Restaurant): Promise<Probe> {
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
    url = new URL(/^https?:\/\//i.test(r.website) ? r.website : `https://${r.website}`);
  } catch {
    return { ...result, outcome: 'unreachable', detail: 'invalid url' };
  }
  if (!(await robotsAllows(url))) return { ...result, outcome: 'robots_disallowed' };

  let home;
  try {
    home = await getHtml(url);
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return { ...result, outcome: 'unreachable', detail: cause ?? (err as Error).name };
  }
  const blocked = blockVendor(home.res, home.html);
  if (blocked) return { ...result, outcome: 'blocked', detail: blocked };
  if (!home.res.ok) {
    return { ...result, outcome: 'unreachable', detail: `http_${home.res.status}` };
  }

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
const bySite = new Map<string, Restaurant>();
for (const r of restaurants) {
  const key = r.website
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .split(/[/?#]/)[0];
  if (!bySite.has(key)) bySite.set(key, r);
}
const queue = [...bySite.values()].slice(0, Number(process.env.LIMIT) || undefined);
console.log(`${restaurants.length} restaurants, probing ${queue.length} unique sites`);

const results: Probe[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < queue.length) {
      const r = queue[next++];
      results.push(await probe(r));
      if (results.length % 100 === 0) console.log(`  ${results.length}/${queue.length}`);
    }
  }),
);

await writeFile(new URL('probe.jsonl', OUT_DIR), results.map((r) => JSON.stringify(r)).join('\n'));

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
