// Adds price tier, cuisines, and neighborhood from the DineChicago API to matching restaurants.
// The API is free for commercial use with attribution (https://dinechicago.com/api-terms).
// Its robots.txt asks crawlers to stay off /api/, so this uses it as an API: paginated list
// requests only, one at a time, honoring 429/5xx. REFRESH=1 re-downloads; otherwise the
// cached out/dinechicago.json is reused.
import { access, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import postgres from 'postgres';

import { OUT_DIR } from './config.ts';
import { metersBetween, namesOverlap, PIN_RADIUS_M } from './sites.ts';

const API = 'https://dinechicago.com/api/v1/businesses';
const USER_AGENT = 'MenuBuff/0.1 (+https://github.com/comacrae/menubuff)';
const PAGE = 100;
const DELAY_MS = 1500;

type Business = {
  slug: string;
  name: string;
  neighborhood: string | null;
  cuisines: string[] | null;
  priceTier: number | null;
  status: string | null;
  latitude: number | null;
  longitude: number | null;
};

async function getPage(offset: number): Promise<{ data: Business[]; meta: { total?: number } }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}?limit=${PAGE}&offset=${offset}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status < 500) throw new Error(`DineChicago ${res.status}`);
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 10;
    await res.body?.cancel();
    await sleep(retryAfter * 1000);
  }
  throw new Error('DineChicago kept failing; stopped');
}

const cache = new URL('dinechicago.json', OUT_DIR);
let businesses: Business[];
const cached = await access(cache).then(
  () => true,
  () => false,
);
if (cached && !process.env.REFRESH) {
  businesses = JSON.parse(await readFile(cache, 'utf8'));
} else {
  businesses = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, meta } = await getPage(offset);
    businesses.push(...data);
    if (offset % 1000 === 0) console.log(`  ${businesses.length}/${meta.total ?? '?'}`);
    if (data.length < PAGE) break;
    await sleep(DELAY_MS);
  }
  await writeFile(cache, JSON.stringify(businesses));
}
console.log(`${businesses.length} DineChicago businesses`);

const sql = postgres(
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  { onnotice: () => {} },
);
const restaurants = await sql<{ id: string; name: string; latitude: number; longitude: number }[]>`
  select id, name, latitude, longitude from public.restaurants where locality ilike 'chicago'
`;

// Match on location first (both sources have coordinates), then require a shared name
const updates: Record<string, unknown>[] = [];
const fetchedAt = new Date();
for (const b of businesses) {
  if (b.latitude == null || b.longitude == null) continue;
  const near = restaurants
    .map((r) => ({ r, d: metersBetween(b.latitude!, b.longitude!, r.latitude, r.longitude) }))
    .filter(({ r, d }) => d <= PIN_RADIUS_M && namesOverlap(b.name, r.name))
    .sort((x, y) => x.d - y.d);
  if (!near.length) continue;
  updates.push({
    id: Number(near[0].r.id),
    price_tier: b.priceTier,
    cuisines: b.cuisines ?? [],
    neighborhood: b.neighborhood,
    dinechicago_slug: b.slug,
    dinechicago_fetched_at: fetchedAt,
  });
}

// One restaurant per DineChicago slug and vice versa: keep the first match for each
const seenIds = new Set<unknown>();
const unique = updates.filter((u) => !seenIds.has(u.id) && seenIds.add(u.id));
await sql.begin(async (tx) => {
  await tx`update public.restaurants set dinechicago_slug = null`;
  for (const u of unique) {
    await tx`
      update public.restaurants set price_tier = ${u.price_tier as number | null},
        cuisines = ${u.cuisines as string[]}, neighborhood = ${u.neighborhood as string | null},
        dinechicago_slug = ${u.dinechicago_slug as string},
        dinechicago_fetched_at = ${u.dinechicago_fetched_at as Date}
      where id = ${u.id as number}
    `;
  }
});
console.log(`Matched ${unique.length} of ${businesses.length} to Chicago restaurants`);
await sql.end();
