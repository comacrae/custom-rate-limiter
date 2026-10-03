// Polite fetching shared by every crawler: honors robots.txt, identifies itself, and reports
// bot challenges instead of trying to get past them.
import robotsParserModule from 'robots-parser';

import { USER_AGENT } from './config.ts';

// robots-parser is CommonJS (module.exports = fn) but its types declare an ES default export
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;

// Pause between requests to the same site
export const SAME_SITE_DELAY_MS = 1000;

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
export async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>) {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        results.push(await fn(items[next++]));
        if (results.length % 100 === 0) console.log(`  ${results.length}/${items.length}`);
      }
    }),
  );
  return results;
}
