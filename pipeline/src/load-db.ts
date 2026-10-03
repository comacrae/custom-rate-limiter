// Loads restaurants, probe results, and extracted menus into Postgres. Safe to re-run:
// restaurants and probes are upserted, and each site's menus are replaced as a whole.
// Defaults to the local Supabase database; set DATABASE_URL to load elsewhere.
import { access, readFile } from 'node:fs/promises';

import postgres from 'postgres';

import { OUT_DIR } from './config.ts';
import type { SiteMenus } from './extract-menus.ts';
import type { Restaurant } from './fetch-restaurants.ts';
import type { SiteImages } from './find-menu-images.ts';
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
// Crawl output for hosts no longer on the list (e.g. directories later excluded) is skipped
const knownHosts = new Set(restaurants.map((r) => hostOrNull(r.website)).filter(Boolean));
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

// PROBE_FILES is comma-separated; a site in a later file (e.g. a retry) replaces earlier ones
const probes: Probe[] = [];
for (const file of (process.env.PROBE_FILES ?? 'probe.jsonl').split(',')) {
  probes.push(...(await readJsonl<Probe>(file)));
}
const probedAt = new Date();
const probeRows = new Map<string, Record<string, unknown>>();
for (const p of probes) {
  const host = hostOrNull(p.website);
  if (!host || !knownHosts.has(host)) continue;
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
// MENUS_FILES lists every extraction output to merge, comma-separated
for (const file of (process.env.MENUS_FILES ?? 'menus.jsonl,pdf-menus.jsonl').split(',')) {
  for (const site of await readJsonl<SiteMenus>(file)) {
    const existing = bySite.get(site.siteHost);
    if (existing) {
      existing.pages.push(...site.pages);
      existing.pdfs = [...new Set([...existing.pdfs, ...site.pdfs])];
    } else {
      bySite.set(site.siteHost, { ...site, pages: [...site.pages] });
    }
  }
}
const sites = [...bySite.values()];
let menuCount = 0;
let itemCount = 0;
for (const site of sites) {
  if (!site.pages.length || !knownHosts.has(site.siteHost)) continue;
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

// Menu PDFs and images, so the app can link to menus that couldn't be parsed into items
const images = new Map<string, SiteImages>();
for (const file of (process.env.IMAGES_FILES ?? 'menu-images.jsonl').split(',')) {
  for (const site of await readJsonl<SiteImages>(file)) images.set(site.siteHost, site);
}
const fileHosts = new Set(
  [...sites.filter((s) => s.pdfs.length).map((s) => s.siteHost), ...images.keys()].filter((h) =>
    knownHosts.has(h),
  ),
);
let fileCount = 0;
for (const host of fileHosts) {
  const site = bySite.get(host);
  const parsedPdfs = new Set(site?.pages.filter((p) => p.parser === 'pdf').map((p) => p.url));
  const foundAt = new Date(site?.fetchedAt ?? images.get(host)?.foundAt ?? Date.now());
  const rows = [
    ...(site?.pdfs ?? []).map((url) => ({ url, kind: 'pdf', parsed: parsedPdfs.has(url) })),
    ...(images.get(host)?.images ?? []).map((url) => ({ url, kind: 'image', parsed: false })),
  ].map((file) => ({ site_host: host, found_at: foundAt, ...file }));
  await sql.begin(async (tx) => {
    await tx`delete from public.menu_files where site_host = ${host}`;
    await tx`insert into public.menu_files ${tx(rows)} on conflict (site_host, url) do nothing`;
  });
  fileCount += rows.length;
}
console.log(`Loaded ${fileCount} menu files from ${fileHosts.size} sites`);

// Drop crawl data for hosts no restaurant uses any more (e.g. directories now excluded)
const orphaned = `site_host not in (select site_host from public.restaurants where site_host is not null)`;
const [menus, files, probesRemoved] = await sql.begin(async (tx) => [
  await tx.unsafe(`delete from public.menus where ${orphaned}`),
  await tx.unsafe(`delete from public.menu_files where ${orphaned}`),
  await tx.unsafe(`delete from pipeline.site_probes where ${orphaned}`),
]);
console.log(
  `Removed orphaned ${menus.count} menus, ${files.count} menu files, ${probesRemoved.count} probes`,
);

await sql.end();
