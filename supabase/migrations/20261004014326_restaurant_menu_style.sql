-- Tasting-menu and omakase restaurants usually publish no dish-by-dish menu, so the app shows
-- the format, price, and where to book instead. Null means an ordinary à la carte menu.
alter table public.restaurants
  add column menu_style text check (menu_style in ('tasting', 'omakase', 'tasting_and_a_la_carte')),
  add column tasting_price text,
  add column booking_url text;
