# menubuff

A restaurant collection app for foodies + explorers

## Layout

- `menu-buff/` — Expo app (Expo Router, routes in `menu-buff/src/app/`)
- `supabase/` — Supabase config, migrations, and database tests
- `pipeline/` — menu data pipeline (Node scripts)

## Prerequisites

- Node 22+
- Docker (for the local Supabase database)
- `brew install gitleaks supabase/tap/supabase`
- Expo Go on your phone, signed in to the Expo account

## First-time setup

```bash
npm install                  # repo tooling; installs git hooks via lefthook
cd menu-buff && npm install
cd ../pipeline && npm install
```

Create `menu-buff/.env.local` (gitignored) with values from the Supabase dashboard → Project Settings → API Keys:

```
EXPO_PUBLIC_SUPABASE_URL=https://zdcmmxxmtipuooebxsww.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Log in to the CLIs and link the Supabase project:

```bash
npx eas-cli@latest login
supabase login
supabase link --project-ref zdcmmxxmtipuooebxsww
```

## Running the app

```bash
cd menu-buff
npx expo start               # scan the QR code with your phone
npx expo start --tunnel      # if the phone can't reach your Mac on Wi-Fi
```

Restart the dev server after changing `.env.local`.

Add packages with `npx expo install <package>`, not `npm install`, so versions match the Expo SDK. Expo Go only includes Expo's bundled native modules; a library with custom native code needs a development build (`eas build --profile development`).

## Git workflow

- Branch from `develop`, open PRs to `develop` (the default branch).
- Never commit directly to `develop` or `main`.

Every commit runs these hooks automatically:

- gitleaks scans staged changes for secrets
- ESLint and Prettier fix and format staged app files
- Prettier formats staged JSON, Markdown, YAML, and CSS
- `tsc --noEmit` typechecks the app when TypeScript files are staged

Run the same checks by hand:

```bash
npm run format               # from the repo root
cd menu-buff && npm run lint && npm run typecheck
```

## Database changes

```bash
supabase migration new <name>   # creates supabase/migrations/<timestamp>_<name>.sql
npm run db:check                # rebuild local DB, then lint, advisors, and pgTAP tests
supabase db push                # after the PR merges: apply migrations to the hosted project
```

`db:check` needs Docker running; start the local database with `supabase start` (full stack, with Studio at http://localhost:54323) or `supabase db start` (Postgres only). Enable RLS on every table in `public`; the advisors check fails without it. Put pgTAP tests in `supabase/tests/`.

PRs that touch `supabase/` run the same checks in GitHub Actions.

## Menu data pipeline

```bash
cd pipeline
npm run fetch-restaurants    # open Chicagoland restaurants from Overture Maps → out/restaurants.json
npm run probe-menus          # classify how each site publishes its menu → out/probe.jsonl (~1 hr)
npm run extract-menus        # parse menus from reachable sites → out/menus.jsonl
npm run extract-pdfs         # parse text-based menu PDFs found by extract-menus → out/pdf-menus.jsonl
npm run find-menu-images     # find menu images on sites without a text menu → out/menu-images.jsonl
npm run load-db              # upsert everything into the local Supabase database
npm test                     # parser unit tests
npm run parse-url -- <url>   # see what the parsers get from one page
npm run parse-pdf -- <url>   # same for one menu PDF
```

`LIMIT=40` runs the probe or extractor on the first 40 sites. `load-db` writes to local Supabase unless `DATABASE_URL` is set.

Partial re-runs: `RETRY_FROM=probe.jsonl PROBE_OUT=probe-retry.jsonl npm run probe-menus` retries sites that were unreachable for fixable reasons (stale links, broken HTTPS). `SKIP_DONE_FROM=menus.jsonl MENUS_FILE=menus-pass2.jsonl npm run extract-menus` re-extracts only sites that produced no menus. `SKIP_PROBED_FROM=probe.jsonl PROBE_OUT=probe-new.jsonl npm run probe-menus` probes only places added since that run. Pass every output to the loader as comma-separated lists in `PROBE_FILES`, `MENUS_FILES`, and `IMAGES_FILES` (later probe files win for the same site). The loader treats those files as the whole truth: menus, menu files, and probes for any host they don't cover are deleted.

The crawler identifies itself as `MenuBuffBot`, honors robots.txt (including `Crawl-delay`, with at least 1s between requests to a site), and never tries to get past bot challenges or rate limits (it records them as `blocked`). When a site's links don't lead to a menu, it checks the site's sitemap for pages with "menu" in the path. It skips delivery apps, Yelp, social profiles, and ordering platforms like Toast and Square: their terms forbid crawling, and delivery prices are marked up.

## Data sources and attribution

Any screen that shows this data should carry the attributions below; the in-app credits page can reuse this section.

**Places (`restaurants`)** — [Overture Maps Foundation](https://overturemaps.org/) places theme, release 2026-09-23.1, under [CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/). Overture's places combine several upstream providers; see Overture's [attribution guidance](https://docs.overturemaps.org/attribution/). Credit: "Place data © Overture Maps Foundation."

**Hand-added places** (`source = 'manual'`) — coordinates geocoded with [Nominatim](https://nominatim.org/) from OpenStreetMap data, © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright).

**Cuisines and neighborhoods** (`cuisines`, `neighborhood`, `dinechicago_slug`) — the [DineChicago API](https://dinechicago.com/api/v1/docs), used under its [API terms](https://dinechicago.com/api-terms). Wherever these fields are shown, display this exact string:

> Data from the City of Chicago Data Portal, Foursquare Open Source Places, and Overture Maps Foundation.

Their terms also require keeping cached data reasonably current (re-run `npm run enrich-dinechicago` with `REFRESH=1`) or showing when it was last fetched (`dinechicago_fetched_at`).

**Menus** (`menus`, `menu_items`, `menu_files`) — each restaurant's own website, crawled by `MenuBuffBot` within robots.txt. Menus belong to the restaurants; show the source (`menus.source_url`) and link back to it. Menu PDFs and images in `menu_files` are links only and aren't re-hosted.

**Curated lists** (`restaurant_lists`) — list membership and rankings are the editors' work; show the list name with a link to `source_url`:

- [MICHELIN Guide Chicago](https://guide.michelin.com/us/en/illinois/chicago/restaurants) (2025 edition)
- [Chicago magazine, Chicago's 50 Best Restaurants](https://www.chicagomag.com/2026/06/15/chicagos-50-best-restaurants-2/) (2026)
- [The Infatuation, The Best Restaurants In Chicago](https://www.theinfatuation.com/chicago/guides/best-restaurants-chicago)
- [Time Out Chicago, The best restaurants in Chicago](https://www.timeout.com/chicago/restaurants/best-chicago-restaurants-our-picks-for-every-cuisine)
- [The Iconic Chicago Restaurants Map](https://chicagoreader.com/food/the-iconic-chicago-restaurants-map/) by John Greenfield, Chicago Reader (2021)
- [The Short List: Chicago](https://theshortli.st/chicago) by Alex Evins

**Tasting-menu details** (`menu_style`, `tasting_price`, `booking_url`) — researched by hand from restaurants' own sites and booking pages, October 2026. Prices change; treat them as a guide.

## Builds

`.env.local` isn't uploaded to EAS Build. Before the first cloud build, set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as EAS environment variables (`npx eas-cli@latest env:set`).
