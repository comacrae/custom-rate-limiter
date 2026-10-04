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
