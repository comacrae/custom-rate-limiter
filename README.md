# Dev Expense Tracker

Track what you spend on developer tools (hosting, APIs, domains, courses) against a monthly budget.

## Layout

- `supabase/` — Supabase config, migrations, and database tests

## Prerequisites

- Node 22+
- Docker (for the local Supabase database)
- `brew install gitleaks supabase/tap/supabase`

## First-time setup

```bash
npm install                  # repo tooling; installs git hooks via lefthook
supabase login
supabase link --project-ref zdcmmxxmtipuooebxsww
```

## Git workflow

- Branch from `develop`, open PRs to `develop` (the default branch).
- Never commit directly to `develop` or `main`.

Every commit runs these hooks automatically:

- gitleaks scans staged changes for secrets
- Prettier formats staged code, JSON, Markdown, YAML, and CSS

CI runs the same formatting check, plus the Supabase checks below on PRs that touch `supabase/`.

## Database changes

```bash
supabase migration new <name>   # creates supabase/migrations/<timestamp>_<name>.sql
npm run db:check                # rebuild local DB, then lint, advisors, and pgTAP tests
supabase db push                # after the PR merges: apply migrations to the hosted project
```

`db:check` needs Docker running; start the local database with `supabase start` (full stack, with Studio at http://localhost:54323) or `supabase db start` (Postgres only). Enable RLS on every table in `public`; the advisors check fails without it. Put pgTAP tests in `supabase/tests/`.
