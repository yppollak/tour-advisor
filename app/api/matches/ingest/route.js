import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Where the browser extension delivers a tournament's matches, and where it asks
// which tournaments it has already read. Same personal ingest token as the entry
// lists, the rankings and the calendar; no session, so it works from an
// extension.
//
// GET  /api/matches/captured?season=2024-2025  -> { captured: { slug: {e,m} } }
// POST /api/matches/ingest                     -> { stored: n }
//
// The GET is what keeps the historical backfill to one pass: a finished
// tournament never changes, so the extension asks what is already stored and
// skips those outright rather than re-reading five seasons every run.
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-ingest-token",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS(){
  return new NextResponse(null, { status: 204, headers: CORS });
}

function client(){
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function tokenOf(request){
  return (request.headers.get("x-ingest-token") || "").trim();
}

const badToken = error => /invalid ingest token/i.test((error && error.message) || "");

export async function GET(request){
  const token = tokenOf(request);
  if(token.length < 32){
    return NextResponse.json({ error: "Missing ingest token." }, { status: 401, headers: CORS });
  }
  const season = new URL(request.url).searchParams.get("season") || null;

  const { data, error } = await client().rpc("captured_slugs", {
    p_token: token,
    p_season: season,
  });
  if(error){
    return NextResponse.json(
      { error: badToken(error) ? "That ingest token is not recognised." : error.message },
      { status: badToken(error) ? 401 : 500, headers: CORS }
    );
  }
  return NextResponse.json({ captured: data || {} }, { headers: CORS });
}

export async function POST(request){
  const token = tokenOf(request);
  if(token.length < 32){
    return NextResponse.json({ error: "Missing ingest token." }, { status: 401, headers: CORS });
  }

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400, headers: CORS }); }

  const slug = String((body && body.slug) || "").trim();
  const items = Array.isArray(body && body.items) ? body.items : null;
  if(!slug || !items){
    return NextResponse.json({ error: 'Expected {"slug": "...", "items": [...]}.' }, { status: 400, headers: CORS });
  }
  // A 128-draw plus its qualifying and its byes does not reach this.
  if(items.length > 600){
    return NextResponse.json({ error: "Send at most 600 matches per request." }, { status: 413, headers: CORS });
  }

  const { data, error } = await client().rpc("ingest_matches", {
    p_token: token,
    p_slug: slug,
    p_items: items,
    p_meta: (body && body.meta) || null,
  });

  if(error){
    return NextResponse.json(
      { error: badToken(error) ? "That ingest token is not recognised." : error.message },
      { status: badToken(error) ? 401 : 500, headers: CORS }
    );
  }

  return NextResponse.json(data || { stored: 0 }, { headers: CORS });
}
