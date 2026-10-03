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
