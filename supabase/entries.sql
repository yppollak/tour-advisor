-- PSA Ranking Planner — entry lists.
-- Run this once in the Supabase SQL editor, after schema.sql.
-- Safe to re-run: every statement is idempotent.

-- 1. Each account gets a personal ingest token. The browser extension sends it
--    instead of a password; it identifies the account and nothing else.
alter table public.profiles add column if not exists ingest_token text unique;
-- Migration, for anyone who already ran an earlier version of this file.
alter table public.entry_lists add column if not exists qual_points jsonb;

update public.profiles
set ingest_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
where ingest_token is null;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, is_admin, ingest_token)
  values (
    new.id,
    new.email,
    lower(new.email) = lower('yppollak@gmail.com'),
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- 2. Current entry list, one row per tournament division.
create table if not exists public.entry_lists (
  tournament_slug text not null,
  division_id     text not null,
  tournament_name text,
  division_name   text,
  level           text,
  start_date      date,
  end_date        date,
  status          text,
  entries         jsonb not null default '[]'::jsonb,
  -- What PSA publishes for this event's qualifying draw, where it has one:
  -- {"Round 1": 70, "Semi-final": 90, "Final (Runner-up)": 110,
  --  "Qualifier (Winner)": 130}. It is not a fixed fraction of the main draw
  -- and most events publish none at all, so it is null far more often than not.
  qual_points     jsonb,
  content_hash    text,
  captured_at     timestamptz not null default now(),
  captured_by     uuid references auth.users(id) on delete set null,
  primary key (tournament_slug, division_id)
);
create index if not exists entry_lists_start_idx on public.entry_lists(start_date);

-- 3. History: a new row only when the list actually changed, so we can show
--    what moved since the last capture without storing 200 identical copies.
create table if not exists public.entry_list_snapshots (
  id              bigserial primary key,
  tournament_slug text not null,
  division_id     text not null,
  entries         jsonb not null,
  content_hash    text,
  captured_at     timestamptz not null default now()
);
create index if not exists entry_list_snapshots_key_idx
  on public.entry_list_snapshots(tournament_slug, division_id, captured_at desc);

-- 4. Everyone signed in can read entry lists; nobody writes them directly.
alter table public.entry_lists          enable row level security;
alter table public.entry_list_snapshots enable row level security;

drop policy if exists "entry_lists: read all" on public.entry_lists;
create policy "entry_lists: read all" on public.entry_lists
  for select to authenticated using (true);

drop policy if exists "entry_list_snapshots: read all" on public.entry_list_snapshots;
create policy "entry_list_snapshots: read all" on public.entry_list_snapshots
  for select to authenticated using (true);

-- 5. The only way in. Validates the token, upserts the current list, and files a
--    snapshot when the contents differ from what is already stored.
create or replace function public.ingest_entry_lists(p_token text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid;
  v_item    jsonb;
  v_hash    text;
  v_prev    text;
  v_changed int := 0;
  v_total   int := 0;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'invalid ingest token' using errcode = '28000';
  end if;

  select id into v_user from public.profiles where ingest_token = p_token;
  if v_user is null then
    raise exception 'invalid ingest token' using errcode = '28000';
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be an array' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    continue when coalesce(v_item->>'slug', '') = '' or coalesce(v_item->>'division_id', '') = '';
    v_total := v_total + 1;
    v_hash := md5(coalesce(v_item->'entries', '[]'::jsonb)::text);

    select content_hash into v_prev
    from public.entry_lists
    where tournament_slug = v_item->>'slug' and division_id = v_item->>'division_id';

    insert into public.entry_lists (
      tournament_slug, division_id, tournament_name, division_name, level,
      start_date, end_date, status, entries, qual_points, content_hash, captured_at, captured_by)
    values (
      v_item->>'slug', v_item->>'division_id', v_item->>'name', v_item->>'division_name', v_item->>'level',
      nullif(v_item->>'start_date', '')::date, nullif(v_item->>'end_date', '')::date, v_item->>'status',
      coalesce(v_item->'entries', '[]'::jsonb),
      case when jsonb_typeof(v_item->'qual_points') = 'object' then v_item->'qual_points' else null end,
      v_hash, now(), v_user)
    on conflict (tournament_slug, division_id) do update set
      tournament_name = excluded.tournament_name,
      division_name   = excluded.division_name,
      level           = excluded.level,
      start_date      = excluded.start_date,
      end_date        = excluded.end_date,
      status          = excluded.status,
      entries         = excluded.entries,
      qual_points     = excluded.qual_points,
      content_hash    = excluded.content_hash,
      captured_at     = excluded.captured_at,
      captured_by     = excluded.captured_by;

    if v_prev is distinct from v_hash then
      v_changed := v_changed + 1;
      insert into public.entry_list_snapshots (tournament_slug, division_id, entries, content_hash)
      values (v_item->>'slug', v_item->>'division_id', coalesce(v_item->'entries', '[]'::jsonb), v_hash);
    end if;
  end loop;

  return jsonb_build_object('received', v_total, 'changed', v_changed);
end $$;

grant execute on function public.ingest_entry_lists(text, jsonb) to anon, authenticated;

-- 6. A player's own token, for the Settings tab. Never exposes anyone else's.
create or replace function public.my_ingest_token()
returns text language sql stable security definer set search_path = public as $$
  select ingest_token from public.profiles where id = auth.uid()
$$;

grant execute on function public.my_ingest_token() to authenticated;
