// Prints coverage of the menu database: places, menus, items, and where the data came from.
import postgres from 'postgres';

const sql = postgres(
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
);

const [overview] = await sql`
  select
    (select count(*) from public.restaurants) as places,
    (select count(*) from public.restaurants where site_host is not null) as with_website,
    (select count(*) from public.restaurants r
      where exists (select 1 from public.menus m where m.site_host = r.site_host)) as with_menu,
    (select count(*) from public.restaurants r
      where exists (select 1 from public.menu_files f where f.site_host = r.site_host)) as with_menu_file,
    (select count(distinct site_host) from public.menus) as sites_with_menus,
    (select count(*) from public.menus) as menus,
    (select count(*) from public.menu_items) as items,
    (select count(*) from public.menu_items where price is not null) as items_with_price,
    (select count(*) from public.menu_items where description is not null) as items_with_description,
    (select count(*) from public.menu_files where kind = 'pdf') as pdf_files,
    (select count(*) from public.menu_files where kind = 'image') as image_files
`;
console.log('Overview');
console.table(overview);

console.log('Items by parser');
console.table(
  await sql`
  select m.parser, count(distinct m.site_host) as sites, count(i.*) as items,
         round(100.0 * count(i.price) / nullif(count(i.*), 0)) as pct_priced
  from public.menus m join public.menu_items i on i.menu_id = m.id
  group by m.parser order by items desc
`,
);

console.log('Crawl outcomes');
console.table(
  await sql`
  select outcome, count(*) as sites from pipeline.site_probes group by outcome order by sites desc
`,
);

console.log('Places with a menu, top localities');
console.table(
  await sql`
  select locality, count(*) as places,
         count(*) filter (where exists (
           select 1 from public.menus m where m.site_host = r.site_host)) as with_menu
  from public.restaurants r
  group by locality order by places desc limit 15
`,
);

await sql.end();
