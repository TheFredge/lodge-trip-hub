-- Lodge Trip Hub: database setup, as applied to the Supabase project "Lodge Trip Hub" (ybmnrzbykmjixhfqhwaz).
-- Kept here as a backup and record. Applied 2026-11-13 as seven migrations, in this order.
-- No secrets are in this file: the collector password is generated inside the database.

-------------------------------------------------------------------------------
-- 1. collector_storage
-------------------------------------------------------------------------------
create table public.weather_points (
  id text primary key, label text not null,
  kind text not null check (kind in ('base','upper')),
  lat numeric not null, lon numeric not null,
  office text not null, grid_x int not null, grid_y int not null,
  grid_elev_ft int, real_elev_ft int, sort_order int not null default 0, notes text
);
insert into public.weather_points (id,label,kind,lat,lon,office,grid_x,grid_y,grid_elev_ft,real_elev_ft,sort_order,notes) values
 ('lodge','Lodge (Waitsfield)','base',44.2012,-72.9142,'BTV',101,45,1490,null,1,'Lodge point from Census address lookup; uses the square just east of the lodge (lodge''s own square 100,45 averages 2,759 ft).'),
 ('mrg_summit','Mad River Glen upper mountain','upper',44.1842,-72.9289,'BTV',100,45,2759,3662,2,'Stark Mountain summit (USGS).'),
 ('mount_ellen','Sugarbush Mt. Ellen upper mountain','upper',44.1601,-72.9293,'BTV',100,43,3104,4083,3,'Mount Ellen summit (USGS).'),
 ('lincoln_peak','Sugarbush Lincoln Peak upper mountain','upper',44.1273,-72.9284,'BTV',101,42,2933,3975,4,'Lincoln Peak summit (USGS).');

create table public.mountain_reports (
  id bigint generated always as identity primary key,
  mountain text not null check (mountain in ('sugarbush','mad_river_glen')),
  collected_at timestamptz not null default now(), checked_at timestamptz not null default now(),
  source_updated_at timestamptz, source_updated_text text, operating_status text,
  trails_open int, trails_total int, lifts_open int, lifts_total int,
  new_snow_24h_in numeric, new_snow_48h_in numeric, new_snow_72h_in numeric, new_snow_7d_in numeric, new_snow_text text,
  season_total_in numeric, season_total_text text, base_depth_text text,
  surface_primary text, surface_secondary text, base_temp_f numeric, summit_temp_f numeric,
  snow_by_area jsonb, lifts jsonb, report_text text, content_hash text not null
);
create index mountain_reports_latest on public.mountain_reports (mountain, collected_at desc);

create table public.stake_readings (
  issued_text text primary key, issued_at timestamptz,
  new_snow_in numeric, new_snow_trace boolean not null default false,
  depth_in numeric, depth_trace boolean not null default false,
  raw_line text, first_seen_at timestamptz not null default now()
);
create table public.stake_history (
  season text not null, day_index int not null, day_label text not null, depth_in numeric,
  primary key (season, day_index)
);
create table public.forecast_latest (
  point_id text primary key references public.weather_points(id),
  fetched_at timestamptz not null default now(), forecast_updated_at timestamptz, grid_updated_at timestamptz,
  periods jsonb, hourly jsonb
);
create table public.alerts_latest (scope text primary key, fetched_at timestamptz not null default now(), alerts jsonb not null default '[]'::jsonb);
create table public.source_state (key text primary key, value text, updated_at timestamptz not null default now());
create table public.collector_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(), finished_at timestamptz, ok boolean, results jsonb
);
create index collector_runs_started on public.collector_runs (started_at desc);

alter table public.weather_points enable row level security;
alter table public.mountain_reports enable row level security;
alter table public.stake_readings enable row level security;
alter table public.stake_history enable row level security;
alter table public.forecast_latest enable row level security;
alter table public.alerts_latest enable row level security;
alter table public.source_state enable row level security;
alter table public.collector_runs enable row level security;

select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'), 'collector_token', 'Shared secret the scheduled job sends to the collector function');
create or replace function public.check_collector_token(token text) returns boolean
language sql security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'collector_token' and decrypted_secret = token);
$$;
revoke all on function public.check_collector_token(text) from public, anon, authenticated;
grant execute on function public.check_collector_token(text) to service_role;

-------------------------------------------------------------------------------
-- 2. collector_schedule  (pg_net later moved to the "extensions" schema, step 3)
-------------------------------------------------------------------------------
create extension if not exists pg_cron;
select cron.schedule('lodge-collector-every-30-min', '*/30 * * * *', $job$
  select net.http_post(
    url := 'https://ybmnrzbykmjixhfqhwaz.supabase.co/functions/v1/collector',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-collector-token', (select decrypted_secret from vault.decrypted_secrets where name = 'collector_token')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$job$);

-------------------------------------------------------------------------------
-- 3. move_pg_net_to_extensions_schema
-------------------------------------------------------------------------------
drop extension if exists pg_net;
create extension pg_net with schema extensions;

-------------------------------------------------------------------------------
-- 4. hub_access_and_caches
-------------------------------------------------------------------------------
create table public.approved_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  label text not null, added_at timestamptz not null default now()
);
alter table public.approved_users enable row level security;
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.approved_users where user_id = (select auth.uid()));
$$;
revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated, service_role;

create policy "approved can read" on public.weather_points for select to authenticated using ((select public.is_approved()));
create policy "approved can read" on public.mountain_reports for select to authenticated using ((select public.is_approved()));
create policy "approved can read" on public.stake_readings for select to authenticated using ((select public.is_approved()));
create policy "approved can read" on public.stake_history for select to authenticated using ((select public.is_approved()));
create policy "approved can read" on public.forecast_latest for select to authenticated using ((select public.is_approved()));
create policy "approved can read" on public.alerts_latest for select to authenticated using ((select public.is_approved()));
create policy "approved can read" on public.collector_runs for select to authenticated using ((select public.is_approved()));
create policy "approved can see themselves" on public.approved_users for select to authenticated using (user_id = (select auth.uid()));

create table public.drive_cache (cache_key text primary key, created_at timestamptz not null default now(), result jsonb not null);
alter table public.drive_cache enable row level security;
create table public.nws_grid_cache (latlon text primary key, office text not null, grid_x int not null, grid_y int not null, label text, created_at timestamptz not null default now());
alter table public.nws_grid_cache enable row level security;

-------------------------------------------------------------------------------
-- 5. google_daily_cap  (our own hard limit on Google drive-time lookups; the hub function asks before each call)
-------------------------------------------------------------------------------
create table public.google_usage (day date primary key, calls int not null default 0);
alter table public.google_usage enable row level security;
create or replace function public.take_google_call(daily_limit int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare today date := (now() at time zone 'America/New_York')::date; n int;
begin
  insert into public.google_usage(day, calls) values (today, 0) on conflict (day) do nothing;
  update public.google_usage set calls = calls + 1 where day = today and calls < daily_limit returning calls into n;
  return n is not null;
end; $$;
revoke all on function public.take_google_call(int) from public, anon, authenticated;
grant execute on function public.take_google_call(int) to service_role;

-- 6. trip_times_alerts_terrain  (shared departure times, trip email lists and memory, trails by difficulty, lift hours)
-- Departure times chosen on the page, shared by Fred and Kelly (and used by the trip emails)
create table public.trip_departures (
  trip_key text primary key,           -- "<first day>|<calendar title>"
  up_time text check (up_time ~ '^\d{2}:\d{2}$'),
  home_time text check (home_time ~ '^\d{2}:\d{2}$'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.trip_departures enable row level security;
create policy "approved can read" on public.trip_departures for select to authenticated using ((select public.is_approved()));
create policy "approved can add" on public.trip_departures for insert to authenticated with check ((select public.is_approved()));
create policy "approved can change" on public.trip_departures for update to authenticated using ((select public.is_approved())) with check ((select public.is_approved()));

-- Who gets trip emails
alter table public.approved_users add column email_alerts boolean not null default false;
update public.approved_users set email_alerts = true where label in ('Fred (gmail)', 'Kelly');

create or replace function public.alert_recipients()
returns table (email text)
language sql stable security definer set search_path = ''
as $$
  select u.email::text from public.approved_users a join auth.users u on u.id = a.user_id where a.email_alerts and u.email is not null;
$$;
revoke all on function public.alert_recipients() from public, anon, authenticated;
grant execute on function public.alert_recipients() to service_role;

-- Trip email memory: last verdict level per trip, and every email sent
create table public.trip_alert_state (
  trip_key text primary key,
  last_level text,
  checked_at timestamptz not null default now()
);
alter table public.trip_alert_state enable row level security;
create table public.trip_alert_log (
  id bigint generated always as identity primary key,
  trip_key text not null,
  kind text not null check (kind in ('monday','red')),
  sent_at timestamptz not null default now(),
  level text,
  recipients int,
  result jsonb
);
alter table public.trip_alert_log enable row level security;
create policy "approved can read" on public.trip_alert_log for select to authenticated using ((select public.is_approved()));

-- Trails by difficulty and lift hours, from the mountains
alter table public.mountain_reports add column terrain_levels jsonb, add column lift_hours jsonb;

-- 7. trip_alerts_schedule  (checks trips 5 minutes past every hour; the function itself only acts at 8 AM, 2 PM and 8 PM Eastern)
select cron.schedule(
  'lodge-trip-alerts-hourly',
  '5 * * * *',
  $job$
  select net.http_post(
    url := 'https://ybmnrzbykmjixhfqhwaz.supabase.co/functions/v1/trip-alerts',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-collector-token', (select decrypted_secret from vault.decrypted_secrets where name = 'collector_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
