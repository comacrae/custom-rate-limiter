// Pulls open Chicagoland restaurants from Overture Maps places
// (https://docs.overturemaps.org/attribution/ — mostly CDLA-Permissive-2.0).
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { DuckDBInstance } from '@duckdb/node-api';

import { OUT_DIR } from './config.ts';

export type Restaurant = {
  overtureId: string;
  name: string;
  category: string;
  // The restaurant's own site; null when it has none or only lists social/delivery pages
  website: string | null;
  phone: string | null;
  address: string | null;
  locality: string | null;
  postcode: string | null;
  latitude: number;
  longitude: number;
};

const RELEASE = '2026-09-23.1';
// Anywhere with a food or drink menu worth browsing
const CATEGORIES = [
  'restaurant',
  'casual_eatery',
  'fast_food_restaurant',
  'cafe',
  'coffee_shop',
  'bar',
  'lounge',
  'brewery',
  'smoothie_juice_bar',
  'food_truck_stand',
  'food_court',
];
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
  'skytab.com',
  'spoton.com',
  'order.store',
  // Directories, review and deal sites, and booking platforms listed as a place's website
  'groupon.com',
  'menuism.com',
  'menupages.com',
  'allmenus.com',
  'menupix.com',
  'yahoo.com',
  'yellowpages.com',
  'superpages.com',
  'citysearch.com',
  'chamberofcommerce.com',
  'mapquest.com',
  'tripadvisor.com',
  'opentable.com',
  'sevenrooms.com',
  'exploretock.com',
  'resy.com',
  'restaurant.com',
  'thryv.com',
  'ezlocal.com',
  'cortera.com',
  'usnearby.com',
  'thrillist.com',
  'metromix.com',
  'nbcchicago.com',
  'eventbrite.com',
  'seatgeek.com',
  'youtube.com',
  'myspace.com',
  'reverbnation.com',
  'bit.ly',
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

// Hand corrections for places on curated lists; see data/place-overrides.json
export type PlaceOverrides = {
  // Overture IDs to keep even when outside the category/status filters
  include: string[];
  // Overture ID → correct website
  websites: Record<string, string>;
  // Places Overture doesn't have; overtureId is "manual:<slug>"
  places: Restaurant[];
  // "<list slug>|<listed name>" → overtureId, when name matching picks wrong or nothing
  matches: Record<string, string>;
};
const overrides: PlaceOverrides = JSON.parse(
  await readFile(new URL('../data/place-overrides.json', import.meta.url), 'utf8'),
);

const db = await DuckDBInstance.create();
const conn = await db.connect();
await conn.run("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';");
const reader = await conn.runAndReadAll(`
  SELECT id, names.primary AS name, coalesce(websites, []) AS websites,
         basic_category AS category, phones[1] AS phone,
         addresses[1].freeform AS address, addresses[1].locality AS locality,
         addresses[1].postcode AS postcode,
         -- Places are points, so the bbox corner is the location
         bbox.ymin AS latitude, bbox.xmin AS longitude
  FROM read_parquet(
    's3://overturemaps-us-west-2/release/${RELEASE}/theme=places/type=place/*',
    hive_partitioning = 1
  )
  WHERE bbox.xmin BETWEEN ${BBOX.xmin} AND ${BBOX.xmax}
    AND bbox.ymin BETWEEN ${BBOX.ymin} AND ${BBOX.ymax}
    AND names.primary IS NOT NULL
    AND (
      (addresses[1].region = 'IL'
        AND operating_status = 'open'
        AND basic_category IN (${CATEGORIES.map((c) => `'${c}'`).join(', ')}))
      -- Places from curated lists that the filters above miss (other category, no status)
      OR id IN (${overrides.include.map((id) => `'${id.replace(/'/g, '')}'`).join(', ') || "''"})
    )
`);

type Row = Omit<Restaurant, 'overtureId' | 'website'> & { id: string; websites: string[] };
const restaurants: Restaurant[] = (reader.getRowObjectsJson() as unknown as Row[]).map(
  ({ id, websites, ...row }) => ({
    overtureId: id,
    ...row,
    // Hand corrections win over Overture's website (dead domains, wrong sites)
    website: overrides.websites[id] ?? websites.find(isOwnSite) ?? null,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  }),
);
// Places missing from Overture entirely, added by hand
restaurants.push(...overrides.places);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('restaurants.json', OUT_DIR), JSON.stringify(restaurants, null, 2));
const withSite = restaurants.filter((r) => r.website).length;
console.log(`Saved ${restaurants.length} restaurants, ${withSite} with their own website`);
