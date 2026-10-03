// Pulls open Chicagoland restaurants that list their own website from Overture Maps places
// (https://docs.overturemaps.org/attribution/ — mostly CDLA-Permissive-2.0).
import { mkdir, writeFile } from 'node:fs/promises';

import { DuckDBInstance } from '@duckdb/node-api';

import { OUT_DIR } from './config.ts';

export type Restaurant = {
  overtureId: string;
  name: string;
  website: string;
  category: string;
  locality: string | null;
};

const RELEASE = '2026-09-23.1';
const CATEGORIES = ['restaurant', 'casual_eatery', 'fast_food_restaurant'];
// Seven-county Chicago region (Cook, DuPage, Kane, Kendall, Lake, McHenry, Will), Illinois only
const BBOX = { xmin: -88.8, xmax: -87.52, ymin: 41.2, ymax: 42.5 };

// Not a restaurant's own site: social profiles, review sites, delivery apps, and ordering
// platforms whose terms forbid crawling
const EXCLUDED_HOSTS = [
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'linktr.ee',
  'yelp.com',
  'google.com',
  'doordash.com',
  'ubereats.com',
  'grubhub.com',
  'seamless.com',
  'order.online',
  'toasttab.com',
  'square.site',
  'chownow.com',
  'clover.com',
  'olo.com',
  'slicelife.com',
];

function isOwnSite(website: string) {
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    return !EXCLUDED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const db = await DuckDBInstance.create();
const conn = await db.connect();
await conn.run("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';");
const reader = await conn.runAndReadAll(`
  SELECT id, names.primary AS name, websites, basic_category AS category,
         addresses[1].locality AS locality
  FROM read_parquet(
    's3://overturemaps-us-west-2/release/${RELEASE}/theme=places/type=place/*',
    hive_partitioning = 1
  )
  WHERE bbox.xmin BETWEEN ${BBOX.xmin} AND ${BBOX.xmax}
    AND bbox.ymin BETWEEN ${BBOX.ymin} AND ${BBOX.ymax}
    AND addresses[1].region = 'IL'
    AND operating_status = 'open'
    AND basic_category IN (${CATEGORIES.map((c) => `'${c}'`).join(', ')})
    AND len(websites) > 0
    AND names.primary IS NOT NULL
`);

type Row = { id: string; name: string; websites: string[]; category: string; locality: string };
const restaurants: Restaurant[] = [];
for (const row of reader.getRowObjectsJson() as unknown as Row[]) {
  const website = row.websites.find(isOwnSite);
  if (!website) continue;
  restaurants.push({
    overtureId: row.id,
    name: row.name,
    website,
    category: row.category,
    locality: row.locality,
  });
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('restaurants.json', OUT_DIR), JSON.stringify(restaurants, null, 2));
console.log(`Saved ${restaurants.length} restaurants with their own website`);
