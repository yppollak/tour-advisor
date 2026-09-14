# PSA Ranking Planner

Tournament-planning tool for PSA squash players: which events to enter, based on
points on offer, points to defend, the ranking divisor and travel from home base.

Next.js on Vercel, Supabase for sign-in (Google) and the database. Each player
sees only their own profile; admins see every profile and maintain the shared
tournament schedule and rankings snapshots.

## Layout

- `lib/planner/engine.js` — the ranking maths (points precedence, rolling 365-day window, divisor, rank lookup). Pure functions.
- `lib/planner/engine.test.js` — regression test against Diego Gobbi's official card. `npm test`.
- `lib/planner/app.js` — the planner UI (Planner, Played, Calendar, Settings, Points table, Rankings) and the Supabase storage layer.
- `lib/planner/data.js` — schedule and rankings snapshots, points table, regions.
- `components/`, `app/` — the Next.js shell: sign-in page, auth callback, planner mount.
- `supabase/schema.sql` — tables, row-level security, admin bootstrap.

## Setup checklist

1. **Supabase → SQL Editor**: paste `supabase/schema.sql` (edit the admin e-mail first) and run it.
2. **Supabase → SQL Editor**: paste `supabase/entries.sql`, then `supabase/rankings.sql`, then `supabase/schedule.sql`, then `supabase/one_player.sql`, and run each.
3. **Supabase → Authentication → Providers → Google**: enable, paste the Google OAuth client ID and secret.
4. **Supabase → Authentication → URL Configuration**: Site URL = your Vercel URL; add `https://YOUR-SITE.vercel.app/auth/callback` to Redirect URLs.
5. **Vercel → Project → Settings → Environment Variables**: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase → Project Settings → API Keys).
6. **Vercel → Settings → Build & Development**: Framework Preset = Next.js. Redeploy.

## Rankings and entry lists

`PSA Sync` (the `psa-entry-sync` folder) is a Chrome extension that reads the
tournament calendar, the world rankings and the entry list of every upcoming
tournament from SecurePSA, using the login already open in the browser, and
posts them to `/api/schedule/ingest`, `/api/rankings/ingest` and
`/api/entries/ingest`. It never sees or stores a PSA
password; it authenticates to the planner with a per-account ingest token shown
under Settings -> Rankings & entry lists.

- `supabase/entries.sql` — `entry_lists` (current), `entry_list_snapshots`
  (history, written only when a list actually changes), the `ingest_token`
  column, and `ingest_entry_lists()`, the SECURITY DEFINER function that is the
  only write path.
- `supabase/rankings.sql` — `rankings` (the full list for both tours, one row
  per player) and `ingest_rankings()`. The last page of a division is sent with
  `final`, which clears whatever the previous capture left behind.
- `supabase/schedule.sql` — `schedule` (one row per draw, not per tournament:
  SecurePSA lists single events whose men's and women's draws sit at different
  levels) and `ingest_schedule()`. What is stored is what PSA published —
  level_type, level, city, country — and the mapping to "Challenger 18" and
  "Africa" happens once in the site, shared with the CSV import, so the two
  routes cannot drift apart.
- `app/api/entries/ingest/route.js`, `app/api/rankings/ingest/route.js` and
  `app/api/schedule/ingest/route.js` — validate the token and forward to those
  functions. No extra environment variables needed.
- The captured calendar replaces the snapshot built into the page, which knows
  nothing about tournaments added, moved or cancelled since it was built. The
  freshness bar says which of the two is in use.
- The full list is what makes the *honest average* possible: total points
  divided by tournaments played, with no worst results dropped. The official
  average flatters anyone past fifteen events; the honest one is the basis for
  field strength.
- Install the extension with chrome://extensions -> Developer mode -> Load
  unpacked, pointing at the `psa-entry-sync` folder.

## Local development

```
npm install
cp .env.example .env.local   # fill in the two values
npm run dev
```
