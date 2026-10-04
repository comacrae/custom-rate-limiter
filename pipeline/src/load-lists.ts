// Loads curated lists (data/lists/*.json) into Postgres and links each entry to a place.
// Matching order: manual match in data/place-overrides.json, then the list's website, then the
// normalized name (Chicago and places with websites preferred). Unmatched entries are still
// stored, and searched for in all of Overture so they can be added to place-overrides.json.
import { readdir, readFile, writeFile } from 'node:fs/promises';

import { DuckDBInstance } from '@duckdb/node-api';
import postgres from 'postgres';

import { OUT_DIR } from './config.ts';
import type { PlaceOverrides, Restaurant } from './fetch-restaurants.ts';
import {
  coreName,
  metersBetween,
  namesOverlap,
  normalizeName,
  PIN_RADIUS_M,
  siteHost,
} from './sites.ts';

export type ListEntry = {
  name: string;
  tier: string | null;
  neighborhood: string | null;
  address: string | null;
  website: string | null;
  notes: string | null;
  // Map-based lists pin each entry, which beats name matching
  latitude?: number;
  longitude?: number;
};

export type CuratedList = {
  slug: string;
  name: string;
  sourceUrl: string | null;
  edition: string | null;
  entries: ListEntry[];
};

const LISTS_DIR = new URL('../data/lists/', import.meta.url);

const hostOf = (website: string | null) => {
  if (!website) return null;
  try {
    return siteHost(website);
  } catch {
    return null;
  }
};

const restaurants: Restaurant[] = JSON.parse(
  await readFile(new URL('restaurants.json', OUT_DIR), 'utf8'),
);
const overrides: PlaceOverrides = JSON.parse(
  await readFile(new URL('../data/place-overrides.json', import.meta.url), 'utf8'),
);

const byId = new Map(restaurants.map((r) => [r.overtureId, r]));
const byHost = new Map<string, Restaurant[]>();
const byName = new Map<string, Restaurant[]>();
const byCore = new Map<string, Restaurant[]>();
const add = (map: Map<string, Restaurant[]>, key: string | null, r: Restaurant) => {
  if (!key) return;
  map.set(key, [...(map.get(key) ?? []), r]);
};
for (const r of restaurants) {
  add(byHost, hostOf(r.website), r);
  add(byName, normalizeName(r.name), r);
  add(byCore, coreName(r.name), r);
}

// Chicago first, then places with a website, then actual restaurants
const rank = (r: Restaurant) =>
  (/^chicago$/i.test(r.locality ?? '') ? 4 : 0) +
  (r.website ? 2 : 0) +
  (r.category === 'restaurant' ? 1 : 0);
const best = (candidates: Restaurant[] | undefined) =>
  candidates?.length ? [...candidates].sort((a, b) => rank(b) - rank(a))[0] : null;

function match(list: CuratedList, entry: ListEntry) {
  const manual = overrides.matches[`${list.slug}|${entry.name}`];
  if (manual) return { restaurant: byId.get(manual) ?? null, how: 'manual' };
  const listedHost = hostOf(entry.website);
  const viaHost = listedHost ? byHost.get(listedHost) : undefined;
  if (viaHost?.length) {
    // A shared host (restaurant group) still needs the name to pick the right location
    const named = viaHost.filter((r) => coreName(r.name) === coreName(entry.name));
    return { restaurant: best(named.length ? named : viaHost), how: 'website' };
  }
  // Pinned entries only match a nearby place with an overlapping name
  if (entry.latitude != null && entry.longitude != null) {
    const near = restaurants
      .map((r) => ({
        r,
        d: metersBetween(entry.latitude!, entry.longitude!, r.latitude, r.longitude),
      }))
      .filter(({ r, d }) => d <= PIN_RADIUS_M && namesOverlap(entry.name, r.name))
      .sort((a, b) => a.d - b.d);
    return { restaurant: near[0]?.r ?? null, how: near.length ? 'pin' : 'none' };
  }
  const viaName = best(byName.get(normalizeName(entry.name)));
  if (viaName) return { restaurant: viaName, how: 'name' };
  const viaCore = coreName(entry.name) ? best(byCore.get(coreName(entry.name))) : null;
  if (viaCore) return { restaurant: viaCore, how: 'core name' };
  // Whole-word prefix either way: "Monteverde" ↔ "Monteverde Restaurant & Pastificio",
  // "Munno Pizzeria & Bistro" ↔ "Munno". Chicago only, since short names collide elsewhere.
  const listed = normalizeName(entry.name);
  const viaPrefix = best(
    restaurants.filter((r) => {
      const ours = normalizeName(r.name);
      return (
        /^chicago$/i.test(r.locality ?? '') &&
        ours.length >= 4 &&
        (ours.startsWith(`${listed} `) || listed.startsWith(`${ours} `))
      );
    }),
  );
  return { restaurant: viaPrefix, how: viaPrefix ? 'prefix' : 'none' };
}

const lists: CuratedList[] = [];
for (const file of (await readdir(LISTS_DIR)).filter((f) => f.endsWith('.json')).sort()) {
  lists.push(JSON.parse(await readFile(new URL(file, LISTS_DIR), 'utf8')));
}

const report = {
  unmatched: [] as { list: string; name: string; website: string | null }[],
  websiteMismatches: [] as {
    list: string;
    name: string;
    overtureId: string;
    ours: string | null;
    listed: string;
  }[],
};

const sql = postgres(
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  { onnotice: () => {} },
);
const ids = new Map(
  (
    await sql<{ id: string; overture_id: string }[]>`select id, overture_id from public.restaurants`
  ).map((r) => [r.overture_id, Number(r.id)]),
);

for (const list of lists) {
  const rows = list.entries.map((entry, position) => {
    const { restaurant } = match(list, entry);
    if (!restaurant) {
      report.unmatched.push({ list: list.slug, name: entry.name, website: entry.website });
    } else if (entry.website && hostOf(entry.website) !== hostOf(restaurant.website)) {
      report.websiteMismatches.push({
        list: list.slug,
        name: entry.name,
        overtureId: restaurant.overtureId,
        ours: restaurant.website,
        listed: entry.website,
      });
    }
    return {
      position,
      listed_name: entry.name,
      tier: entry.tier,
      neighborhood: entry.neighborhood,
      notes: entry.notes,
      restaurant_id: restaurant ? (ids.get(restaurant.overtureId) ?? null) : null,
    };
  });
  await sql.begin(async (tx) => {
    const [{ id }] = await tx`
      insert into public.restaurant_lists ${tx({
        slug: list.slug,
        name: list.name,
        source_url: list.sourceUrl,
        edition: list.edition,
      })}
      on conflict (slug) do update set name = excluded.name, source_url = excluded.source_url,
        edition = excluded.edition, updated_at = now()
      returning id
    `;
    await tx`delete from public.restaurant_list_entries where list_id = ${id}`;
    if (rows.length) {
      await tx`insert into public.restaurant_list_entries ${tx(rows.map((r) => ({ list_id: id, ...r })))}`;
    }
  });
  const matched = rows.filter((r) => r.restaurant_id !== null).length;
  console.log(`${list.slug}: ${matched}/${rows.length} matched`);
}
await sql.end();

// Search all of Overture (any category or status) for what didn't match
if (report.unmatched.length) {
  const db = await DuckDBInstance.create();
  const conn = await db.connect();
  await conn.run("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';");
  const patterns = [
    ...new Set(report.unmatched.map((u) => coreName(u.name) || normalizeName(u.name))),
  ]
    .filter(Boolean)
    .map((p) => `lower(names.primary) LIKE '%${p.replace(/'/g, '').replace(/ /g, '%')}%'`);
  const found = await conn.runAndReadAll(`
    SELECT id, names.primary AS name, basic_category AS category, operating_status AS status,
           addresses[1].locality AS locality, websites[1] AS website
    FROM read_parquet('s3://overturemaps-us-west-2/release/2026-09-23.1/theme=places/type=place/*', hive_partitioning = 1)
    WHERE bbox.xmin BETWEEN -88.8 AND -87.52 AND bbox.ymin BETWEEN 41.2 AND 42.5
      AND coalesce(operating_status, '') <> 'permanently_closed'
      AND (${patterns.join(' OR ')})
  `);
  await writeFile(
    new URL('lists-candidates.json', OUT_DIR),
    JSON.stringify(found.getRowObjectsJson(), null, 2),
  );
}
await writeFile(new URL('lists-report.json', OUT_DIR), JSON.stringify(report, null, 2));
console.log(
  `Unmatched: ${report.unmatched.length}, website mismatches: ${report.websiteMismatches.length} (see out/lists-report.json${report.unmatched.length ? ', out/lists-candidates.json' : ''})`,
);
