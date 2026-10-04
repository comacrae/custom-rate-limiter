-- Price tier, cuisines, and neighborhood from the DineChicago API (dinechicago.com/api-terms).
-- Wherever these are shown, the app must display DineChicago's attribution string:
-- "Data from the City of Chicago Data Portal, Foursquare Open Source Places, and Overture Maps
-- Foundation."
alter table public.restaurants
  add column price_tier smallint check (price_tier between 1 and 4),
  add column cuisines text[] not null default '{}',
  add column neighborhood text,
  add column dinechicago_slug text unique,
  add column dinechicago_fetched_at timestamptz;
