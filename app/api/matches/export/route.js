import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Read-only export of the match history, so the rating can be fitted outside the
// browser instead of being read off a screen.
//
//   GET /api/matches/export?summary=1        -> { seasons: [...] }
//   GET /api/matches/export?after=0&limit=2000
//        -> { rows: [...], count, next_after }
//
// Paged on match_id rather than an offset, so a page never skips or repeats a
// row when the table is written to between requests. Byes are left out: they say
// something about draw size, nothing about who is better.
//
// Its own token, sent as x-export-token, NOT the ingest token. The ingest token
// can write to every table in the project; this one can only read matches, so it
// is the one that is safe to hand to whatever is doing the fitting.
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-export-token",
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

const badToken = error => /invalid export token/i.test((error && error.message) || "");

function fail(error){
  return NextResponse.json(
    { error: badToken(error) ? "That export token is not recognised." : error.message },
    { status: badToken(error) ? 401 : 500, headers: CORS }
  );
}

export async function GET(request){
  const token = (request.headers.get("x-export-token") || "").trim();
  if(token.length < 32){
    return NextResponse.json({ error: "Missing export token." }, { status: 401, headers: CORS });
  }

  const q = new URL(request.url).searchParams;

  if(q.get("summary")){
    const { data, error } = await client().rpc("export_summary", { p_token: token });
    if(error) return fail(error);
    return NextResponse.json({ seasons: data || [] }, { headers: CORS });
  }

  const after = Number(q.get("after") || 0);
  const limit = Number(q.get("limit") || 2000);

  const { data, error } = await client().rpc("export_matches", {
    p_token: token,
    p_after: Number.isFinite(after) ? after : 0,
    p_limit: Number.isFinite(limit) ? limit : 2000,
  });
  if(error) return fail(error);

  return NextResponse.json(data || { rows: [], count: 0, next_after: null }, { headers: CORS });
}
