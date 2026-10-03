// Pulls Chicago restaurants that list a website from OpenStreetMap (ODbL) via Overpass.
import { mkdir, writeFile } from 'node:fs/promises';

import { OUT_DIR, USER_AGENT } from './config.ts';

export type Restaurant = {
  osmId: string;
  name: string;
  website: string;
  cuisine: string | null;
};

const QUERY = `
[out:json][timeout:120];
area["name"="Chicago"]["boundary"="administrative"]["admin_level"="8"]->.c;
(
  nwr["amenity"="restaurant"]["website"](area.c);
  nwr["amenity"="restaurant"]["contact:website"](area.c);
);
out tags;
`;

type OsmElement = { type: string; id: number; tags: Record<string, string> };

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'User-Agent': USER_AGENT },
  body: new URLSearchParams({ data: QUERY }),
});
if (!res.ok) throw new Error(`Overpass ${res.status}: ${await res.text()}`);
const { elements } = (await res.json()) as { elements: OsmElement[] };

const restaurants: Restaurant[] = elements
  .filter((el) => el.tags.name)
  .map((el) => ({
    osmId: `${el.type}/${el.id}`,
    name: el.tags.name,
    website: el.tags.website ?? el.tags['contact:website'],
    cuisine: el.tags.cuisine ?? null,
  }));

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('chicago-restaurants.json', OUT_DIR), JSON.stringify(restaurants, null, 2));
console.log(`Saved ${restaurants.length} restaurants`);
