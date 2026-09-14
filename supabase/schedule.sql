-- Tour Advisor — the captured tournament calendar.
-- Run this once in the Supabase SQL editor, after entries.sql and rankings.sql.
-- Safe to re-run: every statement is idempotent.

-- 1. One row per draw, not per tournament. SecurePSA lists a single event whose
--    men's and women's draws sit at different levels — "M (Challenger: 18)
--    W (World: Copper)" is one tournament and two completely different
--    decisions — so the men's row and the women's row are stored separately and
--    (slug, gender) is the key.
--
--    What is stored is what PSA published, not what the planner makes of it:
--    level_type and level rather than a size, city and country rather than a
--    continent. The mapping to "Challenger 18" and "Africa" lives in one place
--    in the site, shared with the CSV import, so the two routes cannot drift.
create table if not exists public.schedule (
  psa_slug    text not null,
  gender      text not null check (gender in ('M','W','MW')),
  name        text not null,
  city        text,
  country     text,
  level_type  text,
  level       text,
  restricted  boolean not null default false,
  status      text,
  start_date  date,
  end_date    date,
  capture_id  text,
  captured_at timestamptz not null default now(),
  primary key (psa_slug, gender)
);
create index if not exists schedule_date_idx on public.schedule (start_date);

alter table public.schedule enable row level security;
drop policy if exists "schedule: read all" on public.schedule;
create policy "schedule: read all" on public.schedule
  for select to authenticated using (true);

-- 2. The only write path. Same ingest token as the entry lists and rankings.
--    The extension sends the calendar in pages under one capture id; the last
--    call sets p_final, which deletes every row that capture did not write.
--
--    The cleanup is why the capture id matters. A tournament that PSA removes
--    from the calendar has to disappear from the planner too, and the only
--    evidence of a removal is its absence from a complete walk. Keyed on the
--    capture rather than on a date, a re-run replaces the previous attempt
--    instead of leaving its rows behind.
create or replace function public.ingest_schedule(
  p_token      text,
  p_rows       jsonb,
  p_final      boolean default false,
  p_capture_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid;
  v_row     jsonb;
  v_count   int := 0;
  v_removed int := 0;
  v_total   int := 0;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'invalid ingest token' using errcode = '28000';
  end if;

  select id into v_user from public.profiles where ingest_token = p_token;
  if v_user is null then
    raise exception 'invalid ingest token' using errcode = '28000';
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    continue when coalesce(v_row->>'psa_slug', '') = ''
               or coalesce(v_row->>'name', '') = ''
               or coalesce(v_row->>'gender', '') not in ('M','W','MW');
    v_count := v_count + 1;

    insert into public.schedule (
      psa_slug, gender, name, city, country, level_type, level,
      restricted, status, start_date, end_date, capture_id, captured_at)
    values (
      v_row->>'psa_slug',
      v_row->>'gender',
      v_row->>'name',
      nullif(v_row->>'city', ''),
      nullif(v_row->>'country', ''),
      nullif(v_row->>'level_type', ''),
      nullif(v_row->>'level', ''),
      coalesce((v_row->>'restricted')::boolean, false),
      nullif(v_row->>'status', ''),
      nullif(v_row->>'start_date', '')::date,
      nullif(v_row->>'end_date', '')::date,
      p_capture_id,
      now())
    on conflict (psa_slug, gender) do update set
      name        = excluded.name,
      city        = excluded.city,
      country     = excluded.country,
      level_type  = excluded.level_type,
      level       = excluded.level,
      restricted  = excluded.restricted,
      status      = excluded.status,
      start_date  = excluded.start_date,
      end_date    = excluded.end_date,
      capture_id  = excluded.capture_id,
      captured_at = excluded.captured_at;
  end loop;

  -- Never wipe a good calendar because of a bad run: a final call that carried
  -- no capture id, or that wrote nothing at all, deletes nothing.
  if p_final and p_capture_id is not null then
    delete from public.schedule where capture_id is distinct from p_capture_id;
    get diagnostics v_removed = row_count;
  end if;

  select count(*) into v_total from public.schedule;
  return jsonb_build_object('received', v_count, 'removed', v_removed, 'stored', v_total);
end $$;

grant execute on function public.ingest_schedule(text, jsonb, boolean, text) to anon, authenticated;

-- 3. How fresh the calendar is, for the freshness bar.
create or replace function public.schedule_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'draws',       count(*),
    'upcoming',    count(*) filter (where start_date >= current_date),
    'captured_at', max(captured_at))
  from public.schedule
$$;

grant execute on function public.schedule_summary() to authenticated;
