-- Restaurants come from Overture Maps; menus are parsed from restaurants' own websites.
-- Chains share one website across locations, so menus hang off the website host and
-- restaurants reach them through restaurants.site_host.

create table public.restaurants (
  id bigint generated always as identity primary key,
  overture_id text not null unique,
  name text not null,
  category text not null,
  website text,
  site_host text,
  phone text,
  address text,
  locality text,
  postcode text,
  latitude double precision not null,
  longitude double precision not null,
  updated_at timestamptz not null default now()
);

create index restaurants_site_host_idx on public.restaurants (site_host);
create index restaurants_locality_idx on public.restaurants (locality);

create table public.menus (
  id bigint generated always as identity primary key,
  site_host text not null,
  name text not null default '',
  source_url text not null,
  source_format text not null check (source_format in ('jsonld', 'html', 'pdf')),
  parser text not null,
  fetched_at timestamptz not null,
  unique (site_host, source_url, name)
);

create table public.menu_items (
  id bigint generated always as identity primary key,
  menu_id bigint not null references public.menus (id) on delete cascade,
  position integer not null,
  section text,
  name text not null,
  description text,
  price numeric(10, 2),
  -- Price exactly as printed, for "MP", "12 / 18", and other non-numeric prices
  price_text text,
  currency text not null default 'USD',
  dietary text[] not null default '{}',
  unique (menu_id, position)
);

-- The unique (menu_id, position) index covers lookups by menu_id

alter table public.restaurants enable row level security;
alter table public.menus enable row level security;
alter table public.menu_items enable row level security;

-- Restaurant and menu data is public; only the pipeline (service role) writes it
create policy "Anyone can read restaurants" on public.restaurants
  for select to anon, authenticated using (true);
create policy "Anyone can read menus" on public.menus
  for select to anon, authenticated using (true);
create policy "Anyone can read menu items" on public.menu_items
  for select to anon, authenticated using (true);

revoke all on public.restaurants, public.menus, public.menu_items from anon, authenticated;
grant select on public.restaurants, public.menus, public.menu_items to anon, authenticated;

-- Crawl bookkeeping, kept out of the exposed public schema
create schema pipeline;
revoke all on schema pipeline from anon, authenticated;

create table pipeline.site_probes (
  site_host text primary key,
  url text not null,
  outcome text not null check (outcome in ('ok', 'blocked', 'robots_disallowed', 'unreachable')),
  detail text,
  platform text,
  format text,
  menu_pages text[] not null default '{}',
  pdfs text[] not null default '{}',
  ordering text[] not null default '{}',
  probed_at timestamptz not null
);

alter table pipeline.site_probes enable row level security;
