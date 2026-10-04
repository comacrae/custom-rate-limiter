begin;
select plan(4);

insert into public.restaurants (overture_id, name, category, latitude, longitude, source)
values ('manual:test-spot', 'Test Spot', 'restaurant', 41.88, -87.63, 'manual');
insert into public.restaurant_lists (slug, name) values ('test-list', 'Test List');
insert into public.restaurant_list_entries (list_id, position, listed_name, tier, restaurant_id)
select l.id, 0, 'Test Spot', '1 star', r.id
from public.restaurant_lists l, public.restaurants r
where l.slug = 'test-list' and r.overture_id = 'manual:test-spot';

set local role anon;

select is(
  (select count(*) from public.restaurant_list_entries e
   join public.restaurant_lists l on l.id = e.list_id
   join public.restaurants r on r.id = e.restaurant_id
   where l.slug = 'test-list'),
  1::bigint,
  'anon can read lists, entries, and their restaurants'
);
select throws_ok(
  $$insert into public.restaurant_lists (slug, name) values ('x', 'X')$$,
  '42501', null, 'anon cannot add lists'
);
select throws_ok(
  $$delete from public.restaurant_list_entries$$,
  '42501', null, 'anon cannot remove list entries'
);

reset role;

select throws_ok(
  $$insert into public.restaurants (overture_id, name, category, latitude, longitude, source)
    values ('x', 'X', 'restaurant', 0, 0, 'scraped')$$,
  '23514', null, 'restaurant source must be overture or manual'
);

select * from finish();
rollback;
