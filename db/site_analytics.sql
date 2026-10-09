-- §260 OmniFlow website analytics. Run ONCE in the Supabase SQL editor (safe to run again).
--
-- Privacy design:
--   * no cookies, no local storage, no IP address stored: the server keeps a visitor code that changes every day
--   * every visit record is deleted once it is older than site_settings.retention_days (90 by default, never more
--     than 90). There are no daily rollups and no lifetime totals, so nothing older than the window is kept.
--   * site_maintain() runs once a day (Vercel Cron) and deletes records older than the window
--   * RLS is on for every table and has no policies; the two functions run for service_role only

create table if not exists site_settings (
  id int primary key default 1 check (id = 1),
  retention_days int not null default 90 check (retention_days between 1 and 90),
  tz_name text not null default 'Asia/Karachi',
  updated_at timestamptz not null default now()
);
insert into site_settings (id) values (1) on conflict (id) do nothing;

create table if not exists site_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event text not null,
  path text not null default '/',
  ref_host text not null default '',
  utm_source text not null default '',
  utm_medium text not null default '',
  utm_campaign text not null default '',
  device text not null default 'desktop',
  browser text not null default 'other',
  country text not null default '',
  lang text not null default '',
  meta text not null default '',
  seconds int not null default 0,
  visitor text not null
);
create index if not exists site_events_created_idx on site_events (created_at);
create index if not exists site_events_event_idx on site_events (event, created_at);

create table if not exists site_maintenance_log (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  retention_days int not null,
  cutoff timestamptz not null,
  raw_deleted bigint not null
);

alter table site_settings enable row level security;
alter table site_events enable row level security;
alter table site_maintenance_log enable row level security;
revoke all on site_settings, site_events, site_maintenance_log from anon, authenticated;

-- Daily job: delete visit records and cleanup-log rows older than the retention window, then log the run.
create or replace function site_maintain()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  keep int;
  oldest_kept timestamptz;
  removed bigint := 0;
  logs_removed bigint := 0;
begin
  select s.retention_days into keep from site_settings s where s.id = 1;
  keep := least(greatest(coalesce(keep, 90), 1), 90);
  oldest_kept := now() - make_interval(days => keep);

  delete from site_events where created_at < oldest_kept;
  get diagnostics removed = row_count;

  delete from site_maintenance_log where ran_at < oldest_kept;
  get diagnostics logs_removed = row_count;

  insert into site_maintenance_log (retention_days, cutoff, raw_deleted)
  values (keep, oldest_kept, removed);

  return jsonb_build_object('retention_days', keep, 'cutoff', oldest_kept,
                            'raw_deleted', removed, 'log_rows_deleted', logs_removed);
end;
$$;

-- Admin numbers for the last N days. The window is 1 to 90 days and only covers records still kept.
create or replace function site_stats(days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  span int := least(greatest(coalesce(days, 30), 1), 90);
  window_start timestamptz := now() - make_interval(days => least(greatest(coalesce(days, 30), 1), 90));
  tz text;
  result jsonb;
begin
  select s.tz_name into tz from site_settings s where s.id = 1;
  tz := coalesce(tz, 'Asia/Karachi');

  select jsonb_build_object(
    'days', span,
    'since', window_start,
    'timezone', tz,
    'totals', (
      select jsonb_build_object(
        'views', count(*) filter (where e.event = 'page_view'),
        'visitors', count(distinct e.visitor),
        'cta_clicks', count(*) filter (where e.event = 'cta_click'),
        'cta_visitors', count(distinct e.visitor) filter (where e.event = 'cta_click'),
        'form_submits', count(*) filter (where e.event = 'form_submit'),
        'form_visitors', count(distinct e.visitor) filter (where e.event = 'form_submit'),
        'avg_seconds', coalesce(round(avg(e.seconds) filter (where e.event = 'page_time' and e.seconds > 0))::int, 0)
      )
      from site_events e
      where e.created_at >= window_start
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', x.day, 'views', x.views, 'visitors', x.visitors) order by x.day)
      from (
        select (e.created_at at time zone tz)::date as day,
               count(*) filter (where e.event = 'page_view') as views,
               count(distinct e.visitor) as visitors
        from site_events e
        where e.created_at >= window_start
        group by 1
      ) x
    ), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object('path', x.path, 'views', x.views, 'visitors', x.visitors))
      from (
        select e.path, count(*) as views, count(distinct e.visitor) as visitors
        from site_events e
        where e.created_at >= window_start and e.event = 'page_view'
        group by e.path
        order by views desc, e.path
        limit 10
      ) x
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('source', x.source, 'views', x.views, 'visitors', x.visitors))
      from (
        select coalesce(nullif(e.ref_host, ''), 'direct') as source,
               count(*) as views, count(distinct e.visitor) as visitors
        from site_events e
        where e.created_at >= window_start and e.event = 'page_view'
        group by 1
        order by views desc, 1
        limit 10
      ) x
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object('utm_source', x.utm_source, 'utm_campaign', x.utm_campaign,
                                          'views', x.views, 'visitors', x.visitors))
      from (
        select e.utm_source, e.utm_campaign, count(*) as views, count(distinct e.visitor) as visitors
        from site_events e
        where e.created_at >= window_start and e.event = 'page_view' and e.utm_source <> ''
        group by e.utm_source, e.utm_campaign
        order by views desc, 1, 2
        limit 10
      ) x
    ), '[]'::jsonb),
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object('country', x.country, 'visitors', x.visitors))
      from (
        select e.country, count(distinct e.visitor) as visitors
        from site_events e
        where e.created_at >= window_start and e.country <> ''
        group by e.country
        order by visitors desc, 1
        limit 10
      ) x
    ), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object('device', x.device, 'visitors', x.visitors))
      from (
        select e.device, count(distinct e.visitor) as visitors
        from site_events e
        where e.created_at >= window_start
        group by e.device
        order by visitors desc, 1
        limit 10
      ) x
    ), '[]'::jsonb),
    'browsers', coalesce((
      select jsonb_agg(jsonb_build_object('browser', x.browser, 'visitors', x.visitors))
      from (
        select e.browser, count(distinct e.visitor) as visitors
        from site_events e
        where e.created_at >= window_start
        group by e.browser
        order by visitors desc, 1
        limit 10
      ) x
    ), '[]'::jsonb),
    'languages', coalesce((
      select jsonb_agg(jsonb_build_object('lang', x.lang, 'visitors', x.visitors))
      from (
        select e.lang, count(distinct e.visitor) as visitors
        from site_events e
        where e.created_at >= window_start and e.lang <> ''
        group by e.lang
        order by visitors desc, 1
        limit 10
      ) x
    ), '[]'::jsonb),
    'clicks', coalesce((
      select jsonb_agg(jsonb_build_object('target', x.meta, 'clicks', x.clicks))
      from (
        select e.meta, count(*) as clicks
        from site_events e
        where e.created_at >= window_start and e.event = 'cta_click'
        group by e.meta
        order by clicks desc, 1
        limit 10
      ) x
    ), '[]'::jsonb),
    'forms', coalesce((
      select jsonb_agg(jsonb_build_object('target', x.meta, 'submits', x.submits))
      from (
        select e.meta, count(*) as submits
        from site_events e
        where e.created_at >= window_start and e.event = 'form_submit'
        group by e.meta
        order by submits desc, 1
        limit 10
      ) x
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function site_maintain() from public, anon, authenticated;
grant execute on function site_maintain() to service_role;
revoke all on function site_stats(int) from public, anon, authenticated;
grant execute on function site_stats(int) to service_role;
