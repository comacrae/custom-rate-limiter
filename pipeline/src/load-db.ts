// Loads restaurants, probe results, and extracted menus into Postgres. Safe to re-run:
// restaurants and probes are upserted, and each site's menus are replaced as a whole.
// Defaults to the local Supabase database; set DATABASE_URL to load elsewhere.
import { access, readFile } from 'node:fs/promises';

import postgres from 'postgres';

import { OUT_DIR } from './config.ts';
import type { SiteMenus } from './extract-menus.ts';
import type { Restaurant } from './fetch-restaurants.ts';
import type { Probe } from './probe-menus.ts';
import { siteHost } from './sites.ts';

const BATCH = 1000;
const sql = postgres(
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  { max: 4, onnotice: () => {} },
);

const readJsonl = async <T>(file: string): Promise<T[]> => {
  const url = new URL(file, OUT_DIR);
  try {
    await access(url);
  } catch {
    console.log(`Skipping ${file}: not found`);
    return [];
  }
  return (await readFile(url, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const hostOrNull = (website: string | null) => {
  if (!website) return null;
  try {
    return siteHost(website);
  } catch {
    return null;
  }
};

function chunks<T>(rows: T[], size = BATCH) {
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, i) =>
    rows.slice(i * size, (i + 1) * size),
  );
}

const restaurants: Restaurant[] = JSON.parse(
  await readFile(new URL('restaurants.json', OUT_DIR), 'utf8'),
);
for (const batch of chunks(restaurants)) {
  const rows = batch.map((r) => ({
    overture_id: r.overtureId,
    name: r.name,
    category: r.category,
    website: r.website,
    site_host: hostOrNull(r.website),
    phone: r.phone,
    address: r.address,
    locality: r.locality,
    postcode: r.postcode,
    latitude: r.latitude,
    longitude: r.longitude,
  }));
  await sql`
    insert into public.restaurants ${sql(rows)}
    on conflict (overture_id) do update set
      name = excluded.name, category = excluded.category, website = excluded.website,
      site_host = excluded.site_host, phone = excluded.phone, address = excluded.address,
      locality = excluded.locality, postcode = excluded.postcode,
      latitude = excluded.latitude, longitude = excluded.longitude, updated_at = now()
  `;
}
console.log(`Loaded ${restaurants.length} restaurants`);

const probes = await readJsonl<Probe>(process.env.PROBE_FILE ?? 'probe.jsonl');
const probedAt = new Date();
const probeRows = new Map<string, Record<string, unknown>>();
for (const p of probes) {
  const host = hostOrNull(p.website);
  if (!host) continue;
  probeRows.set(host, {
    site_host: host,
    url: p.website,
    outcome: p.outcome,
    detail: p.detail ?? null,
    platform: p.platform,
    format: p.format,
    menu_pages: p.menuPages,
    pdfs: p.pdfs,
    ordering: p.ordering,
    probed_at: probedAt,
  });
}
for (const batch of chunks([...probeRows.values()])) {
  await sql`
    insert into pipeline.site_probes ${sql(batch)}
    on conflict (site_host) do update set
      url = excluded.url, outcome = excluded.outcome, detail = excluded.detail,
      platform = excluded.platform, format = excluded.format, menu_pages = excluded.menu_pages,
      pdfs = excluded.pdfs, ordering = excluded.ordering, probed_at = excluded.probed_at
  `;
}
console.log(`Loaded ${probeRows.size} site probes`);

// HTML and PDF menus for the same site are replaced together
const bySite = new Map<string, SiteMenus>();
for (const file of [
  process.env.MENUS_FILE ?? 'menus.jsonl',
  process.env.PDF_MENUS_FILE ?? 'pdf-menus.jsonl',
]) {
  for (const site of await readJsonl<SiteMenus>(file)) {
    const existing = bySite.get(site.siteHost);
    if (existing) existing.pages.push(...site.pages);
    else bySite.set(site.siteHost, { ...site, pages: [...site.pages] });
  }
}
const sites = [...bySite.values()];
let menuCount = 0;
let itemCount = 0;
for (const site of sites) {
  if (!site.pages.length) continue;
  await sql.begin(async (tx) => {
    await tx`delete from public.menus where site_host = ${site.siteHost}`;
    for (const page of site.pages) {
      // A page can list two menus under the same name (often both unnamed); store them as one
      const byName = new Map<string, SiteMenus['pages'][number]['menus'][number]>();
      for (const menu of page.menus) {
        const existing = byName.get(menu.name);
        if (existing) existing.items.push(...menu.items);
        else byName.set(menu.name, { ...menu, items: [...menu.items] });
      }
      for (const menu of byName.values()) {
        const [{ id }] = await tx`
          insert into public.menus ${tx({
            site_host: site.siteHost,
            name: menu.name,
            source_url: page.url,
            source_format:
              page.parser === 'pdf' ? 'pdf' : page.parser === 'jsonld' ? 'jsonld' : 'html',
            parser: page.parser,
            fetched_at: new Date(site.fetchedAt),
          })}
          on conflict (site_host, source_url, name) do update set fetched_at = excluded.fetched_at
          returning id
        `;
        const items = menu.items.map((item, position) => ({
          menu_id: id,
          position,
          section: item.section,
          name: item.name,
          description: item.description,
          price: item.price,
          price_text: item.priceText,
          dietary: item.dietary,
        }));
        for (const batch of chunks(items)) {
          await tx`
            insert into public.menu_items ${tx(batch)}
            on conflict (menu_id, position) do nothing
          `;
        }
        menuCount++;
        itemCount += items.length;
      }
    }
  });
}
console.log(`Loaded ${menuCount} menus with ${itemCount} items from ${sites.length} sites`);

await sql.end();
