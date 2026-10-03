// Polite fetching shared by every crawler: honors robots.txt, identifies itself, and reports
// bot challenges instead of trying to get past them.
import { setTimeout as sleep } from 'node:timers/promises';

import robotsParserModule from 'robots-parser';

import { USER_AGENT } from './config.ts';

// robots-parser is CommonJS (module.exports = fn) but its types declare an ES default export
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;

// Pause between requests to the same site: at least 1s, longer if robots.txt asks via
// Crawl-delay (capped at 10s so one site can't stall a worker indefinitely)
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;

export async function pauseFor(url: URL) {
  const robots = await robotsCache.get(url.origin);
  const crawlDelay = (robots?.getCrawlDelay(USER_AGENT) ?? 0) * 1000;
  await sleep(Math.min(Math.max(MIN_DELAY_MS, crawlDelay), MAX_DELAY_MS));
}

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

export async function robotsAllows(url: URL) {
  let robots = robotsCache.get(url.origin);
  if (!robots) {
    robots = loadRobots(url.origin);
    robotsCache.set(url.origin, robots);
  }
  const parsed = await robots;
  return parsed !== null && parsed.isAllowed(url.href, USER_AGENT) !== false;
}

// Page URLs listed in a site's sitemaps: those named in robots.txt, else /sitemap.xml.
// Follows sitemap indexes one level, preferring child sitemaps for pages or menus.
export async function sitemapPages(origin: string, maxChildSitemaps = 3) {
  const robots = await robotsCache.get(origin);
  const roots = robots?.getSitemaps().length ? robots.getSitemaps() : [`${origin}/sitemap.xml`];
  const pages = new Set<string>();
  const fetchLocs = async (href: string) => {
    const url = new URL(href);
    if (!(await robotsAllows(url))) return { pages: [], sitemaps: [] };
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { pages: [], sitemaps: [] };
    }
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) =>
      m[1].replace(/&amp;/g, '&'),
    );
    return /<sitemapindex/i.test(xml)
      ? { pages: [], sitemaps: locs }
      : { pages: locs, sitemaps: [] };
  };

  for (const root of roots.slice(0, 2)) {
    try {
      const top = await fetchLocs(root);
      top.pages.forEach((p) => pages.add(p));
      const children = top.sitemaps.sort(
        (a, b) => Number(/page|menu/i.test(b)) - Number(/page|menu/i.test(a)),
      );
      for (const child of children.slice(0, maxChildSitemaps)) {
        await pauseFor(new URL(child));
        (await fetchLocs(child)).pages.forEach((p) => pages.add(p));
      }
    } catch {
      // Missing or malformed sitemaps are common
    }
  }
  return [...pages];
}

export function blockVendor(res: Response, html: string) {
  if (res.headers.get('cf-mitigated')) return 'cloudflare';
  if (![401, 403, 429, 503].includes(res.status)) return null;
  if (/cloudflare/i.test(res.headers.get('server') ?? '')) return 'cloudflare';
  if (/datadome/i.test(html)) return 'datadome';
  if (/perimeterx|px-captcha/i.test(html)) return 'perimeterx';
  return `http_${res.status}`;
}

export async function getHtml(url: URL) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(20_000),
  });
  const isHtml = /html/i.test(res.headers.get('content-type') ?? '');
  const html = isHtml ? await res.text() : '';
  if (!isHtml) await res.body?.cancel();
  return { res, html, finalUrl: new URL(res.url) };
}

const MAX_PDF_BYTES = 25_000_000;

// Returns the PDF's bytes, or null for non-PDF responses, errors, and oversized files
export async function getPdf(url: URL) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
    signal: AbortSignal.timeout(60_000),
  });
  const type = res.headers.get('content-type') ?? '';
  const size = Number(res.headers.get('content-length') ?? 0);
  if (!res.ok || !/pdf|octet-stream/i.test(type) || size > MAX_PDF_BYTES) {
    await res.body?.cancel();
    return { res, bytes: null };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes: bytes.length <= MAX_PDF_BYTES ? bytes : null };
}

// Runs fn over items with a fixed number of workers, logging progress every 100 items
// onResult runs as each item finishes, e.g. to append it to an output file
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onResult?: (result: R) => unknown,
) {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const result = await fn(items[next++]);
        results.push(result);
        await onResult?.(result);
        if (results.length % 100 === 0) console.log(`  ${results.length}/${items.length}`);
      }
    }),
  );
  return results;
}
