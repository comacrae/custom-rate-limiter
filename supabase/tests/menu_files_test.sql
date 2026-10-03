begin;
select plan(3);

insert into public.menu_files (site_host, url, kind, found_at)
values ('testdiner.com', 'https://testdiner.com/menu.pdf', 'pdf', now());

set local role anon;

select is(
  (select count(*) from public.menu_files where site_host = 'testdiner.com'),
  1::bigint,
  'anon can read menu files'
);
select throws_ok(
  $$insert into public.menu_files (site_host, url, kind, found_at)
    values ('x.com', 'https://x.com/a.png', 'image', now())$$,
  '42501',
  null,
  'anon cannot add menu files'
);

reset role;

select throws_ok(
  $$insert into public.menu_files (site_host, url, kind, found_at)
    values ('x.com', 'https://x.com/a.doc', 'doc', now())$$,
  '23514',
  null,
  'kind must be pdf or image'
);

select * from finish();
rollback;
