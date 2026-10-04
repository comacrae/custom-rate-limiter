-- Curated lists (MICHELIN, Eater 38, Restaurant Week, ...) and the restaurants on them.
-- Restaurants missing from Overture are added by hand with source = 'manual'.

alter table public.restaurants
  add column source text not null default 'overture' check (source in ('overture', 'manual'));

create table public.restaurant_lists (
  id bigint generated always as identity primary key,
  slug text not null unique,
  name text not null,
  source_url text,
  edition text,
  updated_at timestamptz not null default now()
);

create table public.restaurant_list_entries (
  id bigint generated always as identity primary key,
  list_id bigint not null references public.restaurant_lists (id) on delete cascade,
  position integer not null,
  -- The name exactly as the list prints it, kept even when no restaurant is matched
  listed_name text not null,
  tier text,
  neighborhood text,
  notes text,
  restaurant_id bigint references public.restaurants (id) on delete set null,
  unique (list_id, position)
);

create index restaurant_list_entries_restaurant_id_idx
  on public.restaurant_list_entries (restaurant_id);

alter table public.restaurant_lists enable row level security;
alter table public.restaurant_list_entries enable row level security;

create policy "Anyone can read restaurant lists" on public.restaurant_lists
  for select to anon, authenticated using (true);
create policy "Anyone can read restaurant list entries" on public.restaurant_list_entries
  for select to anon, authenticated using (true);

revoke all on public.restaurant_lists, public.restaurant_list_entries from anon, authenticated;
grant select on public.restaurant_lists, public.restaurant_list_entries to anon, authenticated;
