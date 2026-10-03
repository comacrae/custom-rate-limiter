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
npm run load-db              # upsert everything into the local Supabase database
npm test                     # parser unit tests
npm run parse-url -- <url>   # see what the parsers get from one page
npm run parse-pdf -- <url>   # same for one menu PDF
```

`LIMIT=40` runs the probe or extractor on the first 40 sites. `load-db` writes to local Supabase unless `DATABASE_URL` is set.

The crawler identifies itself as `MenuBuffBot`, honors robots.txt, and never tries to get past bot challenges (it records them as `blocked`). It skips delivery apps, Yelp, social profiles, and ordering platforms like Toast and Square: their terms forbid crawling, and delivery prices are marked up.

## Builds

`.env.local` isn't uploaded to EAS Build. Before the first cloud build, set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as EAS environment variables (`npx eas-cli@latest env:set`).
