# menubuff

A restaurant collection app for foodies + explorers

## Layout

- `menu-buff/` — Expo app (Expo Router, routes in `menu-buff/src/app/`)
- `supabase/` — Supabase config, migrations, and database tests

## Prerequisites

- Node 22+
- Docker (for the local Supabase database)
- `brew install gitleaks supabase/tap/supabase`
- Expo Go on your phone, signed in to the Expo account

## First-time setup

```bash
npm install                  # repo tooling; installs git hooks via lefthook
cd menu-buff && npm install
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

## Builds

`.env.local` isn't uploaded to EAS Build. Before the first cloud build, set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as EAS environment variables (`npx eas-cli@latest env:set`).
