-- Tour Advisor — one player profile per account.
-- Run this once in the Supabase SQL editor, after schema.sql.
-- Safe to re-run: every statement is idempotent.

-- Why this is in the database and not in the browser.
--
-- The rule only means anything if it cannot be stepped around, and anything the
-- page enforces can be undone from the developer console in about ten seconds —
-- the browser is the attacker's machine, not ours. A trigger runs inside
-- Postgres on every insert, whoever is calling and from wherever.
--
-- What it is actually for is worth being honest about: it is not a lock, it is a
-- reason not to share. Two players sharing one login would share one player
-- profile — one set of results, one ranking, one plan — which is useless to both
-- of them. The rule removes the point of sharing rather than policing it.
--
-- Admins are exempt, because an admin holds every player they manage in one
-- account. That is the whole job.

create or replace function public.one_player_per_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- An admin manages many players; that is the point of being one.
  if public.is_admin() then
    return new;
  end if;

  -- Only inserts are limited. An update to the profile you already have, or a
  -- delete and a fresh start, both stay possible.
  select count(*) into v_count from public.players where owner = new.owner;

  if v_count >= 1 then
    raise exception
      'This account already has a player profile. Tour Advisor is one player per account — the schedule, the ranking and the plan are all about one person, so a second profile here would have nowhere to live. Delete the existing profile first, or use another account.'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists players_one_per_account on public.players;
create trigger players_one_per_account
  before insert on public.players
  for each row execute function public.one_player_per_account();

-- A note for whoever runs this on a database that already has more than one
-- profile on some account: the trigger is on INSERT only, so nothing existing
-- breaks. Those accounts keep what they have and simply cannot add more. This
-- query shows them.
--
--   select owner, count(*) from public.players group by owner having count(*) > 1;
