-- Menus published as PDFs or images. Text-based PDFs are also parsed into menus; scanned PDFs
-- and image menus can't be read reliably, so the app links to the file instead.
create table public.menu_files (
  id bigint generated always as identity primary key,
  site_host text not null,
  url text not null,
  kind text not null check (kind in ('pdf', 'image')),
  -- True when the file's contents were also parsed into menus and menu_items
  parsed boolean not null default false,
  found_at timestamptz not null,
  unique (site_host, url)
);

alter table public.menu_files enable row level security;

create policy "Anyone can read menu files" on public.menu_files
  for select to anon, authenticated using (true);

revoke all on public.menu_files from anon, authenticated;
grant select on public.menu_files to anon, authenticated;
