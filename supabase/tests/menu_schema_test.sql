begin;
select plan(9);

select has_table('public', 'restaurants', 'restaurants table exists');
select has_table('public', 'menus', 'menus table exists');
select has_table('public', 'menu_items', 'menu_items table exists');

insert into public.restaurants (overture_id, name, category, site_host, latitude, longitude)
values ('test-1', 'Test Diner', 'restaurant', 'testdiner.com', 41.88, -87.63);
insert into public.menus (site_host, name, source_url, source_format, parser, fetched_at)
values ('testdiner.com', 'Dinner', 'https://testdiner.com/menu', 'jsonld', 'jsonld', now());
insert into public.menu_items (menu_id, position, name, price)
select id, 0, 'Burger', 14 from public.menus where site_host = 'testdiner.com';

set local role anon;

select is(
  (select count(*) from public.restaurants where overture_id = 'test-1'),
  1::bigint,
  'anon can read restaurants'
);
select is(
  (select count(*) from public.menu_items i join public.menus m on m.id = i.menu_id
   where m.site_host = 'testdiner.com'),
  1::bigint,
  'anon can read menus and items'
);
select throws_ok(
  $$insert into public.restaurants (overture_id, name, category, latitude, longitude)
    values ('test-2', 'Sneaky', 'restaurant', 0, 0)$$,
  '42501',
  null,
  'anon cannot insert restaurants'
);
select throws_ok(
  $$update public.menu_items set price = 0$$,
  '42501',
  null,
  'anon cannot update menu items'
);
select throws_ok(
  $$select * from pipeline.site_probes$$,
  '42501',
  null,
  'anon cannot read pipeline bookkeeping'
);

reset role;
set local role authenticated;

select throws_ok(
  $$delete from public.menus$$,
  '42501',
  null,
  'signed-in users cannot delete menus'
);

select * from finish();
rollback;
