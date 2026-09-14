/* PSA Entry Sync — walks upcoming tournaments on SecurePSA and posts their
   entry lists to the planner. Runs in this page, using the SecurePSA session
   already present in this browser. No credentials are stored or transmitted. */

const PSA = "https://secure.psasquashtour.com";
const DEFAULT_ENDPOINT = "https://tour-advisor.vercel.app";
const CONCURRENCY = 3;      // parallel tournaments; deliberately gentle
const PAUSE_MS = 120;       // spacing between requests inside a worker
const BATCH = 25;           // divisions per upload
const MAX_PAGES = 40;
const RANK_BATCH = 400;     // players per upload
const RANK_MAX_PAGES = 150; // ~6,000 players per tour; the men's list runs to ~60

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

class AuthError extends Error {}

/* ---------- settings ---------- */
async function loadSettings(){
  const s = await chrome.storage.local.get(["token", "endpoint", "lastRun"]);
  $("#token").value = s.token || "";
  $("#endpoint").value = s.endpoint || DEFAULT_ENDPOINT;
  if(s.lastRun) $("#lastRun").textContent = "Last run: " + s.lastRun;
}
$("#saveBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({
    token: $("#token").value.trim(),
    endpoint: ($("#endpoint").value.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, ""),
  });
  $("#savedMsg").textContent = "Saved.";
  setTimeout(() => { $("#savedMsg").textContent = ""; }, 2500);
});

/* ---------- logging ---------- */
function log(msg, cls){
  const box = $("#log");
  box.classList.remove("hide");
  const line = document.createElement("div");
  if(cls) line.className = cls;
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

/* ---------- fetching ---------- */
async function getText(path, tries = 2){
  let lastErr;
  for(let i = 0; i < tries; i++){
    try {
      const r = await fetch(PSA + path, { credentials: "include", headers: { Accept: "text/html" } });
      if(r.redirected && /login|sign[_-]?in|auth/i.test(new URL(r.url).pathname)) throw new AuthError("not signed in");
      if(r.status === 401 || r.status === 403) throw new AuthError("not signed in");
      if(!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch(e){
      if(e instanceof AuthError) throw e;
      lastErr = e;
      if(i < tries - 1) await sleep(500);
    }
  }
  throw lastErr;
}

// Parse a SecurePSA page into an inert document.
//
// The scripts and stylesheets come out first. Chrome's preload scanner runs over
// a DOMParser document and tries to fetch what it finds there — SecurePSA ships a
// TinyMCE bundle on every page — and the extension's content security policy
// then blocks the request and logs an error. Nothing breaks, but it buried one
// console error per page under everything worth reading. We only ever look at
// tables and selects, so dropping both is free.
const INERT = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/>|<link\b[^>]*>/gi;
const doc = html => new DOMParser().parseFromString(String(html).replace(INERT, ""), "text/html");

/* ---------- parsers (verified against live SecurePSA markup) ---------- */
const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
const isoOf = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function parseDates(text){
  const range = text.match(/([A-Z][a-z]{2})\s+(\d{1,2})\s*[-–]\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/);
  if(range){
    const y = +range[5], sm = MONTHS[range[1]], em = MONTHS[range[3]];
    if(sm == null || em == null) return {};
    // A range that runs backwards by month started in the previous year.
    return { start: isoOf(sm > em ? y - 1 : y, sm, +range[2]), end: isoOf(y, em, +range[4]) };
  }
  const one = text.match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/);
  if(one && MONTHS[one[1]] != null){
    const d = isoOf(+one[3], MONTHS[one[1]], +one[2]);
    return { start: d, end: d };
  }
  return {};
}

function parseTournamentRows(html){
  const out = [];
  doc(html).querySelectorAll("tbody tr").forEach(tr => {
    const a = tr.querySelector('a[href^="/tournaments/"]');
    if(!a) return;
    const parts = a.getAttribute("href").split("/").filter(Boolean);
    if(parts.length !== 2 || parts[1] === "calendar") return;
    const cells = Array.from(tr.children).map(c => c.textContent.replace(/\s+/g, " ").trim());
    const dates = parseDates(cells[2] || "");
    out.push({
      slug: parts[1],
      name: a.textContent.replace(/\s+/g, " ").trim(),
      level: cells[1] || "",
      status: cells[3] || "",
      start_date: dates.start || null,
      end_date: dates.end || null,
    });
  });
  return out;
}

function parseDivisions(html){
  const d = doc(html);
  if(/no entries yet/i.test(d.body.textContent)) return { none: true, divisions: [] };
  const sel = d.querySelector('#division-selector, select[data-entries-turbo-target="divisionSelector"]');
  let divisions = sel
    ? Array.from(sel.options).map(o => ({ id: o.value, name: o.text.replace(/\s+/g, " ").trim() }))
    : Array.from(d.querySelectorAll("[data-division-id]")).map(t => ({
        id: t.dataset.divisionId, name: t.textContent.replace(/\s+/g, " ").trim().slice(0, 40) }));
  divisions = divisions.filter(x => x.id).filter((x, i, a) => a.findIndex(y => y.id === x.id) === i);
  return { none: false, divisions };
}

const NAT_RE = /^\[[A-Z]{3}\]$/;
const SEED_RE = /^\[\d+(\/\d+)?\]$/;
const FLAG_RE = /^(U\d{2}|RESERVE|WITHDRAWN|Q|LL|WC|PROTECTED)$/i;

function parseEntries(html){
  const d = doc(html);
  const rows = [];
  d.querySelectorAll("table").forEach(table => {
    let heading = table.previousElementSibling, hops = 0;
    while(heading && hops < 4 && !/main draw|reserve|withdraw/i.test(heading.textContent || "")){
      heading = heading.previousElementSibling; hops++;
    }
    if(!heading){
      let p = table.parentElement, k = 0;
      while(p && k < 3){
        const h = p.querySelector("h2,h3,h4");
        if(h && /main draw|reserve|withdraw/i.test(h.textContent)){ heading = h; break; }
        p = p.parentElement; k++;
      }
    }
    const head = (heading ? heading.textContent : "").toLowerCase();
    const section = head.includes("reserve") ? "reserve" : head.includes("withdraw") ? "withdrawn" : "main";
    const cols = Array.from(table.querySelectorAll("thead th")).map(x => x.textContent.trim().toLowerCase());
    const wrIdx = cols.findIndex(c => c.includes("ranking"));

    table.querySelectorAll("tbody tr").forEach(tr => {
      const tds = tr.querySelectorAll("td");
      if(!tds.length) return;
      const cell = Array.from(tds).find(td => td.querySelector("span")) || tds[0];
      let name = null, nat = null, seed = null;
      const flags = [];
      Array.from(cell.querySelectorAll("span"))
        .map(s => s.textContent.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .forEach(s => {
          if(NAT_RE.test(s)) nat = s.slice(1, -1);
          else if(SEED_RE.test(s)) seed = s.slice(1, -1);
          else if(FLAG_RE.test(s)) flags.push(s.toUpperCase());
          else if(!name) name = s;
        });
      if(!name) return;
      const wrRaw = wrIdx >= 0 && tds[wrIdx] ? parseInt(tds[wrIdx].textContent.replace(/\D/g, ""), 10) : NaN;
      const pos = section === "withdrawn" ? null : tds[0].textContent.replace(/\s+/g, " ").trim().slice(0, 6);
      rows.push({
        section,
        playerId: tr.dataset.playerId || null,
        entryId: tr.dataset.entryId || null,
        pos, name, nat, seed,
        flags,
        wr: Number.isFinite(wrRaw) ? wrRaw : null,
        info: section === "withdrawn" && tds[1] ? tds[1].textContent.replace(/\s+/g, " ").trim() : null,
      });
    });
  });
  return rows;
}

/* ---------- rankings ---------- */
// The first number in the cell, and only the first. The Rank cell carries the
// week's movement as a second number ("980 ⌄ 247"), so anything that reads the
// whole cell turns rank 980 into 980247.
const firstNum = s => {
  const m = String(s ?? "").match(/\d[\d,]*(?:\.\d+)?/);
  if(!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

function parseRankingRows(html){
  const d = doc(html);
  const table = d.querySelector("table");
  if(!table) return [];
  const cols = Array.from(table.querySelectorAll("thead th")).map(x => x.textContent.replace(/\s+/g, " ").trim().toLowerCase());
  const at = (needle, fallback) => { const i = cols.findIndex(c => c.includes(needle)); return i < 0 ? fallback : i; };
  const iRank = at("rank", 0), iName = at("player", 1), iCountry = at("countr", 2);
  const iTotal = at("total", 3), iCounting = at("counting", 4), iAvg = at("average", 5);
  const iPlayed = at("tournament", 6), iDivisor = at("divisor", 7);

  const out = [];
  table.querySelectorAll("tbody tr").forEach(tr => {
    const tds = Array.from(tr.querySelectorAll("td")).map(td => td.textContent.replace(/\s+/g, " ").trim());
    if(tds.length < 3) return;
    const rank = firstNum(tds[iRank]);
    const name = (tds[iName] || "").trim();
    if(rank == null || !name) return;
    out.push({
      rank: Math.round(rank),
      name,
      country: (tds[iCountry] || "").trim() || null,
      player_ranking_id: tr.dataset.playerRankingId || tr.dataset.playerId || null,
      total: firstNum(tds[iTotal]),
      counting: firstNum(tds[iCounting]),
      average: firstNum(tds[iAvg]),
      played: firstNum(tds[iPlayed]),
      divisor: firstNum(tds[iDivisor]),
    });
  });
  return out;
}

// The list is published on a Monday; if the site does not tell us which one,
// the most recent Monday is the right guess.
function lastMonday(todayIso){
  const d = new Date(todayIso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function rankingDate(todayIso){
  try {
    const r = await fetch(PSA + "/rankings", { credentials: "include", headers: { Accept: "text/html" } });
    if(r.status === 401 || r.status === 403) throw new AuthError("not signed in");
    const fromUrl = new URL(r.url).pathname.match(/\/rankings\/(\d{4}-\d{2}-\d{2})/);
    if(fromUrl) return fromUrl[1];
    const html = await r.text();
    const dates = Array.from(html.matchAll(/\/rankings\/(\d{4}-\d{2}-\d{2})/g)).map(m => m[1]).filter(x => x <= todayIso);
    if(dates.length) return dates.sort().pop();
  } catch(e){
    if(e instanceof AuthError) throw e;
  }
  return lastMonday(todayIso);
}

async function uploadRankings(endpoint, token, division, rankedOn, rows, final, captureId){
  const r = await fetch(endpoint + "/api/rankings/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ingest-token": token },
    body: JSON.stringify({ division, ranked_on: rankedOn, rows, final: !!final, capture_id: captureId }),
  });
  let body = {};
  try { body = await r.json(); } catch {}
  if(!r.ok) throw new Error(body.error || `rankings upload failed (HTTP ${r.status})`);
  return body;
}

async function syncRankings(endpoint, token, todayIso, totals){
  const rankedOn = await rankingDate(todayIso);
  log(`World rankings as of ${rankedOn}.`);
  totals.rankedOn = rankedOn;

  for(const division of ["men", "women"]){
    if(stopping) break;
    let outbox = [], seen = 0, page = 1;
    const keys = new Set();
    const captureId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    for(; page <= RANK_MAX_PAGES && !stopping; page++){
      const rows = parseRankingRows(await getText(
        `/rankings/${rankedOn}/table_view?division=${division}&sort_by=position&page=${page}`));
      if(!rows.length) break;
      // Past the end of the list the site serves the last page again rather
      // than an empty one, so an empty page is not the only way the walk ends:
      // a page that adds nobody new means we have already read everything.
      const fresh = rows.filter(r => { const k = r.rank + "|" + r.name; if(keys.has(k)) return false; keys.add(k); return true; });
      if(!fresh.length) break;
      outbox = outbox.concat(fresh);
      seen += fresh.length;
      $("#progress").textContent = `Reading the ${division}'s rankings… ${seen} players`;
      while(outbox.length >= RANK_BATCH){
        await uploadRankings(endpoint, token, division, rankedOn, outbox.splice(0, RANK_BATCH), false, captureId);
      }
      await sleep(PAUSE_MS);
    }
    // The last call clears whatever the previous capture left behind, but only
    // if we actually got a list — never wipe a good list because of a bad run.
    if(seen){
      const res = await uploadRankings(endpoint, token, division, rankedOn, outbox, !stopping, captureId);
      log(`${division === "men" ? "Men" : "Women"}: ${seen} players stored${res.removed ? `, ${res.removed} stale rows cleared` : ""}.`, "ok");
      totals.ranked += seen;
    } else {
      log(`${division === "men" ? "Men" : "Women"}: no rankings returned.`, "warn");
    }
  }
}

/* ---------- the run ---------- */
let stopping = false;
$("#stopBtn").addEventListener("click", () => { stopping = true; $("#stopBtn").disabled = true; log("Stopping after the tournaments in flight…", "warn"); });

async function collectTournaments(){
  const seen = new Set();
  const all = [];
  for(let page = 1; page <= MAX_PAGES; page++){
    const html = await getText(`/tournaments?show_past=false&view_mode=compact&page=${page}`);
    const rows = parseTournamentRows(html);
    if(!rows.length) break;
    let added = 0;
    rows.forEach(r => { if(!seen.has(r.slug)){ seen.add(r.slug); all.push(r); added++; } });
    if(!added) break;
    $("#progress").textContent = `Reading the tournament list… ${all.length} found`;
    await sleep(PAUSE_MS);
  }
  return all;
}

function isUpcoming(t, todayIso){
  if(/cancelled|canceled/i.test(t.status)) return false;
  const end = t.end_date || t.start_date;
  return end ? end >= todayIso : true;
}

async function upload(endpoint, token, items){
  const r = await fetch(endpoint + "/api/entries/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ingest-token": token },
    body: JSON.stringify({ items }),
  });
  let body = {};
  try { body = await r.json(); } catch {}
  if(!r.ok) throw new Error(body.error || `upload failed (HTTP ${r.status})`);
  return body;
}

async function run(){
  const token = $("#token").value.trim();
  const endpoint = ($("#endpoint").value.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  if(token.length < 32){
    $("#result").innerHTML = '<span style="color:var(--accent)">Paste your ingest token first — it is in the planner under Settings → Entry lists.</span>';
    return;
  }
  await chrome.storage.local.set({ token, endpoint });

  stopping = false;
  $("#runBtn").disabled = true;
  $("#stopBtn").classList.remove("hide");
  $("#stopBtn").disabled = false;
  $("#barWrap").classList.remove("hide");
  $("#log").innerHTML = "";
  $("#result").textContent = "";
  $("#bar").style.width = "0%";

  const started = Date.now();
  const totals = { tournaments: 0, divisions: 0, entries: 0, empty: 0, failed: 0, sent: 0, changed: 0, ranked: 0, rankedOn: null };

  try {
    const todayIso = new Date().toISOString().slice(0, 10);

    // Rankings first: the field-strength maths downstream reads every player's
    // total and tournaments played, so the entry lists are only useful with it.
    await syncRankings(endpoint, token, todayIso, totals);

    const all = stopping ? [] : await collectTournaments();
    if(!all.length && !stopping) throw new AuthError("no tournaments returned");

    const queue = all.filter(t => isUpcoming(t, todayIso));
    log(`${all.length} tournaments listed, ${queue.length} upcoming.`);
    totals.tournaments = queue.length;

    const outbox = [];
    let done = 0, cursor = 0;

    const flush = async (force) => {
      while(outbox.length >= BATCH || (force && outbox.length)){
        const chunk = outbox.splice(0, BATCH);
        const res = await upload(endpoint, token, chunk);
        totals.sent += res.received || 0;
        totals.changed += res.changed || 0;
        log(`Sent ${chunk.length} draws — ${res.changed || 0} changed since last time.`, "ok");
      }
    };

    const worker = async () => {
      while(cursor < queue.length && !stopping){
        const t = queue[cursor++];
        try {
          const { none, divisions } = parseDivisions(await getText(`/tournaments/${t.slug}/entries`));
          await sleep(PAUSE_MS);
          if(none || !divisions.length){
            totals.empty++;
          } else {
            for(const div of divisions){
              if(stopping) break;
              const entries = parseEntries(await getText(`/tournaments/${t.slug}/entries/table_view?division_id=${encodeURIComponent(div.id)}`));
              await sleep(PAUSE_MS);
              totals.divisions++;
              totals.entries += entries.length;
              outbox.push({
                slug: t.slug, name: t.name, level: t.level, status: t.status,
                start_date: t.start_date, end_date: t.end_date,
                division_id: String(div.id), division_name: div.name, entries,
              });
            }
          }
        } catch(e){
          if(e instanceof AuthError) throw e;
          totals.failed++;
          log(`${t.name}: ${e.message}`, "bad");
        }
        done++;
        const pct = Math.round((done / queue.length) * 100);
        $("#bar").style.width = pct + "%";
        $("#progress").textContent = `${done} of ${queue.length} tournaments · ${totals.divisions} draws · ${totals.entries} entries`;
        if(outbox.length >= BATCH) await flush(false);
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await flush(true);

    const secs = Math.round((Date.now() - started) / 1000);
    const stamp = new Date().toLocaleString();
    await chrome.storage.local.set({ lastRun: stamp });
    $("#lastRun").textContent = "Last run: " + stamp;
    $("#result").innerHTML = stopping
      ? `<span style="color:var(--warn)">Stopped early. ${totals.ranked} players ranked, ${totals.sent} draws sent.</span>`
      : `<span style="color:var(--yes)">Done in ${secs}s — ${totals.ranked} players ranked, ${totals.sent} draws from ${totals.tournaments} tournaments, ${totals.entries} entries, ${totals.changed} changed.</span>`;
    if(totals.empty) log(`${totals.empty} tournaments had no entry list yet.`, "warn");
    if(totals.failed) log(`${totals.failed} tournaments could not be read.`, "warn");
  } catch(e){
    if(e instanceof AuthError){
      $("#result").innerHTML = '<span style="color:var(--accent)">SecurePSA did not recognise this browser as signed in. Open secure.psasquashtour.com in another tab, sign in, then run this again.</span>';
    } else {
      $("#result").innerHTML = `<span style="color:var(--accent)">${esc(e.message)}</span>`;
    }
  } finally {
    $("#runBtn").disabled = false;
    $("#stopBtn").classList.add("hide");
  }
}

$("#runBtn").addEventListener("click", run);

// Started from the Refresh button on the site rather than the toolbar icon.
// The token has to be saved already — asking for it here would defeat the point
// of a one-click refresh, so an unconfigured extension says so and stops.
async function autoRun(){
  const s = await chrome.storage.local.get(["token"]);
  if(!(s.token || "").trim()){
    $("#result").innerHTML = '<span style="color:var(--accent)">Paste your ingest token and press Save first '
      + '\u2014 then the Refresh button on Tour Advisor will start a run straight away.</span>';
    return;
  }
  log("Started from Tour Advisor.", "ok");
  run();
}

// A second Refresh while this tab is already open should not stack two runs.
chrome.runtime.onMessage.addListener(msg => {
  if(msg && msg.action === "sync" && !$("#runBtn").disabled) autoRun();
});

loadSettings().then(() => {
  if(new URLSearchParams(location.search).get("auto") === "1") autoRun();
});
