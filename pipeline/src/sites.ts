// Websites in the source data come with or without a scheme and "www."
export function siteUrl(website: string) {
  return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
}

// One host per site: chain locations share it, and menus are stored against it
export function siteHost(website: string) {
  return siteUrl(website)
    .hostname.replace(/^www\./, '')
    .toLowerCase();
}

const LOCATION_PATH = /\/(locations?|chicago)(\/|$)|\/location\//i;
// Generic words that don't identify a restaurant
const NAME_STOPWORDS = new Set([
  'the',
  'and',
  'restaurant',
  'restaurants',
  'chicago',
  'grill',
  'kitchen',
  'cafe',
  'house',
  'room',
  'dining',
  'pizza',
  'tavern',
  'bistro',
  'eatery',
  'lounge',
  'club',
  'company',
  // Food words shared by unrelated places ("Joe Willies Seafood" vs "J & R Seafood")
  'seafood',
  'chicken',
  'ribs',
  'barbeque',
  'barbecue',
  'taqueria',
  'tacos',
  'pizzeria',
  'deli',
  'diner',
  'sushi',
  'thai',
  'mexican',
  'chinese',
  'italian',
  'express',
  'food',
  'foods',
  'restaurante',
  'burger',
  'burgers',
  'beef',
  'coffee',
  'bakery',
  'shop',
]);
// Domains that are never a restaurant's sister site
const NOT_SISTER =
  /facebook|instagram|twitter|x\.com|tiktok|youtube|yelp|google|toasttab|tock|resy|opentable|sevenrooms|doordash|ubereats|grubhub|order\.online|getbento|squarespace|wix|linktr|apple|spotify/i;

// Distinctive words from a restaurant's name: "Moody Tongue" → ["moody", "tongue"]
export function nameTokens(name: string) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !NAME_STOPWORDS.has(w));
}

export function isSisterDomain(host: string, tokens: string[]) {
  return !NOT_SISTER.test(host) && tokens.some((t) => host.includes(t));
}

export function isOwnLocationPage(path: string, tokens: string[]) {
  const lower = path.toLowerCase();
  return LOCATION_PATH.test(path) || tokens.some((t) => lower.includes(t));
}

const GENERIC_WORDS = /\b(restaurant|chicago|bar|kitchen|grill|cafe|the|and|co|company)\b/g;

// "The Girl & the Goat" → "girl and the goat"; accents and punctuation dropped
export function normalizeName(name: string) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

// Looser key that also ignores generic words: "Gilt Bar" and "Gilt" both → "gilt"
export function coreName(name: string) {
  return normalizeName(name).replace(GENERIC_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

// Pins sit on the building, but Overture's point can be at the lot's edge
export const PIN_RADIUS_M = 150;

export function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
}

// Names that share a distinctive word ("Khan Barbeque Restaurant" ~ "Khan BBQ")
export function namesOverlap(a: string, b: string) {
  const words = new Set(nameTokens(a));
  const [x, y] = [normalizeName(a), normalizeName(b)];
  return (
    nameTokens(b).some((w) => words.has(w)) ||
    coreName(a) === coreName(b) ||
    // "Mr. Beef On Orleans" ~ "Mr. Beef", where every word is generic
    x.startsWith(`${y} `) ||
    y.startsWith(`${x} `)
  );
}
