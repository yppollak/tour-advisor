import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Where the browser extension delivers the captured tournament calendar. Same
// personal ingest token as the entry lists and rankings; no session, so it works
// from an extension.
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-ingest-token",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS(){
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request){
  const token = (request.headers.get("x-ingest-token") || "").trim();
  if(token.length < 32){
    return NextResponse.json({ error: "Missing ingest token. Copy it from Tour Advisor's Settings tab." }, { status: 401, headers: CORS });
  }

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400, headers: CORS }); }

  const rows = Array.isArray(body && body.rows) ? body.rows : null;
  if(!rows){
    return NextResponse.json({ error: 'Expected {"rows": [...]}.' }, { status: 400, headers: CORS });
  }
  if(rows.length > 400){
    return NextResponse.json({ error: "Send at most 400 draws per request." }, { status: 413, headers: CORS });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // One id per run, so the final call can delete exactly the rows this capture
  // did not write — which is the only way a tournament PSA has dropped from the
  // calendar ever leaves the planner.
  const captureId = String((body && body.capture_id) || "").slice(0, 64) || null;

  const { data, error } = await supabase.rpc("ingest_schedule", {
    p_token: token,
    p_rows: rows,
    p_final: !!(body && body.final),
    p_capture_id: captureId,
  });

  if(error){
    const badToken = /invalid ingest token/i.test(error.message || "");
    return NextResponse.json(
      { error: badToken ? "That ingest token is not recognised." : error.message },
      { status: badToken ? 401 : 500, headers: CORS }
    );
  }

  return NextResponse.json(data || { received: 0, removed: 0, stored: 0 }, { headers: CORS });
}
