"use client";
import { DATA } from "./data.js";
import { ROUNDS, REGIONS, SIZES, DEFAULT_MATRIX, $, esc, dnum, iso, todayN, fmtD, fmtN, round2, slug, uid, refPts, pointsFor, ownPts, divisorFor, learnDivisors, rankPos, scenario, autoPerf } from "./engine.js";

/* ---------- state & storage ---------- */
const state = { players: {}, active: null, shared: {}, tab: "planner", filters: { q:"", cont:"", size:"", enter:"", floor:true, past:false, restricted:false }, rq: "" };
let ctx = null, saveTimers = {};
const LS_ACTIVE = "psa-planner-active";
function setSaveState(t){ const el = $("#saveState"); if(el) el.textContent = t; }
function rememberActive(){ try { localStorage.setItem(LS_ACTIVE, state.active || ""); } catch(e){} }
async function loadAll(){
  const [pl, sh] = await Promise.all([ctx.supabase.from("players").select("id,owner,name,data"), ctx.supabase.from("shared").select("key,data")]);
  if(pl.error) throw pl.error; if(sh.error) throw sh.error;
  state.players = {}; pl.data.forEach(r => { const p = normalize(Object.assign({}, r.data, { id: r.id, owner: r.owner, name: r.name })); state.players[p.id] = p; });
  state.shared = {}; sh.data.forEach(r => { state.shared[r.key] = r.data.value; if(r.data.date) state.shared[r.key + "Date"] = r.data.date; });
  let act = null; try { act = localStorage.getItem(LS_ACTIVE); } catch(e){}
  state.active = (act && state.players[act]) ? act : (Object.keys(state.players).sort((a,b) => state.players[a].name.localeCompare(state.players[b].name))[0] || null);
}
// Saving, with a local safety net.
//
// This used to write to Supabase and nowhere else, so a single failed request —
// a dropped connection, a sleeping project, "TypeError: Failed to fetch" — left
// the change in memory only. It looked like a warning. It was data loss: reload
// the page and the edit was gone.
//
// Now every change is written to this browser first and only then sent. A failed
// send is retried a few times with a widening gap, and whatever has not landed
// stays in localStorage under a pending key, so it survives a reload and goes up
// on the next attempt. The status line says which of those three states you are
// in rather than just "Saved".
const LS_PENDING = "tour-advisor-pending";

function pendingRead(){ try { return JSON.parse(localStorage.getItem(LS_PENDING) || "{}"); } catch(e){ return {}; } }
function pendingWrite(o){ try { localStorage.setItem(LS_PENDING, JSON.stringify(o)); } catch(e){} }
function pendingPut(row){ const o = pendingRead(); o[row.id] = row; pendingWrite(o); }
function pendingDrop(id){ const o = pendingRead(); if(o[id]){ delete o[id]; pendingWrite(o); } }

const SAVE_TRIES = [0, 1200, 4000, 12000];   // ms before each attempt after the first

async function pushRow(row, attempt){
  const { error } = await ctx.supabase.from("players").upsert(row);
  if(!error){ pendingDrop(row.id); setSaveState(pendingCount() ? "Saved — " + pendingCount() + " still to send" : "Saved"); return true; }
  const next = attempt + 1;
  if(next < SAVE_TRIES.length){
    setSaveState("Saving… (retrying)");
    setTimeout(() => pushRow(row, next), SAVE_TRIES[next]);
    return false;
  }
  // Out of attempts. The change is not lost — it is in this browser and will be
  // sent on the next edit or the next load — so say that rather than just the error.
  console.warn(error);
  setSaveState("Kept on this device — not sent yet (" + (error.message || "no connection") + ")");
  return false;
}

function pendingCount(){ return Object.keys(pendingRead()).length; }

function savePlayer(p){
  const row = { id: p.id, owner: p.owner || ctx.user.id, name: p.name,
                data: JSON.parse(JSON.stringify(p)), updated_at: new Date().toISOString() };
  pendingPut(row);                       // local first, always
  clearTimeout(saveTimers[p.id]);
  setSaveState("Saving…");
  saveTimers[p.id] = setTimeout(() => pushRow(row, 0), 500);
}

// Anything that never made it up last session goes now, before the page is used.
async function flushPending(){
  const o = pendingRead();
  const ids = Object.keys(o);
  if(!ids.length) return;
  setSaveState("Sending " + ids.length + " change" + (ids.length === 1 ? "" : "s") + " from last time…");
  for(const id of ids) await pushRow(o[id], SAVE_TRIES.length - 1);
}
async function saveSharedKey(key){ const { error } = await ctx.supabase.from("shared").upsert({ key, data: { value: state.shared[key], date: state.shared[key + "Date"] || null }, updated_at: new Date().toISOString() }); if(error) throw error; }
async function deletePlayer(id){ delete state.players[id]; const { error } = await ctx.supabase.from("players").delete().eq("id", id); if(error){ console.warn(error); toast("Could not delete: " + error.message); } }

function newPlayer(o){ const id = slug(o.name) + "-" + uid().slice(0,4);
  return { id, owner: ctx.user.id, name: o.name, gender: o.gender || "M", home: o.home || "Europe", notes: o.notes || "",
    card: { counting: null, played: null, average: null, rank: null, date: "" },
    perf: autoPerf(0), matrix: JSON.parse(JSON.stringify(DEFAULT_MATRIX)), played: [], planner: {}, playedIncl: {}, custom: [] }; }
function normalize(p){ p.odds = p.odds || {}; p.cols = p.cols || {}; p.planner = p.planner || {}; p.playedIncl = p.playedIncl || {}; p.custom = p.custom || []; p.played = p.played || []; p.card = p.card || {}; p.perf = p.perf || autoPerf(0); p.matrix = p.matrix || JSON.parse(JSON.stringify(DEFAULT_MATRIX)); return p; }
const P = () => state.players[state.active];

/* ---------- derived data ---------- */
// The captured calendar (from the extension, shared by everyone on the account)
// beats a CSV import, which beats the snapshot built into the page. The snapshot
// ages the moment it ships: tournaments are added, moved and cancelled all year.
const schedule = () => captured.schedule || state.shared.schedule || DATA.schedule;
const scheduleSource = () => captured.schedule ? "captured"
  : state.shared.schedule ? "csv" : "bundled";

// PSA's own words turned into the planner's. One function, used by both the
// captured calendar and the CSV import, because two copies of this mapping would
// quietly disagree about what a Challenger 18 is worth.
//
// Anything the points table has never heard of is dropped, not guessed at.
//
// The reason written here before was wrong, and Yuri corrected it on 16 Sep:
// Federation events, national championships and age-group draws **do** award PSA
// points. PSA's own wording, on the Points Claims section of every tournament
// page: "Ranking points from Satellite Events and Federation Events are only
// awarded if claimed by the player." They pay, they just have to be claimed
// within seven days.
//
// They still drop out here, for a different and smaller reason: we have no
// points table for them. Every category we do value — Satellite, the
// Challengers, Copper through Diamond — has a fixed table; a Federation event
// publishes its own on its page and we do not capture it yet. So this is a gap
// in what we can value, not a judgement that they are worthless, and it is on
// the list as such.
function scheduleRow(r){
  const type = String(r.level_type || "").trim();
  if(!["Satellite", "Challenger", "World"].includes(type)) return null;
  const lvl = String(r.level || "").trim();
  const size = type === "Challenger" ? "Challenger " + lvl
    : type === "Satellite" ? "Satellite"
    : lvl === "World Championships" ? "World Championship" : lvl;
  if(!DATA.points[size]) return null;

  const gender = String(r.gender || "").trim().toUpperCase();
  if(!["M", "W", "MW"].includes(gender)) return null;
  const country = String(r.country || "").replace(/^[,\s]+/, "").trim();
  const city = String(r.city || "").trim();
  return {
    id: slug(r.name + "-" + gender),
    name: String(r.name || "").trim(),
    start: r.start_date || "",
    end: r.end_date || "",
    location: [city, country].filter(Boolean).join(", ") || "TBA",
    continent: DATA.countryContinent[country] || "TBA",
    size, gender,
    // A string "false" out of a CSV is still a string, and every truthy test on
    // it says restricted. Only the real thing counts.
    restricted: r.restricted === true || r.restricted === "true" || r.restricted === "1" || r.restricted === 1,
    // PSA's own sentence, where the tournament page gave one. Not parsed into a
    // yes or a no — the player reads "residing in: Canada" and knows at once.
    restriction: r.restriction || "",
    status: r.status || "",
  };
}
// Captured rankings (the whole list, from the extension) beat the CSV snapshot,
// which beats the bundled sample. Only the captured list carries played counts
// for everyone, which is what the honest average needs.
const captured = { men: null, women: null, meta: null, tried: false, schedule: null, schedMeta: null };
// Reading the list is also how the divisor scale gets learned, so this is the one
// place that has to notice when the list changes.
let divisorSrc = null;
const rankingsFor = g => {
  const rk = g === "W"
    ? (captured.women || state.shared.rankingsW || null)
    : (captured.men || state.shared.rankings || DATA.rankings);
  if(rk && rk !== divisorSrc){ divisorSrc = rk; learnDivisors(rk); }
  return rk;
};
const rankingsSource = g => (g === "W" ? captured.women : captured.men) ? "captured"
  : (g === "W" ? state.shared.rankingsW : state.shared.rankings) ? "csv" : "bundled";
// Total points over tournaments played, nothing dropped. The official average
// keeps only the best 11, or the best played−4 once past 15, so under 11 played
// it is harsher (the gap is filled with zeros) and above 11 it is kinder.
// No smoothing for a small sample, deliberately: a player who leaves college at
// 24, enters two events and wins both is ranked 500th by the divisor but is
// genuinely a top-100 player, and this number is what says so.
const honestAvg = r => (r && r.played > 0 && r.total != null)
  ? Number(r.total) / Number(r.played) : null;
function pool(p){ const g = p.gender || "M";
  const rows = schedule().filter(s => s.gender === g || s.gender === "MW").map(s => Object.assign({ fromSchedule: true }, s));
  (p.custom || []).forEach(c => rows.push(Object.assign({ fromSchedule: false, gender: g, status: "custom" }, c)));
  rows.sort((a,b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.name.localeCompare(b.name));
  return rows.map(s => { const o = p.planner[s.id] || {}; const r = Object.assign({}, s, { use: !!o.use, enter: o.enter || "No", exact: o.exact || "", rfrom: o.rfrom || "", rto: o.rto || "", notes: o.notes || "" });
    r.pts = pointsFor(r, p.perf); r.own = ownPts(r); r.fromDefault = r.own == null;
    r.d = dnum(r.start); r.tier = tierFor(p, r.continent); return r; }); }
function tierFor(p, cont){ const row = p.matrix[p.home]; const i = REGIONS.indexOf(cont); return (row && i >= 0) ? row[i] : 0; }
function histRows(p){ return p.played.map(h => Object.assign({}, h, { pts: pointsFor(h, p.perf), d: dnum(h.date) })).sort((a,b) => (a.d||0) - (b.d||0)); }
function playedRows(p){ // manual history + auto rows from Planner (Enter = Yes / Planned), in date order = PlanSeq
  const manual = histRows(p).map(h => Object.assign(h, { kind: "manual", incl: h.use !== false }));
  const auto = pool(p).filter(r => r.enter === "Yes" || r.enter === "Planned").map(r => ({ kind: "auto", id: r.id, date: r.start, d: r.d, name: r.name, location: r.location, size: r.size, enter: r.enter, exact: r.exact, rfrom: r.rfrom, rto: r.rto, pts: r.pts, incl: !!p.playedIncl[r.id] }));
  return manual.concat(auto); }
function plannerScenario(p){ const items = histRows(p).map(h => ({ d: h.d, pts: h.pts, incl: true })).concat(pool(p).filter(r => r.use).map(r => ({ d: r.d, pts: r.pts, incl: true }))); return scenario(items, rankingsFor(p.gender)); }
function playedScenario(p){ const rows = playedRows(p); const items = rows.map(r => ({ d: r.d, pts: r.pts, incl: r.incl })); const s = scenario(items, rankingsFor(p.gender)); rows.forEach((r,i) => Object.assign(r, { inwin: items[i].inwin, prank: items[i].prank, counting: items[i].counting })); s.rows = rows;
  s.checkedPts = rows.filter(r => r.incl).reduce((a,r) => a + r.pts, 0); s.checkedN = rows.filter(r => r.incl).length; return s; }
// The smallest category still worth entering: one where winning beats your
// average, so the result can pull you up rather than down.
//
// It takes the scenario it is describing rather than always computing its own.
// It used to do the opposite twice over: it always used the Played scenario even
// when the Planner projection was on screen, and it preferred the average from
// your PSA card over the computed one. So the tile could read 58.8 while the
// sentence one line below it said "the current average of 76.55" — both real
// figures, the same word, different quantities, no way to tell.
//
// The number under the strip must be the number in the strip. Where your card
// disagrees with your entered results, the tile's own delta chip already says so.
function floorInfo(p, s){
  const sc = s || playedScenario(p);
  const avg = sc.avg, played = sc.played;
  const card = (p.card && p.card.average != null && p.card.average !== "") ? Number(p.card.average) : null;
  // Worth flagging separately: a floor built on a history you have not finished
  // entering is a floor built on the wrong number.
  const cardGap = (card != null && Number.isFinite(card) && Math.abs(card - avg) >= 1) ? card : null;
  if(played < 11) return { active: false, avg, played, size: null, cardGap };
  const size = SIZES.find(sz => DATA.points[sz][0] >= avg) || null;
  return { active: true, avg, played, size, cardGap };
}

/* ---------- rendering ---------- */
function render(){ const p = P(); document.body.classList.toggle("no-player", !p); if(!p){ renderPlayerSel(); return; } renderPlayerSel(); loadCapturedRankings(); loadEntryLists(); renderStrip(); ({ planner: renderPlanner, played: renderPlayed, plan: renderPlan, calendar: renderCalendar, settings: renderSettings, points: renderPoints, rankings: renderRankings, help: renderHelp })[state.tab](); }
function renderPlayerSel(){ const sel = $("#playerSel"); sel.hidden = Object.keys(state.players).length < 2; sel.innerHTML = Object.values(state.players).sort((a,b) => a.name.localeCompare(b.name)).map(p => `<option value="${esc(p.id)}"${p.id === state.active ? " selected" : ""}>${esc(p.name)}</option>`).join(""); }
function renderStrip(){ const p = P(); const usePlanner = state.tab === "planner"; const s = usePlanner ? plannerScenario(p) : playedScenario(p); const c = p.card || {};
  // The triangle means better or worse, not bigger or smaller — a rank going
  // 100 → 93 is an improvement even though the number fell. "flat" is for the
  // figures that move without that being good or bad news either way.
  const delta = (v, ref, inv) => { if(ref == null || ref === "" || v == null) return ""; const d = v - Number(ref); if(Math.abs(d) < 0.005) return `<span class="delta">no change</span>`;
    if(inv === "flat") return `<span class="delta flat">${d > 0 ? "\u25B2" : "\u25BC"} ${fmtN(Math.abs(d))}</span>`;
    const up = inv ? d < 0 : d > 0; return `<span class="delta ${up ? "up" : "down"}">${up ? "\u25B2" : "\u25BC"} ${fmtN(Math.abs(d))}</span>`; };
  $("#strip").innerHTML = `
    <div class="tile"><span class="eyebrow" data-tip="counting">Counting points</span><span class="v num">${fmtN(s.total)}</span>${delta(s.total, c.counting)}</div>
    <div class="tile"><span class="eyebrow" data-tip="playedwin">Played (in window)</span><span class="v num">${s.played}</span>${delta(s.played, c.played, "flat")}</div>
    <div class="tile"><span class="eyebrow" data-tip="divisor">Divisor</span><span class="v num">${s.divisor}</span>${c.played ? delta(s.divisor, divisorFor(Number(c.played)), true) : `<span class="d">${s.played <= 15 ? "11 until 16 played" : "from the published list"}</span>`}</div>
    <div class="tile"><span class="eyebrow" data-tip="average">Average</span><span class="v num">${fmtN(s.avg)}</span>${delta(s.avg, c.average)}</div>
    <div class="tile rank"><span class="eyebrow" data-tip="projrank">Projected rank</span><span class="v num">${s.rank == null ? "—" : "#" + s.rank}</span>${delta(s.rank, c.rank, true)}</div>
    <div class="tile"><span class="eyebrow" data-tip="window">Window</span><span class="v num" style="font-size:18px;padding-top:6px">${fmtD(s.start)} → ${fmtD(s.end)}</span><span class="d">rolls with the latest ticked event</span></div>`;
  // The tile takes the colour so the number itself stays a number.
  document.querySelectorAll("#strip .tile").forEach(t => { const d = t.querySelector(".delta");
    t.classList.toggle("good", !!(d && d.classList.contains("up")));
    t.classList.toggle("bad", !!(d && d.classList.contains("down"))); });
  const note = $("#cardNote");
  if(note){ const has = c.counting != null || c.average != null || c.rank != null;
    note.hidden = !has;
    note.textContent = has ? `Compared with your ranking${c.date ? " of " + fmtD(dnum(c.date)) : ""}, as PSA has it.` : ""; }
  fillPinbar(p, s, c, delta);
  renderFreshness();
  const f = floorInfo(p, s);
  const gapNote = f.cardGap != null
    ? ` PSA has your average at ${fmtN(f.cardGap)} \u2014 the difference is results not yet on the Played tab, and the floor follows the figure above, not PSA's.`
    : "";
  // Say what a win there actually pays. The category names are prize money —
  // "Challenger 6" is a $6k event — and they look enough like point totals to be
  // read as them, so a sentence comparing a category to an average without ever
  // naming the points is a sentence you cannot check.
  const floorWin = f.size && DATA.points[f.size] ? DATA.points[f.size][0] : null;
  $("#stripNote").innerHTML = (usePlanner ? "Planner projection: all played results plus every ticked Planner row. " : "Played scenario: only ticked rows count, inside the rolling 365-day window. ") + (f.active ? `<span data-tip="floor">Sensible floor</span>: ${esc(f.size)} \u2014 winning one pays <b>${fmtN(floorWin)}</b>, which beats the average above, ${fmtN(f.avg)}. Anything smaller can only pull you down.${gapNote}` : `Fewer than 11 counted tournaments \u2014 the average is diluted by zeros, so no floor is applied.${gapNote}`);
  bindTips(); }


/* ---------- the Plan tab ---------- */
function planPrefs(p){
  p.plan = p.plan || {};
  if(!p.plan.basis) p.plan.basis = "honest";
  if(!p.plan.to) p.plan.to = iso(todayN() + PLAN_HORIZON);
  if(p.plan.travel == null) p.plan.travel = false;
  // Which reserve places the player has said he would actually travel for.
  // Empty by default, which is the same answer the tab gave before it asked.
  p.plan.taken = p.plan.taken || {};
  // Where you are allowed to play, which is not the same question as where you
  // would like to. A PSA Regional membership covers its own region and nothing
  // else, so for Yuri — Regional, the Americas — a European Copper is not a long
  // flight, it is not enterable. Empty means no restriction, which is what every
  // player has until they say otherwise.
  p.plan.regions = Array.isArray(p.plan.regions) ? p.plan.regions : [];
  return p.plan;
}
// TBA venues are never excluded: an event with no announced country cannot be
// ruled out on where it is, and ruling it out silently is the worse error.
function regionOk(pr, cont){
  if(!pr.regions || !pr.regions.length) return true;
  if(!cont || cont === "TBA") return true;
  return pr.regions.indexOf(cont) >= 0;
}

/* ---------- the readings ---------- */
// Five ways to read the same tournament, side by side rather than one at a time.
// The first two measure every opponent in the draw and differ only in how: raw
// is total points over tournaments played, official is the PSA average with the
// worst results dropped. Where they disagree, the disagreement is the point.
//
// The last does not look at the opponents at all — it is the player's own
// expectation of the round he reaches at each category — so it is named for what
// it is rather than dressed up as a third measurement.
//
// SquashLevels and ClubLocker are listed and marked unavailable rather than
// hidden. Both were investigated on 14 Sep and neither can be captured yet (see
// claude/squashlevels.md and claude/clublocker.md); showing them greyed is the
// honest account of a switch the player was promised four options on.
const READINGS = [
  { k: "honest",   label: "Raw average",      tip: "Every opponent measured by total points ÷ tournaments played, nothing dropped." },
  { k: "official", label: "Official average", tip: "Every opponent measured by the average PSA publishes — best 11, or best played−4 past fifteen." },
  { k: "sl",       label: "SquashLevels",     soon: true, tip: "Not captured yet. SquashLevels rates players on matches actually played, including off the PSA tour, but its pages cannot be read in the background and it needs a subscription." },
  { k: "cl",       label: "ClubLocker",       soon: true, tip: "Not captured yet. The Universal Squash Rating covers players who play US Squash matches, so it would read an American draw well and a foreign one barely at all." },
  { k: "mine",     label: "My evaluation",    tip: "Ignores who entered. Uses the round you expect to reach at each category, from Settings." },
];
const READING_KEYS = READINGS.filter(r => !r.soon).map(r => r.k);
function renderPlanControls(p){
  const pr = planPrefs(p), reach = planReach(p);
  const to = $("#planTo"); if(to && to.value !== pr.to) to.value = pr.to;
  const sel = $("#planCeil");
  const why = reach.source === "lists" && reach.evidence
    ? ` (rank ${reach.evidence.cut} got into a ${reach.evidence.size})`
    : " (from your record)";
  if(sel) sel.innerHTML = SIZES.map((s, i) =>
    `<option value="${esc(s)}"${i === reach.ceil ? " selected" : ""}>${esc(s)}${s === reach.auto ? why : ""}</option>`).join("");
  const tv = $("#planTravel"); if(tv) tv.checked = !!pr.travel;
  fillMulti("#planRegions", REGIONS, pr.regions, "Where you can play");
}

/* ---------- the Plan tab's questions ---------- */
// The tab used to compute the moment you arrived and recompute on every redraw,
// which meant the numbers could move under you when something upstream reloaded,
// and meant the reserve list was shown as information after the fact rather than
// asked about before. Now it asks first and computes on a button.
//
// The reserve question is the one that needed asking. There is no modelling
// answer to "would you fly somewhere on a reserve place and maybe not play" —
// it is appetite for risk, and it belongs to the player.
const PLAN_RUN = { key: null, results: null, running: false };

function planRunKey(p){
  const pr = planPrefs(p);
  return [pr.to, pr.ceiling || "", !!pr.travel, Object.keys(pr.taken).filter(k => pr.taken[k]).sort().join(","),
          p.id, p.gender, fieldK].join("|");
}

// Every tournament in the window whose captured entry list leaves you outside
// the main draw, with the evidence the decision actually turns on.
function planReserveChoices(p){
  const pr = planPrefs(p);
  const to = dnum(pr.to);
  if(to == null) return [];
  const pool = planPool(p, todayN(), to, pr.basis, null);
  const wstats = withdrawalStats(p.gender);
  return (pool.outside || [])
    .filter(x => x.reserve)
    .map(x => Object.assign({}, x, { odds: reserveOdds(wstats, x.size, x.reserve) }))
    .sort((a, b) => (a.reserve || 99) - (b.reserve || 99) || a.d - b.d);
}

function renderPlanQuestions(p){
  const host = $("#planAsk"); if(!host) return;
  const pr = planPrefs(p);
  const choices = planReserveChoices(p);
  const ticked = choices.filter(x => pr.taken[x.id]).length;

  const rows = !choices.length
    ? `<p class="hint">No captured entry list puts you on a reserve list in this window, so there is nothing to decide here.</p>`
    : `<ul class="resask">${choices.map(x => {
        const o = x.odds;
        const ev = !o ? `<span class="na">no ${esc(x.size)} draws captured yet</span>`
          : !o.deepest ? `nobody came off the reserves · ${o.lists} ${esc(x.size)} draw${o.lists === 1 ? "" : "s"}`
          : `<b>#${o.deepest}</b> deepest reserve to play · ${o.lists} ${esc(x.size)} draw${o.lists === 1 ? "" : "s"}`;
        const verdict = !o || !o.deepest ? ""
          : o.reach ? ` <i class="ptag reach">in reach</i>` : ` <i class="ptag res">short by ${o.short}</i>`;
        return `<li>
          <label><input type="checkbox" data-res="${esc(x.id)}"${pr.taken[x.id] ? " checked" : ""}>
            <span class="rn">${esc(x.name)} <i class="ptag res">reserve #${x.reserve}</i>${verdict}</span></label>
          <span class="rd">${planDate(x.d)} · ${esc(x.size)} · ${esc(x.continent)}</span>
          <span class="rv">${ev}</span>
        </li>`; }).join("")}</ul>`;

  const stale = PLAN_RUN.results && PLAN_RUN.key !== planRunKey(p);
  host.innerHTML = `
    <div class="askbox">
      <h2>Would you travel for these?</h2>
      <p class="hint">Each of these is a tournament whose entry list has you outside the main draw. Tick the ones you would get on a plane for anyway. A ticked one is planned as a whole tournament — <b>either you play or you don't</b>, so nothing here is counted as a fraction. An unticked one stays out of the schedule completely.</p>
      ${rows}
      <div class="askrun">
        <button class="btn primary" id="planRun">${PLAN_RUN.results ? "Run again" : "Run the scenario"}</button>
        <span class="hint" id="planRunNote">${
          PLAN_RUN.running ? "working…"
          : stale ? "Something changed — run again to update the schedules below."
          : PLAN_RUN.results ? `${ticked} reserve place${ticked === 1 ? "" : "s"} included.`
          : "Nothing is computed until you press this."}</span>
      </div>
    </div>`;
  const btn = $("#planRun");
  if(btn) btn.addEventListener("click", () => runPlan(p));
  host.querySelectorAll("input[data-res]").forEach(cb =>
    cb.addEventListener("change", e => {
      const q = P(); const pp = planPrefs(q);
      if(e.target.checked) pp.taken[e.target.dataset.res] = true;
      else delete pp.taken[e.target.dataset.res];
      savePlayer(q); renderPlanQuestions(q);
    }));
  bindTips();
}

// One press computes every reading that can be computed, so switching between
// them afterwards is instant and the comparison costs nothing extra.
function runPlan(p){
  const pr = planPrefs(p);
  const to = dnum(pr.to);
  if(to == null || to <= todayN()){
    $("#planOut").innerHTML = `<p class="hint">Pick a target date in the future.</p>`;
    return;
  }
  PLAN_RUN.running = true; renderPlanQuestions(p);
  // Let the button's state paint before the optimiser blocks the thread.
  setTimeout(() => {
    const results = {};
    READING_KEYS.forEach(k => {
      results[k] = planBoth(p, { to, basis: k, travel: !!pr.travel, taken: pr.taken });
    });
    PLAN_RUN.results = results;
    PLAN_RUN.key = planRunKey(p);
    PLAN_RUN.running = false;
    renderPlanQuestions(p);
    renderPlan();
  }, 20);
}

const PLAN_MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function planDate(d){ const dt = new Date(d * 86400000);
  return `${dt.getUTCDate()} ${PLAN_MON[dt.getUTCMonth()]} ${String(dt.getUTCFullYear()).slice(2)}`; }

const planBasisName = b => b === "official" ? "the official average"
  : b === "mine" ? "your own evaluation" : "the raw average";

function renderPlan(){
  const p = P(), pr = planPrefs(p);
  renderPlanControls(p);
  renderPlanQuestions(p);
  const out = $("#planOut"); if(!out) return;

  const to = dnum(pr.to);
  if(to == null || to <= todayN()){
    out.innerHTML = `<p class="hint">Pick a target date in the future.</p>`;
    $("#planCount").textContent = ""; return;
  }

  if(!PLAN_RUN.results){
    out.innerHTML = `<p class="hint">Answer the questions above and press <b>Run the scenario</b>. Nothing is computed until you do — which is deliberate: the schedules used to move under you whenever something upstream reloaded.</p>`;
    $("#planCount").textContent = ""; return;
  }

  const r = PLAN_RUN.results[pr.basis] || PLAN_RUN.results.honest;
  const missed = (r.pool.outside || []).filter(x => x.reserve).length;
  $("#planCount").textContent = `${r.pool.length} enterable`;

  // Say which of the two the schedule rests on. A plan built from real fields and
  // one built from your own expectation look identical and are not remotely the
  // same claim, so the difference goes above the columns rather than in a footnote.
  // Three sources, and they are not equally good. Named in order, with counts,
  // because a plan built from real fields and one built from a single figure
  // applied to a whole category look identical on the page.
  const nSrc = [
    r.pool.measured ? `<b>${r.pool.measured}</b> from ${r.pool.measured === 1 ? "its" : "their"} real captured field` : null,
    r.pool.assumed ? `<b>${r.pool.assumed}</b> from the result you typed on that row` : null,
    r.pool.defaulted ? `<b>${r.pool.defaulted}</b> from your <span class="prov" data-tip="plandefault">Settings default for the category†</span>` : null,
  ].filter(Boolean);
  const sourcing = `Of the ${r.pool.length} candidates below: ${nSrc.length === 1 ? nSrc[0]
    : nSrc.slice(0, -1).join("; ") + "; and " + nSrc[nSrc.length - 1]}.${r.pool.defaulted
    ? ` That last group is the weakest reading there is — one figure for every event of a size, and yours run higher than the fields actually measured, so those events flatter themselves. Capturing their entry lists is what replaces the guess.` : ""}`;
  const missedNote = missed
    ? ` ${missed} more ${missed === 1 ? "has a list that puts" : "have lists that put"} you on the reserves; ${missed === 1 ? "it is" : "they are"} listed below the schedules.`
    : "";
  // The schedule is built by comparing values against each other, so a field
  // that is still filling is the one thing that can quietly bend the whole plan:
  // its value is low because the strong players have not entered yet, not
  // because the draw is soft. Marked on the row, said once here.
  // Say it out loud when a region is switched off. A schedule that quietly omits
  // half the tour looks like a schedule that considered half the tour.
  const barredNote = r.pool.barred
    ? ` <b>${r.pool.barred}</b> event${r.pool.barred === 1 ? " was" : "s were"} left out because ${r.pool.barred === 1 ? "it is" : "they are"} outside <span data-tip="planregions">where you can play</span>.`
    : "";
  const provNote = r.pool.provisional
    ? ` <b>${r.pool.provisional}</b> of the measured ${r.pool.provisional === 1 ? "field is" : "fields are"} <span class="prov" data-tip="finality">still taking entries*</span>, so ${r.pool.provisional === 1 ? "its value" : "their values"} will move — and usually downwards, since late entries tend to be the stronger players.`
    : "";

  // A reserve place cannot go in a schedule, but it is not a rejection either.
  const wstats = withdrawalStats(p.gender);
  const reserves = (r.pool.outside || []).filter(x => x.reserve).sort((a, b) =>
    (a.reserve || 99) - (b.reserve || 99) || a.d - b.d);
  const reserveHtml = !reserves.length ? "" : `
    <div class="plancol reserves">
      <h2><span data-tip="planreserve">On the reserve list</span></h2>
      <p class="hint">Not in either schedule — you cannot plan on a place you do not have. But players pull out between entries closing and the first ball, and reserves move up.</p>
      <ol class="planlist">${reserves.map(x => {
        const odds = reserveOdds(wstats, x.size, x.reserve);
        // The number leads: down a column of these you read #9, #1, #4 without
        // parsing a sentence each time.
        const lists = odds ? `${odds.lists} ${esc(x.size)} draw${odds.lists === 1 ? "" : "s"}` : "";
        const note = !odds ? `<span class="na">no ${esc(x.size)} draws captured yet</span>`
          : !odds.deepest ? `nobody came off the reserves · ${lists}`
          : `<b>#${odds.deepest}</b> deepest reserve to play · ${lists}`;
        const verdict = !odds || !odds.deepest ? ""
          : odds.reach ? `<i class="ptag reach">in reach</i>`
          : `<i class="ptag res">short by ${odds.short}</i>`;
        return `<li>
          <span class="pd">${planDate(x.d)}</span>
          <span class="pn">${esc(x.name)} <i class="ptag res">reserve #${x.reserve}</i>${verdict}</span>
          <span class="ps">${esc(x.size)} · ${esc(x.continent)}</span>
          <span class="pv small">${note}</span>
        </li>`; }).join("")}</ol>
    </div>`;

  // The one case that genuinely has no number: in the qualifying draw, and the
  // event has not published what its qualifying rounds pay. Quoting the main
  // draw would be wrong by three matches, and the category default is a
  // main-draw figure too, so neither fallback applies here.
  const unvalued = (r.pool.outside || []).filter(x => !x.reserve && x.qualUnvalued)
    .sort((a, b) => a.d - b.d);
  const unvaluedHtml = !unvalued.length ? "" : `
    <div class="plancol reserves">
      <h2><span data-tip="planunvalued">Nothing to value these by</span> — ${unvalued.length}</h2>
      <p class="hint">Left out of both schedules. The entry list puts you in the qualifying draw and this event has not published what its qualifying rounds pay, so there is no figure that means anything — not the main draw, which is three matches away, and not your category default, which is a main-draw number too.</p>
      <ol class="planlist">${unvalued.map(x => `<li>
          <span class="pd">${planDate(x.d)}</span>
          <span class="pn">${esc(x.name)} <i class="ptag res">qualifying, unpublished points</i></span>
          <span class="ps">${esc(x.size)} · ${esc(x.continent)}</span>
          <span class="pv small">no published qualifying points</span>
        </li>`).join("")}</ol>
    </div>`;

  const head = (plan, note) => { const s = plan.score; return `
    <div class="planhead">
      <div><span class="eyebrow" data-tip="average">Average</span><b>${money(s.avg)}</b></div>
      <div><span class="eyebrow" data-tip="projrank">Rank</span><b>${s.rank == null ? "—" : "#" + s.rank}</b></div>
      <div><span class="eyebrow" data-tip="playedwin">Played</span><b>${s.played}</b></div>
      <div><span class="eyebrow" data-tip="divisor">Divisor</span><b>${s.divisor}</b></div>
      <div><span class="eyebrow" data-tip="planload">Travel</span><b>${plan.chosen.length}<u>trips</u></b><span class="sub">${planLong(plan.chosen)} long haul</span></div>
    </div>${note ? `<p class="hint">${note}</p>` : ""}`; };

  const tightSet = plan => { const s = new Set(); plan.tight.forEach(([a, b]) => { s.add(a.id); s.add(b.id); }); return s; };

  // Why this one, event by event.
  //
  // A schedule that only gives a total tells you what to do and not why, and the
  // "why" here is genuinely counter-intuitive: because of the divisor, a good
  // result can be worth nothing. Past fifteen played, every extra event raises
  // the divisor, so a week that does not beat your average actively costs you.
  //
  // The honest measure of one event is therefore not its points but what the
  // schedule is worth with it minus what it is worth without it — which is what
  // this computes, by re-scoring the plan with that single event removed.
  const planWhy = (plan, x) => {
    const without = plan.chosen.filter(y => y.id !== x.id);
    const alt = planScore(p, without, to);
    const lift = plan.score.avg - alt.avg;
    const counts = (() => {
      const i = plan.chosen.indexOf(x);
      const it = plan.score.chosen && plan.score.chosen[i];
      return it ? !!it.counting : null;
    })();
    const bits = [];
    if(lift >= 0.05) bits.push(`lifts your average <b>${money(lift)}</b>`);
    else if(lift <= -0.05) bits.push(`<b>costs</b> you ${money(-lift)} of average`);
    else if(counts === false) bits.push(`falls outside your best ${plan.score.divisor}, so it neither helps nor hurts — but it is still a week`);
    else bits.push(`moves the average by less than a tenth`);
    if(x.promoted) bits.push(`a reserve place you said you would travel for`);
    if(x.qualifying) bits.push(`through qualifying, not straight into the main draw`);
    if((x.travel || 0) >= LONG_TIER) bits.push(`long haul from home`);
    return bits.join(" · ");
  };

  const list = plan => {
    const tight = tightSet(plan);
    if(!plan.chosen.length) return `<p class="hint">Nothing clears the bar in this window.</p>`;
    return `<ol class="planlist why">` + plan.chosen.map(x => `
      <li${x.locked ? ' class="lock"' : ""}>
        <span class="pd">${planDate(x.d)}</span>
        <span class="pn">${esc(x.name)}${x.locked ? ` <i class="ptag">committed</i>` : ""}${x.promoted ? ` <i class="ptag res">off the reserves</i>` : ""}${x.qualifying ? ` <i class="ptag">qualifying</i>` : ""}${tight.has(x.id) ? ` <i class="ptag tight">tight</i>` : ""}</span>
        <span class="ps">${esc(x.size)} · ${esc(x.continent)}</span>
        <span class="pv num">${money(x.value)}<u>pts</u>${x.provisional
          ? `<i class="prov" title="${esc(x.finality.label + " \u2014 " + x.finality.note.replace(/<[^>]+>/g, ""))}">*</i>`
          : ""}${x.fromDefault && !x.listed
          ? `<i class="prov" title="No entry list captured and nothing set on this row, so this is your Settings default for a ${esc(x.size)} \u2014 one figure for every event of that size, not a reading on this one.">\u2020</i>`
          : ""}</span>
        <span class="pw">${planWhy(plan, x)}</span>
      </li>`).join("") + `</ol>`;
  };

  // What the two columns disagree about is the actual advice.
  const keepIds = new Set(r.keep.chosen.map(x => x.id));
  const freeIds = new Set(r.free.chosen.map(x => x.id));
  const dropped = r.keep.chosen.filter(x => x.locked && !freeIds.has(x.id));
  const gained = r.free.chosen.filter(x => !keepIds.has(x.id));
  const gap = r.free.score.avg - r.keep.score.avg;
  // A commitment that never reaches the counting set is neither a cost nor a
  // gain, which is worth saying out loud: it is the usual reason the two columns
  // differ in events but agree on the number.
  const idle = r.keep.score.chosen.filter((it, i) => r.keep.chosen[i].locked && !it.counting).length;
  const verdict = Math.abs(gap) < 0.05
    ? `Your commitments cost you nothing.${idle ? ` ${idle === 1 ? "One of them falls" : idle + " of them fall"} outside your best ${r.keep.score.divisor}, so ${idle === 1 ? "it neither helps nor hurts" : "they neither help nor hurt"} the average — but ${idle === 1 ? "it is" : "they are"} still ${idle === 1 ? "a week" : "weeks"} spent.` : ""}`
    : `Your commitments cost <b>${money(gap)}</b> of average${dropped.length
        ? `. The Advisor plan skips ${dropped.map(x => esc(x.name)).join(", ")}` : ""}${gained.length
        ? ` and plays ${gained.length} other event${gained.length === 1 ? "" : "s"} instead` : ""}.`;

  // Which of the two to put first. The Advisor plan is chosen from a larger set,
  // so it can never come out worse — which means the only question that matters
  // is whether it is actually *better*. If it is level, keeping your word wins,
  // and the badge says so rather than pretending the free hand found something.
  const freeWins = planBetter({ avg: r.free.score.avg, load: r.free.load },
                              { avg: r.keep.score.avg, load: r.keep.load }, pr.travel);
  // Say which way each number moved in words. A signed number here is genuinely
  // ambiguous — "+7 travel" could mean seven better or seven further.
  const d = (v, more, less) => {
    const n = Math.round(v * 10) / 10;
    return n === 0 ? null : n > 0 ? `${n} ${more}` : `${-n} ${less}`;
  };
  const why = (() => {
    const bits = [
      d(r.free.score.avg - r.keep.score.avg, "more average", "less average"),
      d(r.free.chosen.length - r.keep.chosen.length, "more trips", "fewer trips"),
      d(planLong(r.free.chosen) - planLong(r.keep.chosen), "more long hauls", "fewer long hauls"),
      d(r.free.tight.length - r.keep.tight.length, "more tight turnarounds", "fewer tight turnarounds"),
    ].filter(Boolean);
    const cost = dropped.length
      ? `it drops ${dropped.length} event${dropped.length === 1 ? "" : "s"} you have already committed to`
      : "it breaks nothing you have committed to";
    return freeWins
      ? `Against keeping your commitments: ${bits.length ? bits.join(", ") : "no measurable difference"}. The cost is that ${cost}.`
      : `The Advisor plan finds nothing better${bits.length ? ` (${bits.join(", ")})` : ""}, so there is no reason to break a commitment. Play what you said you would.`;
  })();
  const badge = (n, text) => `<i class="prank${n === 1 ? " one" : ""}" data-tip="planrank" data-tiptitle="Ranked #${n}" data-tiptext="${esc(text)}">#${n}</i>`;

  // Show the evidence behind the ceiling rather than only its conclusion — with
  // a handful of lists it is a weak signal, and it should look weak.
  const reach = planReach(p);
  const cutRows = SIZES.map(s => ({ s, c: reach.cuts[s] })).filter(x => x.c);
  const cutsHtml = cutRows.length ? `
    <details class="cuts">
      <summary>What ranking gets in — ${cutRows.length} categor${cutRows.length === 1 ? "y" : "ies"} with evidence${reach.rank != null ? `, you at #${reach.rank}` : ""}</summary>
      <table class="mini"><thead><tr><th>Category</th><th class="r">Cut</th><th class="r">Range</th><th class="r">Lists</th><th>You</th></tr></thead><tbody>
        ${cutRows.map(({ s, c }) => `<tr>
          <td>${esc(s)}</td><td class="r num">#${c.cut}</td>
          <td class="r num">${c.low === c.high ? "—" : `#${c.low}–#${c.high}`}</td>
          <td class="r num">${c.lists}</td>
          <td>${reach.rank == null ? `<span class="na">—</span>`
              : reach.rank <= c.cut ? `<b>in</b>` : `<span class="na">short by ${reach.rank - c.cut}</span>`}</td>
        </tr>`).join("")}
      </tbody></table>
      <p class="hint">The worst-ranked <b>direct entry</b> in each captured main draw, taken as the median across the lists for that category. Wildcards, qualifiers and lucky losers are left out — none of them got in on their ranking. A reserve promoted before the draw is indistinguishable from a direct entry once the list is captured, so read this as "that was good enough that week", not a hard line.</p>
    </details>` : "";

  // The readings, side by side. Each carries the average its own model lands on,
  // so picking one and comparing them are the same act — and a wide spread is
  // itself the answer: it says the schedule is not robust to how you measure.
  const spread = (() => {
    const vals = READING_KEYS.map(k => PLAN_RUN.results[k] && PLAN_RUN.results[k].free.score.avg)
      .filter(v => v != null);
    if(vals.length < 2) return "";
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    return hi - lo < 0.5
      ? (hi - lo < 0.05
          ? `The readings agree, so the plan below does not depend on how you measure the field.`
          : `The readings agree to within ${money(hi - lo)} of average, so the plan below does not depend on how you measure the field.`)
      : `The readings disagree by <b>${money(hi - lo)}</b> of average. Where they disagree, the disagreement is the finding — the schedule is only as solid as the reading you trust.`;
  })();
  const readingsHtml = `
    <p class="eyebrow readlead"><span data-tip="planbasis">Which reading to plan on</span></p>
    <div class="readings" id="planBasis2">
      ${READINGS.map(rd => {
        if(rd.soon) return `<button type="button" class="rd off" disabled title="${esc(rd.tip)}">
          <span class="rl">${esc(rd.label)}</span><b>n/a</b></button>`;
        const res = PLAN_RUN.results[rd.k];
        const v = res ? res.free.score.avg : null;
        return `<button type="button" class="rd${rd.k === pr.basis ? " on" : ""}" data-b="${rd.k}" title="${esc(rd.tip)}">
          <span class="rl">${esc(rd.label)}</span><b>${money(v)}</b></button>`;
      }).join("")}
    </div>
    ${spread ? `<p class="hint readnote">${spread}</p>` : ""}`;

  out.innerHTML = `
    ${cutsHtml}
    ${readingsHtml}
    <p class="planintro">On ${planBasisName(pr.basis)}, where you would stand on <b>${fmtD(to)}</b>.
      Today's commitments alone would leave you at <b>${money(r.now.avg)}</b>${r.now.rank ? ` (#${r.now.rank})` : ""} on that date, because results expire as the window rolls.
      ${sourcing}${missedNote}${barredNote}${provNote}</p>
    <p class="planverdict">${verdict}</p>
    <div class="plan2">
      <div class="plancol${freeWins ? "" : " win"}">
        <h2>Keeping your commitments ${badge(freeWins ? 2 : 1, why)}</h2>
        ${head(r.keep, r.keep.tight.length ? `<span data-tip="gaptag">${r.keep.tight.length} tight turnaround${r.keep.tight.length === 1 ? "" : "s"}</span> — playable, but a flight and no rest.` : "")}
        ${list(r.keep)}
      </div>
      <div class="plancol${freeWins ? " win" : ""}">
        <h2>Advisor plan ${badge(freeWins ? 1 : 2, why)}</h2>
        ${head(r.free, r.free.tight.length ? `<span data-tip="gaptag">${r.free.tight.length} tight turnaround${r.free.tight.length === 1 ? "" : "s"}</span>.` : "")}
        ${list(r.free)}
      </div>
    </div>
    ${reserveHtml}
    ${unvaluedHtml}`;
  const strip = $("#planBasis2");
  if(strip) strip.addEventListener("click", e => {
    const b = e.target.closest("button[data-b]"); if(!b) return;
    const q = P(); planPrefs(q).basis = b.dataset.b; savePlayer(q); renderPlan();
  });
  bindTips();
}

/* ---------- Help ---------- */
// Two different jobs, which is why they are not one page.
//
// Setting up is a blocking, one-time task: you cannot use the tool at all until
// it is done, you do it once, and what you need is numbered steps and a way to
// tell whether each one worked. So the setup half is a checklist that reads your
// actual state and tells you where you are in it.
//
// Reading the tool is the opposite: nothing blocks, and you come back to it
// months later wondering what one number meant. So that half is reference, and
// it lives here permanently rather than in a dialog you dismiss once.
function helpSetupState(p){
  const sb = supa();
  const meta = (captured.meta && (captured.meta.men || captured.meta.women)) || null;
  return [
    { k: "account", done: !!sb,
      title: "Sign in",
      body: "You are signed in with Google. Everything you enter is stored against your account, not this browser, so it follows you to another machine." },
    { k: "player", done: !!(p && p.name),
      title: "Set up your player",
      body: `Settings &rarr; Player: your name as PSA spells it, your tour, and <b>where you live</b> — which decides travel difficulty, not your nationality. ${p && p.name ? `Currently <b>${esc(p.name)}</b>.` : "Not done yet."}` },
    { k: "token", done: !!ingestTokenValue,
      title: "Copy your ingest token",
      body: "Settings &rarr; Rankings &amp; entry lists. It is a long string that lets the browser extension post data to your account. It is personal — treat it like a password." },
    { k: "ext", done: SYNC.seen,
      title: "Install the Tour Advisor Sync extension",
      body: `<code>chrome://extensions</code> &rarr; Developer mode &rarr; Load unpacked, pointing at the extension folder. Paste the token into it and press Save. ${SYNC.seen ? `The extension is talking to this page${SYNC.version ? ` (version ${esc(SYNC.version)})` : ""}.` : "This page cannot see the extension yet."}` },
    { k: "sync", done: !!meta,
      title: "Press Refresh",
      body: `The extension reads the calendar, the world rankings and every upcoming entry list from SecurePSA — in your browser, on the session you are already signed in to. It never sees your PSA password. ${meta ? `Last capture: ${meta.players} players, list of ${meta.ranked_on}.` : "Nothing captured yet."}` },
    { k: "played", done: !!(p && (p.played || []).length),
      title: "Enter what you have already played",
      body: `The Played tab. Until this is in, the tool has no idea where you stand. ${p && (p.played || []).length ? `${p.played.length} results entered.` : "Nothing entered yet."}` },
  ];
}

function renderHelp(){
  const out = $("#helpOut"); if(!out) return;
  const p = P();
  const steps = helpSetupState(p);
  const doneN = steps.filter(s => s.done).length;

  out.innerHTML = `
    <p class="intro">Two things: getting set up, which you do once, and what the numbers mean, which you can come back to.</p>

    <div class="grid2">
      <div class="card">
        <h2>Setting up <span class="hstep">${doneN} of ${steps.length} done</span></h2>
        <ol class="helpsteps">
          ${steps.map(s => `<li class="${s.done ? "ok" : ""}">
            <i>${s.done ? "✓" : ""}</i>
            <div><b>${esc(s.title)}</b><p>${s.body}</p></div></li>`).join("")}
        </ol>
      </div>

      <div class="card">
        <h2>What the numbers mean</h2>
        <dl class="helpdl">
          <dt>AdvisorScore</dt>
          <dd>What one tournament is worth to you in the long run, in ranking points. It is not what you would win if things went well — it is the average over every way the draw could go, given who actually entered. A number lower than the category's first-round points is normal and correct: most weeks you do not win.</dd>

          <dt>Raw average vs official average</dt>
          <dd>Two ways of measuring the players in a draw. <b>Raw</b> is total points divided by tournaments played, nothing dropped. <b>Official</b> is the average PSA publishes, which keeps only your best eleven — or best played−4 once you pass fifteen. Under eleven played the official one is harsher, because the gap is filled with zeros; above eleven it is kinder. Neither is wrong; they answer different questions, which is why both are shown.</dd>

          <dt>My evaluation</dt>
          <dd>Ignores who entered and values every tournament at the round you expect to reach at that category, set in Settings. Useful before any entry lists are captured, and as a sanity check against the other two.</dd>

          <dt>The divisor, and why more is not better</dt>
          <dd>Your ranking average is your counting points divided by a divisor: eleven until you have played fifteen events, then played minus four. So at sixteen played, a sixteenth event only helps if it is worth at least your current average — otherwise it raises the divisor and pulls you down. This is the single most counter-intuitive thing about the PSA ranking, and it is why the Plan tab optimises the average rather than points.</dd>

          <dt><b>Q</b> beside a score</dt>
          <dd>You are in the qualifying draw, not the main draw. The number already accounts for it: it is what the qualifying rounds pay, plus the main draw discounted by how often you come through. Hover it for how many matches that is.</dd>

          <dt>Play it? \u2014 the recommendation</dt>
          <dd>Three answers, at the top of a tournament's detail. <b>Yes</b> means playing it clearly lifts your average; <b>No</b> means it would pull you down; <b>Depends</b> is a real answer, not a hedge. The measure is not the points on offer \u2014 it is how far your average moves with the event in your season versus without it, which past fifteen played is a very different number. Hover it for the working, including which matches it turns on.</dd>

          <dt>Entries still open</dt>
          <dd>An entry list is only the field once entries have closed. Before that it fills from the top, because the stronger players enter late while they weigh their options \u2014 so a thin list months out is an <b>unfinished</b> field, not a weak one. Where it matters the tool says so: the tournament line states when entries close, the Score column marks a provisional number with an asterisk, and <i>Play it?</i> will not say Yes about a field that can still change.</dd>

          <dt>Reserve places</dt>
          <dd>The entry list has you outside the main draw. Nothing is planned around one unless you tick it on the Plan tab, and a ticked one counts as a <b>whole</b> tournament — either you play or you don't. Beside each is the deepest reserve who actually got in at that level, counted from withdrawals in the draws captured so far.</dd>

          <dt>The two schedules</dt>
          <dd><b>Keeping your commitments</b> is the best plan that still plays everything you have marked Yes. <b>Advisor plan</b> is the best plan if you were free. The Advisor plan can never be worse — it chooses from more — so the only question is whether it is actually better, and by how much. That difference is what your commitments cost.</dd>

          <dt>Travel</dt>
          <dd>Counted as trips and long hauls, not money. Switch on <i>Weigh travel</i> and it becomes a tiebreak only: two schedules within half a percent of each other are settled by the one that keeps you closer to home. It never trades real average for comfort.</dd>

          <dt>Freshness</dt>
          <dd>The strip under the numbers says how old the calendar, the rankings and the entry lists are. They go stale at different speeds — entry lists in days, rankings weekly, the calendar over a fortnight — so they have separate figures. An old entry list can put you in a draw you are no longer in.</dd>
        </dl>
      </div>
    </div>`;
}

/* ---------- the Refresh button ---------- */
// The extension does the capturing, in this browser, on this user's own
// SecurePSA session. The site cannot call it directly — a page has no access to
// chrome.runtime — so the extension puts a content script on this origin and the
// two talk through window.postMessage. The button only appears once that script
// has said hello, because offering a Refresh that silently does nothing is worse
// than not offering one.
const SYNC = { seen: false, version: null, state: "", at: 0 };
const SITE_TAG = "tour-advisor", EXT_TAG = "tour-advisor-sync";

function bindSyncBridge(){
  window.addEventListener("message", e => {
    if(e.source !== window) return;
    const d = e.data;
    if(!d || d.source !== EXT_TAG) return;
    if(d.type === "hello"){ SYNC.seen = true; SYNC.version = d.version || null; renderFreshness(); }
    if(d.type === "started"){ SYNC.state = "started"; SYNC.at = Date.now(); renderFreshness(); }
    if(d.type === "error"){ SYNC.state = "error"; SYNC.msg = d.message || ""; renderFreshness(); }
  });
  // The content script says hello on its own, but the page may have loaded
  // first; ask once in case we missed it.
  // targetOrigin "*" rather than location.origin: these messages go to this same
  // window and nowhere else, the listener at each end verifies event.source ===
  // window, and the payload is "are you there" / "please sync" — nothing worth
  // protecting. Pinning the origin also breaks the file:// preview build, where
  // location.origin is the string "null".
  window.postMessage({ source: SITE_TAG, type: "ping" }, "*");
}

let syncClear = null;
function askSync(){
  SYNC.state = "asking"; renderFreshness();
  // The sync itself reports into its own tab, so this note has nothing to wait
  // for. Clear it rather than leaving a stale "running" next to the button.
  clearTimeout(syncClear);
  syncClear = setTimeout(() => { SYNC.state = ""; renderFreshness(); }, 15000);
  window.postMessage({ source: SITE_TAG, type: "sync" }, "*");
}

/* ---------- how old is what you are looking at ---------- */
// The whole refresh model rests on this being visible. Entry lists are captured
// by whoever happens to run the extension, and the data is shared — so if you can
// see that somebody refreshed half an hour ago you will not refresh again, and if
// the last one was three weeks back you will. Hide the age and either everybody
// re-scrapes the same pages or nobody does.
//
// Rankings move once a week. Entry lists move daily as players enter and pull
// out. They go stale at completely different rates, so they get separate figures
// and separate thresholds rather than one number for "the data".
// The calendar moves slowest of the three — tournaments are added and cancelled
// over weeks, not days — so a fortnight is the point at which it is worth saying.
const STALE = { rankings: 8 * 24, lists: 72, calendar: 14 * 24 };   // hours

function ageOf(when){
  if(!when) return null;
  const ms = Date.now() - new Date(when).getTime();
  return Number.isFinite(ms) ? ms / 3600000 : null;   // hours
}
function ageWords(h){
  if(h == null) return "never";
  if(h < 1) return Math.max(1, Math.round(h * 60)) + " min ago";
  if(h < 36) return Math.round(h) + (Math.round(h) === 1 ? " hour ago" : " hours ago");
  const d = Math.round(h / 24);
  return d + (d === 1 ? " day ago" : " days ago");
}

// Entry lists are per tournament, so "how fresh" is really two questions: when
// did anyone last capture anything, and how old is the oldest list still being
// used. The second is the one that quietly makes a Score wrong.
function freshness(p){
  const meta = (captured.meta && captured.meta[p.gender === "W" ? "women" : "men"]) || null;
  const ranks = { age: ageOf(meta && meta.captured_at), on: meta && meta.ranked_on,
                  players: meta && meta.players, source: rankingsSource(p.gender) };
  ranks.stale = ranks.age == null || ranks.age > STALE.rankings;

  const want = p.gender === "W" ? "women" : "men";
  const mine = (fields.lists || []).filter(L => (L.division_name || "").toLowerCase().indexOf(want) === 0);
  const ages = mine.map(L => ageOf(L.captured_at)).filter(a => a != null);
  const lists = { n: mine.length,
                  newest: ages.length ? Math.min.apply(null, ages) : null,
                  oldest: ages.length ? Math.max.apply(null, ages) : null };
  lists.stale = !ages.length || lists.newest > STALE.lists;

  const sm = captured.schedMeta;
  const cal = { source: scheduleSource(), age: ageOf(sm && sm.captured_at),
                draws: (captured.schedule || []).length, upcoming: sm && sm.upcoming };
  cal.stale = cal.age == null || cal.age > STALE.calendar;
  return { ranks, lists, cal };
}

function renderFreshness(){
  const el = $("#freshbar"); if(!el) return;
  const p = P(); if(!p){ el.hidden = true; return; }
  const f = freshness(p);
  if(f.ranks.source !== "captured" && f.cal.source !== "captured" && !f.lists.n && !SYNC.seen){ el.hidden = true; return; }

  const bit = (label, text, stale, tip) =>
    `<span class="fb${stale ? " stale" : ""}"${tip ? ` title="${esc(tip)}"` : ""}><i></i>${label} <b>${text}</b></span>`;

  const parts = [];
  // The calendar comes first because it decides what the other two are about:
  // a tournament missing from it cannot be scored however fresh its entry list.
  if(f.cal.source === "captured")
    parts.push(bit("Calendar", ageWords(f.cal.age), f.cal.stale,
      `${f.cal.draws} World Tour draws, ${f.cal.upcoming || 0} of them still to come. `
      + "Read straight from the PSA calendar, so cancellations and new events arrive with it."
      + (f.cal.stale ? " Two weeks is long enough for the calendar to have moved." : "")));
  else if(f.cal.source === "bundled")
    parts.push(bit("Calendar", "built in", true,
      "The snapshot that shipped with the page. It knows nothing about tournaments added, moved or cancelled since. Press Refresh to read the live calendar."));
  if(f.ranks.source === "captured")
    parts.push(bit("Rankings", ageWords(f.ranks.age), f.ranks.stale,
      `${f.ranks.players || "?"} players, the list PSA published on ${f.ranks.on || "an earlier week"}.`
      + (f.ranks.stale ? " PSA publishes a new list every Monday, so this one has been overtaken." : "")));
  if(f.lists.n)
    parts.push(bit("Entry lists", `${f.lists.n} · newest ${ageWords(f.lists.newest)}`, f.lists.stale,
      `Oldest of them was captured ${ageWords(f.lists.oldest)}. Entries and withdrawals move daily, so an old list can put you in a draw you are no longer in — or leave you out of one you are.`));

  // The button stays; only the note beside it changes. Replacing the button with
  // a status would strand anyone who clicked, glanced at the sync tab and came
  // back — there would be nothing left to press.
  const note = SYNC.state === "error" ? `<span class="fbrun warn">${esc(SYNC.msg || "the extension did not answer")}</span>`
    : SYNC.state === "asking" ? `<span class="fbrun">asking the extension…</span>`
    : SYNC.state === "started" ? `<span class="fbrun">running in the sync tab</span>`
    : "";
  const btn = SYNC.seen ? `<button class="btn small" id="freshRun">Refresh now</button>${note}` : "";

  el.innerHTML = parts.join("") + btn
    + `<span class="fbnote">shared — whoever refreshes, everyone gets it</span>`;
  el.hidden = false;
  const run = $("#freshRun");
  if(run) run.addEventListener("click", askSync);
}

/* ---------- date clashes between events you intend to play ---------- */
// Overlapping dates are impossible; a one-day turnaround is possible but means
// a flight and no rest, so it is worth saying out loud rather than hiding.
// How many days between two events still counts as too tight.
//
// It used to be three, flat, which treats Paris-to-Lyon and Cairo-to-Auckland as
// the same turnaround. They are not: one is a train, the other is a day in the
// air, a night lost and several time zones. So the gap widens with the hop.
//
// This is a rule of thumb about recovery, not a distance model, and it is worth
// being plain about that — there is no region-to-region distance table here, only
// the continent of each event and the travel tiers the player filled in from
// home. Two events on the same continent are a short hop whoever you are. Two on
// different continents are a flight. If either of them is already long haul from
// home, the trip between them is likely to be worse still.
const CLASH_GAP = 3;          // the old flat value, still the fallback
const CLASH_NEAR = 2;         // same continent
const CLASH_FAR = 4;          // different continents
const CLASH_LONG = 5;         // different continents, at least one of them long haul

function clashGap(x, y, p){
  const cx = x.continent, cy = y.continent;
  if(!cx || !cy || cx === "TBA" || cy === "TBA") return CLASH_GAP;
  if(cx === cy) return CLASH_NEAR;
  const far = Math.max(tierFor(p, cx) || 0, tierFor(p, cy) || 0);
  return far >= LONG_TIER ? CLASH_LONG : CLASH_FAR;
}

function clashPairs(p){
  const evs = pool(p).filter(r => r.enter === "Yes" || r.enter === "Planned")
    .map(r => ({ id: r.id, name: r.name, a: r.d, b: dnum(r.end || r.start), continent: r.continent }))
    .filter(r => r.a != null && r.b != null)
    .sort((x, y) => x.a - y.a);
  const out = [];
  for(let i = 0; i < evs.length; i++){
    for(let j = i + 1; j < evs.length; j++){
      const x = evs[i], y = evs[j];
      // The break has to use the widest gap any pair could need, or a long-haul
      // clash further down the list would never be reached.
      if(y.a > x.b + CLASH_LONG) break;
      const need = clashGap(x, y, p);
      if(y.a > x.b + need) continue;
      out.push({ x, y, kind: y.a <= x.b ? "hard" : "soft", gap: y.a - x.b - 1, need });
    }
  }
  return out;
}
function renderClashes(p){
  const bar = $("#clashBar"); if(!bar) return {};
  const pairs = clashPairs(p);
  const marks = {};
  const gapLabel = g => g === 0 ? "back to back" : `gap: ${g} day${g === 1 ? "" : "s"}`;
  pairs.forEach(({ x, y, kind, gap }) => {
    const label = kind === "hard" ? "clash" : gapLabel(gap);
    [x.id, y.id].forEach(id => {
      const cur = marks[id];
      if(!cur || (cur.kind !== "hard" && (kind === "hard" || gap < cur.gap))) marks[id] = { kind, gap, label };
    });
  });
  bar.hidden = !pairs.length;
  // A busy schedule can throw up a dozen of these; the rows themselves are
  // marked, so the bar only needs to show enough to make the point.
  const SHOW = 6;
  const listed = pairs.slice().sort((a, b) => (a.kind === b.kind ? a.gap - b.gap : a.kind === "hard" ? -1 : 1)).slice(0, SHOW);
  bar.innerHTML = listed.map(({ x, y, kind, gap }) => {
    const what = kind === "hard"
      ? `${esc(x.name)} and ${esc(y.name)} overlap.`
      : gap === 0
        ? `${esc(y.name)} starts the day after ${esc(x.name)} ends.`
        : `Only ${gap} day${gap === 1 ? "" : "s"} between ${esc(x.name)} and ${esc(y.name)}.`;
    return `<div class="row"><span class="tag ${kind}">${kind === "hard" ? "clash" : gapLabel(gap)}</span>`
      + `<span>${what} ${fmtD(x.a)} → ${fmtD(x.b)} · ${fmtD(y.a)} → ${fmtD(y.b)}</span></div>`;
  }).join("")
  + (pairs.length > SHOW ? `<div class="row"><span></span><span class="more">and ${pairs.length - SHOW} more — marked on the rows below.</span></div>` : "");
  return marks;
}
/* ---------- pinned summary bar ---------- */
// Editing a row changes the numbers; without this you have to scroll back up to
// see what changed. Only on the two tabs where rows are edited.
function fillPinbar(p, s, c, delta){
  const nums = $("#pinNums"); if(!nums) return;
  // Colour rides on the value here — there is no tile to tint in a single line —
  // while the movement itself stays grey so the two never fight.
  const tiles = Array.from(document.querySelectorAll("#strip .tile")).slice(0, 5);
  const labels = ["counting", "played", "divisor", "avg", "rank"];
  nums.innerHTML = tiles.map((t, i) => {
    const d = t.querySelector(".delta");
    const dir = d && d.classList.contains("up") ? "up" : d && d.classList.contains("down") ? "down" : "";
    const moved = d && d.textContent.trim() && d.textContent.trim() !== "no change" ? d.textContent.trim() : "";
    return `<span class="m"><b class="${dir}">${esc(t.querySelector(".v").textContent)}</b>${labels[i]}`
      + `<span class="dl">${moved ? esc(moved) : ""}</span></span>`;
  }).join("")
  + `<span class="who">${esc(p.name)} · ${state.tab === "planner" ? "Planner" : "Played"}${c.date ? " · vs your ranking of " + fmtD(dnum(c.date)) : ""}</span>`;
  const tabs = $("#pinTabs");
  if(tabs && !tabs.childElementCount){
    tabs.innerHTML = Array.from(document.querySelectorAll("#tabs .tab"))
      .map(t => `<button type="button" data-tab="${esc(t.dataset.tab)}">${esc(t.textContent)}</button>`).join("");
    tabs.addEventListener("click", e => { const b = e.target.closest("button"); if(!b) return;
      const real = document.querySelector(`#tabs .tab[data-tab="${b.dataset.tab}"]`); if(real) real.click(); });
  }
  if(tabs) tabs.querySelectorAll("button").forEach(b => b.classList.toggle("sel", b.dataset.tab === state.tab));
}
const PIN_TABS = ["planner", "played"];
function pinVisibility(){
  const bar = $("#pinbar"), strip = $("#strip");
  if(!bar || !strip) return;
  // Hand over the moment the numbers stop being readable, not the moment they
  // clear the viewport. The app bar is sticky, so the last stretch of the strip
  // slides underneath it and is invisible while still technically on screen —
  // which left a scroll position with no numbers anywhere, cards gone and bar
  // not yet up.
  const app = document.querySelector(".bar");
  const cover = app ? app.getBoundingClientRect().height : 0;
  const past = strip.getBoundingClientRect().bottom <= cover + 2;
  bar.hidden = !(past && PIN_TABS.includes(state.tab));
}
function watchPin(){
  window.addEventListener("scroll", pinVisibility, { passive: true });
  window.addEventListener("resize", pinVisibility);
  pinVisibility();
}

/* ---------- the tab blurbs, behind a ? ---------- */
function setupIntros(){
  document.querySelectorAll("p.intro").forEach(p => {
    if(p.previousElementSibling && p.previousElementSibling.classList.contains("introbtn")) return;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "introbtn"; btn.textContent = "?";
    btn.setAttribute("aria-expanded", "false");
    btn.title = "What this tab does";
    p.hidden = true;
    p.parentNode.insertBefore(btn, p);
    btn.addEventListener("click", () => {
      p.hidden = !p.hidden;
      btn.setAttribute("aria-expanded", String(!p.hidden));
    });
  });
}

// A <details> holding checkboxes: a filter you can tick several of, without a
// library and without hand-positioning a popup.
function fillMulti(sel, values, chosen, label){
  const el = $(sel); if(!el) return;
  const menu = el.querySelector(".menu");
  if(!menu.childElementCount){
    menu.innerHTML = values.map(v => `<label><input type="checkbox" value="${esc(v)}"> ${esc(v)}</label>`).join("")
      + `<button type="button" class="clear">Clear</button>`;
  }
  menu.querySelectorAll("input").forEach(i => { i.checked = chosen.includes(i.value); });
  el.querySelector("summary b").textContent =
    !chosen.length ? "All" : chosen.length === 1 ? chosen[0] : `${chosen[0]} +${chosen.length - 1}`;
  el.querySelector("summary .lbl").hidden = chosen.length > 0;
}

function selOpts(list, cur, blank){ return (blank ? `<option value="">${blank}</option>` : "") + list.map(v => `<option${v === cur ? " selected" : ""}>${esc(v)}</option>`).join(""); }
// Sorting the Planner. Date is the default and stays the tiebreak for every
// other key, because two events worth the same are still separated by when they
// are — and a list that jumps around between renders is worse than an unsorted one.
const PLANNER_SORTS = {
  date:  r => r.d,
  name:  r => r.name.toLowerCase(),
  size:  r => SIZES.indexOf(r.size),
  points: r => r.pts,
  // Score needs the model, so it is computed once per row here rather than
  // pulled out of the rendered cell. No entry list means no score — null, not
  // zero, so those rows fall to the bottom whichever way you sort rather than
  // crowding the top of an ascending list as if they were the worst events.
  field: (r, p) => { const a = analyse(r, p, PLANNER_RUNS); return a && a.sim ? a.sim.expected : null; },
};
function sortPlanner(rows, p){
  const s = state.sort || { key: "date", dir: 1 };
  const get = PLANNER_SORTS[s.key] || PLANNER_SORTS.date;
  const keyed = rows.map((r, i) => ({ r, i, v: get(r, p) }));
  keyed.sort((a, b) => {
    const av = a.v, bv = b.v;
    if(av == null && bv == null) return a.i - b.i;
    if(av == null) return 1;                       // nothing sorts to the bottom either way
    if(bv == null) return -1;
    if(av < bv) return -s.dir;
    if(av > bv) return s.dir;
    return (a.r.d - b.r.d) || (a.i - b.i);
  });
  return keyed.map(x => x.r);
}
function renderSortHeads(){
  const s = state.sort || { key: "date", dir: 1 };
  document.querySelectorAll("#plannerTbl th[data-sort]").forEach(th => {
    const on = th.dataset.sort === s.key;
    th.classList.toggle("sorted", on);
    th.setAttribute("aria-sort", on ? (s.dir === 1 ? "ascending" : "descending") : "none");
    const mark = th.querySelector(".sortmark");
    if(mark) mark.textContent = on ? (s.dir === 1 ? "\u2191" : "\u2193") : "";
  });
}
function setSort(key){
  const s = state.sort || { key: "date", dir: 1 };
  // Second click reverses; a new column starts in the direction that answers the
  // question you asked by clicking it — biggest first for a number, earliest
  // first for a date or a name.
  state.sort = s.key === key ? { key, dir: -s.dir }
    : { key, dir: (key === "points" || key === "field" || key === "size") ? -1 : 1 };
  renderPlanner();
}

function renderPlanner(){ const p = P(), f = state.filters, today = todayN(), fl = floorInfo(p, plannerScenario(p));
  renderBasisSeg(); applyCols(p);
  fillMulti("#fCont", REGIONS.concat("TBA"), f.cont, "Continent");
  fillMulti("#fSize", SIZES, f.size, "Size");
  let rows = pool(p); const q = f.q.trim().toLowerCase();
  rows = rows.filter(r => (f.past || r.d >= today || r.use || r.enter !== "No") && (f.restricted || !r.restricted || r.enter !== "No" || r.use) && (!f.cont.length || f.cont.includes(r.continent)) && (!f.size.length || f.size.includes(r.size)) && (!f.enter || r.enter === f.enter) && (!q || (r.name + " " + r.location).toLowerCase().includes(q)) && (!(f.floor && fl.active) || r.use || r.enter !== "No" || DATA.points[r.size][0] >= fl.avg));
  if(f.from){ const a = dnum(f.from); if(a != null) rows = rows.filter(r => r.d >= a); }
  if(f.to){ const b = dnum(f.to); if(b != null) rows = rows.filter(r => r.d <= b); }
  rows = sortPlanner(rows, p);
  const clashMarks = renderClashes(p);
  renderSortHeads();
  const dc = $("#fDatesClear"); if(dc) dc.hidden = !(f.from || f.to);
  $("#pCount").textContent = `${rows.length} tournaments`;
  const tb = $("#plannerTbl tbody"); tb.innerHTML = rows.map(r => { const below = fl.active && DATA.points[r.size][0] < fl.avg; const ent = r.d < today ? ` <small>${r.status === "custom" ? "added manually" : r.status}</small>` : (r.status && r.status !== "Upcoming" && r.status !== "custom" ? ` <small>${esc(r.status)}${r.restricted ? ` · <span class="restr"${r.restriction ? ` title="${esc(r.restriction)}"` : ""}>restricted draw</span>` : ""}</small>` : (r.restricted ? ` <small><span class="restr"${r.restriction ? ` title="${esc(r.restriction)}"` : ""}>restricted draw</span></small>` : ""));
    return `<tr data-id="${esc(r.id)}" class="${r.use ? "used" : ""}${below ? " below" : ""}${r.enter === "No" ? " noenter" : ""}${clashMarks[r.id] ? " clash-" + clashMarks[r.id].kind : ""}">
      <td><input type="checkbox" data-k="use" ${r.use ? "checked" : ""} aria-label="Use ${esc(r.name)}"></td>
      <td class="num" style="white-space:nowrap">${fmtD(r.d)}</td>
      <td class="tname">${esc(r.name)}${clashMarks[r.id] ? `<span class="rowtag ${clashMarks[r.id].kind}">${esc(clashMarks[r.id].label)}</span>` : ""}${ent}</td>
      <td data-col="continent"><span class="tier tier-${r.tier}" title="Travel difficulty ${r.tier || "n/a"} of 5">${esc(r.continent)}</span></td>
      <td class="loc" data-col="location">${esc(r.location)}</td>
      <td data-col="size">${r.fromSchedule ? esc(r.size) : `<select data-k="size">${selOpts(SIZES, r.size)}</select>`}</td>
      <td data-col="enter"><select data-k="enter">${selOpts(["Yes","No","Planned"], r.enter)}</select></td>
      <td class="r num" data-col="points"><b>${fmtN(r.pts)}</b></td>
      <td class="r fieldcell" data-col="field">${fieldCell(r, p)}</td>
      <td data-col="result"><select data-k="exact">${selOpts(ROUNDS, r.exact, "—")}</select></td>
      <td data-col="result"><select data-k="rfrom">${selOpts(ROUNDS, r.rfrom, "—")}</select></td>
      <td data-col="result"><select data-k="rto">${selOpts(ROUNDS, r.rto, "—")}</select></td>
      <td data-col="notes"><input type="text" class="notes-in" data-k="notes" value="${esc(r.notes)}" placeholder="…"></td>
      <td>${r.fromSchedule ? "" : `<button class="del" data-del="1" title="Remove">×</button>`}</td></tr>`; }).join("");
  $("#plannerLegend").innerHTML = `<span>Travel difficulty from <b>${esc(p.home)}</b>:</span>` + [1,2,3,4,5].map(t => `<span><i class="sw tier-${t}" style="background:var(--t${t})"></i>${["","1 — easiest","2 — near","3 — medium","4 — far","5 — hardest"][t]}</span>`).join("") + `<span><i class="sw" style="background:var(--surface-2)"></i>TBA</span><span style="margin-left:auto">Points precedence: exact result › range average › expected round from Settings.</span>`; }

// Satellite and federation results do not reach your ranking by themselves. PSA
// requires a points claim, one per division, from the first day of the event
// until seven days after it ends — and the claim is blocked while any invoice is
// unpaid. World and Challenger points are automatic, so this only ever appears
// on a Satellite.
//
// A deadline that passes in silence and costs a whole tournament, so it is on the
// row rather than in the help tab.
const CLAIM_DAYS = 7;
function claimTag(r, today){
  if(r.size !== "Satellite" || r.d == null) return "";
  const left = r.d + CLAIM_DAYS - today;      // generous: counted from the start date
  if(left < 0 || r.d > today) return "";
  return ` <span class="rowtag claim" title="Satellite points are not awarded automatically. Submit a ranking points claim from the tournament's division on SecurePSA — one claim per division, and it closes seven days after the event ends. Unpaid invoices block it.">claim points \u00b7 ${left === 0 ? "last day" : left + " day" + (left === 1 ? "" : "s") + " left"}</span>`;
}

function renderPlayed(){ const p = P(), s = playedScenario(p), today = todayN();
  const kv = (pairs) => pairs.map(([k,v]) => `<b class="num">${v}</b><span>${k}</span>`).join("");
  const dead = s.rows.filter(r => r.incl && !r.counting).length;
  $("#playedCount").textContent = `${p.played.length} results · ${s.rows.length - p.played.length} pulled from the Planner`
    + (dead ? ` · ${dead} not counting` : "");
  let out = "", seenToday = false, seenYear = false;
  s.rows.forEach(r => { if(!seenToday && r.d != null && r.d > today){ seenToday = true; out += `<tr class="divider today"><td colspan="15">▲ today ▲</td></tr>`; } if(!seenYear && r.d != null && r.d > today + 365){ seenYear = true; out += `<tr class="divider year"><td colspan="15">▲ 1 year mark ▲</td></tr>`; }
    const manual = r.kind === "manual"; const cls = (manual ? "" : "auto") + (r.incl && !r.inwin ? " expired" : "") + (r.incl && r.inwin && !r.counting ? " dropped" : "");
    out += `<tr data-kind="${r.kind}" data-id="${esc(r.id)}" class="${cls}">
      <td><input type="checkbox" data-k="incl" ${r.incl ? "checked" : ""} aria-label="Include ${esc(r.name)}"></td>
      <td class="num" style="white-space:nowrap">${manual ? `<input type="date" data-k="date" value="${esc(r.date)}">` : fmtD(r.d)}</td>
      <td class="tname">${manual ? `<input type="text" data-k="name" value="${esc(r.name)}">` : esc(r.name)}${claimTag(r, today)}</td>
      <td>${manual ? `<input type="text" data-k="location" value="${esc(r.location || "")}">` : esc(r.location)}</td>
      <td>${manual ? `<select data-k="size">${selOpts(SIZES, r.size, "—")}</select>` : esc(r.size)}</td>
      <td>${manual ? `<select data-k="enter">${selOpts(["Yes","No","Planned"], r.enter)}</select>` : esc(r.enter)}</td>
      <td>${manual ? `<select data-k="exact">${selOpts(ROUNDS, r.exact, "—")}</select>` : esc(r.exact || "—")}</td>
      <td>${manual ? `<select data-k="rfrom">${selOpts(ROUNDS, r.rfrom, "—")}</select>` : esc(r.rfrom || "—")}</td>
      <td>${manual ? `<select data-k="rto">${selOpts(ROUNDS, r.rto, "—")}</select>` : esc(r.rto || "—")}</td>
      <td class="r num"><b>${fmtN(r.pts)}</b></td>
      <td class="num" style="white-space:nowrap">${r.d == null ? "" : fmtD(r.d + 364)}</td>
      <td>${r.incl ? (r.counting ? `<span class="pill counting">Yes</span>` : `<span class="pill no">No</span>`) : ""}</td>
      <td>${r.incl ? (r.inwin ? `<span class="pill yes">Yes</span>` : `<span class="pill no">No</span>`) : ""}</td>
      <td class="r num">${r.inwin ? r.prank : ""}</td>
      <td>${manual ? `<button class="del" data-del="1" title="Remove">×</button>` : ""}</td></tr>`; });
  if(!s.rows.length) out = `<tr><td colspan="15" class="na">No results yet — add your counting history with “+ Add result”, or import a planner workbook in Settings.</td></tr>`;
  $("#playedTbl tbody").innerHTML = out; }

function renderCalendar(){ const p = P(), today = todayN(); const t = new Date(today*86400000);
  const first = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) / 86400000; const lastMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 12, 0)); const last = Math.round(lastMonth.getTime() / 86400000);
  const dow = n => new Date(n*86400000).getUTCDay(); let cur = first - dow(first); const endWeek = last + (6 - dow(last));
  const evs = pool(p).filter(r => r.enter === "Yes" || r.enter === "Planned").map(r => { const s = r.d; let e = r.end ? dnum(r.end) : null; if(e == null || e < s) e = s - dow(s) + 6; return { name: r.name, st: r.enter === "Yes" ? "yes" : "plan", s, e, maybe: e + 1 }; });
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  let html = `<div class="cal-head"><div>Month</div>${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => `<div>${d}</div>`).join("")}<div>Tournaments this week</div></div>`;
  let lastLabel = "";
  for(let w = cur; w <= endWeek; w += 7){ let label = ""; for(let d = w; d < w + 7; d++){ const dt = new Date(d*86400000); if(dt.getUTCDate() === 1 || d === cur){ const l = months[dt.getUTCMonth()] + " " + dt.getUTCFullYear(); if(l !== lastLabel){ label = l; lastLabel = l; } } }
    const [mn, yr] = label.split(" ");
    let days = ""; for(let d = w; d < w + 7; d++){ const dt = new Date(d*86400000); let cls = "day"; if(dt.getUTCDate() === 1) cls += " newmonth"; if(d === today) cls += " today";
      const hit = evs.find(e => e.st === "yes" && d >= e.s && d <= e.e) || evs.find(e => e.st === "plan" && d >= e.s && d <= e.e); const mb = !hit && (evs.find(e => e.st === "yes" && e.maybe === d) || evs.find(e => e.st === "plan" && e.maybe === d));
      if(hit) cls += " " + hit.st; else if(mb) cls += " " + mb.st + "-m"; if(d < first || d > last) cls += " out";
      days += `<div class="${cls}">${dt.getUTCDate()}</div>`; }
    const inWeek = evs.filter(e => e.s <= w + 6 && e.e >= w); html += `<div class="cal-week"><div class="m">${mn ? esc(mn) : ""}${yr ? `<small>${yr}</small>` : ""}</div>${days}<div class="ev">${inWeek.map(e => `<span><i class="${e.st}"></i>${esc(e.name)}</span>`).join("")}</div></div>`; }
  $("#cal").innerHTML = html; }

function renderSettings(){ const p = P(); $("#sName").value = p.name; $("#sGender").value = p.gender || "M"; const sh = $("#sHome"); sh.innerHTML = selOpts(REGIONS, p.home); $("#sNotes").value = p.notes || "";
  const c = p.card || {}; $("#cCounting").value = c.counting ?? ""; $("#cPlayed").value = c.played ?? ""; $("#cAverage").value = c.average ?? ""; $("#cRank").value = c.rank ?? ""; $("#cDate").value = c.date || "";
  const s = playedScenario(p); const items = []; if(c.counting != null && c.counting !== "") items.push(`counting ${fmtN(s.total)} vs ${fmtN(c.counting)}`); if(c.played) items.push(`played ${s.played} vs ${c.played}`); if(c.average) items.push(`average ${fmtN(s.avg)} vs ${fmtN(c.average)}`); if(c.rank) items.push(`rank ${s.rank == null ? "—" : "#" + s.rank} vs #${c.rank}`);
  const ok = items.length && (c.counting == null || c.counting === "" || Math.abs(s.total - c.counting) < 0.01) && (!c.played || s.played === Number(c.played)) && (!c.rank || s.rank === Number(c.rank));
  $("#reconcile").innerHTML = items.length ? (ok ? `<span style="color:var(--yes)">✓ Played tab reconciles with your ranking</span> — ${items.join(" · ")}` : `<span class="warn">Played tab does not match your ranking</span> — ${items.join(" · ")}. Check the history: a missing result, a wrong category, or a withdrawal that should not be listed.`) : "Enter your ranking as PSA has it to reconcile the Played tab against it.";
  $("#perfTbl tbody").innerHTML = SIZES.map(sz => { const v = refPts(sz, p.perf[sz]); return `<tr><td class="hd">${esc(sz)}</td><td><select data-perf="${esc(sz)}">${selOpts(ROUNDS, p.perf[sz])}</select></td><td class="r num">${v == null ? `<span class="na">n/a at this level</span>` : fmtN(v)}</td></tr>`; }).join("");
  renderFieldPrefs();
  const fl = floorInfo(p); $("#floorMsg").innerHTML = fl.active ? `Current average ${fmtN(fl.avg)} → floor <b>${esc(fl.size)}</b>, where a win pays ${fmtN(DATA.points[fl.size] ? DATA.points[fl.size][0] : 0)}.` : `Average ${fmtN(fl.avg)} on ${fl.played} played — no floor until 11 tournaments.`;
  $("#matrixTbl").innerHTML = `<thead><tr><th>From \\ To</th>${REGIONS.map(r => `<th>${esc(r.replace(" America"," Am."))}</th>`).join("")}</tr></thead><tbody>` + REGIONS.map(from => `<tr${from === p.home ? ' style="background:var(--surface-2)"' : ""}><td class="hd">${esc(from)}${from === p.home ? " ★" : ""}</td>${REGIONS.map((to, j) => `<td><input type="number" min="1" max="5" data-mf="${esc(from)}" data-mj="${j}" value="${p.matrix[from][j]}"></td>`).join("")}</tr>`).join("") + `</tbody>`;  loadIngestPanel(); }

function renderPoints(){ $("#pointsTbl").innerHTML = `<thead><tr><th>Category</th>${ROUNDS.map(r => `<th class="r">${esc(r)}</th>`).join("")}</tr></thead><tbody>` + SIZES.map(sz => `<tr><td class="hd" style="font-weight:500">${esc(sz)}</td>${DATA.points[sz].map(v => `<td class="r num">${v == null ? `<span class="na">—</span>` : fmtN(v)}</td>`).join("")}</tr>`).join("") + "</tbody>"; }

function renderRankings(){ const p = P(); const rk = rankingsFor(p.gender); const s = playedScenario(p);
  if(!rk){ $("#rankIntro").textContent = "No women's rankings loaded yet. Run the PSA Sync extension, or import a CSV under Settings → Replace rankings with columns rank, name, country, code, total, counting, average, played."; $("#rankTbl tbody").innerHTML = ""; $("#rCount").textContent = ""; return; }
  const src = rankingsSource(p.gender), tour = p.gender === "W" ? "Women's" : "Men's";
  const meta = captured.meta && captured.meta[p.gender === "W" ? "women" : "men"];
  $("#rankIntro").textContent = src === "captured"
    ? `${tour} PSA World Rankings, captured in full on ${meta ? meta.ranked_on : "an earlier run"} — every ranked player, with the raw average (total points ÷ tournaments played, nothing dropped) alongside the official one.`
    : `${tour} PSA World Rankings snapshot (${state.shared.rankingsDate || DATA.rankingsDate}). Ranks 1–200 exact; beyond that sampled anchors. Run the PSA Sync extension for the full list and raw averages.`;
  const grossTotal = (s.rows || []).filter(r => r.inwin).reduce((a, r) => a + r.pts, 0);
  const q = state.rq.trim().toLowerCase();
  const you = { rank: s.rank, name: `${p.name} — projected (Played tab)`, country: "", total: grossTotal, counting: s.total, average: s.avg, played: s.played, you: true };
  let rows = rk.filter(r => !q || (r.name + " " + (r.country || "")).toLowerCase().includes(q)); if(!q && s.rank != null){ const i = rows.findIndex(r => r.rank >= s.rank); rows = rows.slice(); rows.splice(i < 0 ? rows.length : i, 0, you); }
  const LIMIT = 400, over = rows.length > LIMIT;
  let shown = rows.slice(0, LIMIT);
  // Never lose the player's own row to the cut-off — someone ranked 900th still
  // wants to see where they sit.
  if(over && !shown.some(r => r.you) && rows.some(r => r.you)) shown = shown.slice(0, LIMIT - 1).concat(rows.find(r => r.you));
  $("#rCount").textContent = over ? `${rk.length} players · showing ${LIMIT}, search to narrow` : `${rk.length} players`;
  $("#rankTbl tbody").innerHTML = shown.map(r => { const h = honestAvg(r);
    return `<tr${r.you ? ' style="background:var(--yes-soft);font-weight:600"' : ""}><td class="r num">${r.you ? "→ #" + r.rank : r.rank}</td><td>${esc(r.name)}</td><td>${esc(r.country || "")}${r.code ? ` <span class="na">${esc(r.code)}</span>` : ""}</td><td class="r num">${r.total === "" || r.total == null ? "" : fmtN(r.total)}</td><td class="r num">${fmtN(r.counting)}</td><td class="r num">${fmtN(r.average)}</td><td class="r num">${h == null ? `<span class="na">—</span>` : fmtN(h)}</td><td class="r num">${r.played}</td></tr>`; }).join(""); }

/* ---------- entry lists: ingest token + capture stats ---------- */
function supa(){ return (typeof ctx !== "undefined" && ctx && ctx.supabase) ? ctx.supabase : null; }
let ingestTokenValue = "";
async function loadIngestPanel(){
  const inp = $("#ingestToken"); if(!inp) return;
  const card = inp.closest(".card"); const sb = supa();
  if(!sb){ if(card) card.hidden = true; return; }
  if(card) card.hidden = false;
  if(!ingestTokenValue){
    try { const { data, error } = await sb.rpc("my_ingest_token"); if(error) throw error; ingestTokenValue = data || ""; }
    catch(e){ $("#tokenMsg").innerHTML = `<span class="warn">Could not load your token: ${esc(e.message)}. Has entries.sql been run in Supabase?</span>`; }
  }
  inp.value = ingestTokenValue;
  loadEntryStats();
}
async function loadEntryStats(){
  const el = $("#entryStats"), msg = $("#entryStatsMsg"), sb = supa();
  if(!el || !sb) return;
  try {
    const { data, error } = await sb.from("entry_lists").select("tournament_slug,division_id,captured_at");
    if(error) throw error;
    const tourneys = new Set(data.map(r => r.tournament_slug)).size;
    const last = data.reduce((m, r) => (r.captured_at > m ? r.captured_at : m), "");
    const men = (captured.meta && captured.meta.men) || null, women = (captured.meta && captured.meta.women) || null;
    const sm = captured.schedMeta;
    el.innerHTML = `<b class="num">${sm ? sm.draws : "—"}</b><span>calendar draws</span>`
      + `<b class="num">${tourneys}</b><span>tournaments</span><b class="num">${data.length}</b><span>draws</span>`
      + `<b class="num" style="font-size:15px">${last ? new Date(last).toLocaleString() : "—"}</b><span>last capture</span>`
      + `<b class="num">${men ? men.players : "—"}</b><span>men ranked${men ? ` (${men.ranked_on})` : ""}</span>`
      + `<b class="num">${women ? women.players : "—"}</b><span>women ranked${women ? ` (${women.ranked_on})` : ""}</span>`;
    msg.textContent = data.length ? "" : "Nothing captured yet. Install the extension, paste the token above, and press Refresh now.";
  } catch(e){ el.innerHTML = ""; msg.innerHTML = `<span class="warn">Could not read entry lists: ${esc(e.message)}</span>`; }
}

// The calendar is a few hundred rows and everything on the Planner depends on
// it, so it is fetched first and the page redrawn as soon as it lands.
const SCHED_PAGE = 1000;
async function loadCapturedSchedule(){
  const sb = supa(); if(!sb) return;
  try {
    const { data: meta, error } = await sb.rpc("schedule_summary");
    if(error) throw error;
    captured.schedMeta = meta && meta.draws ? meta : null;
    if(!captured.schedMeta) return;

    const rows = [];
    for(let from = 0; from < meta.draws + SCHED_PAGE; from += SCHED_PAGE){
      const r = await sb.from("schedule")
        .select("psa_slug,gender,name,city,country,level_type,level,restricted,restriction,status,start_date,end_date")
        .order("start_date", { ascending: true }).order("name", { ascending: true })
        .range(from, from + SCHED_PAGE - 1);
      if(r.error) throw r.error;
      rows.push(...r.data);
      if(r.data.length < SCHED_PAGE) break;
    }
    // Federation events and unknown levels drop out here, so the stored count
    // and the planned-against count are different numbers on purpose.
    const out = rows.map(scheduleRow).filter(Boolean).filter(s => s.start);
    // A country the continent map has never heard of lands on "TBA", which is
    // charged as an average trip rather than a real one. That is a quiet wrong
    // answer, so it gets said out loud instead of absorbed.
    const unknown = [...new Set(out.filter(s => s.continent === "TBA" && s.location !== "TBA")
      .map(s => s.location.split(",").pop().trim()))];
    if(unknown.length) console.warn("Tour Advisor: no continent for " + unknown.join(", ")
      + " — those events are priced as an average trip. Add them to countryContinent.");
    if(out.length){
      out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.name.localeCompare(b.name));
      captured.schedule = out;
      render();
    }
  } catch(e){ console.warn("captured schedule:", e && e.message); }
}

// The full ranking list is a few thousand rows, so it is fetched once per
// session, in the background, and the page redrawn when it lands.
const RANK_PAGE = 1000;
async function loadCapturedRankings(){
  if(captured.tried) return; captured.tried = true;
  const sb = supa(); if(!sb) return;
  loadCapturedSchedule();
  try {
    const { data: summary, error } = await sb.rpc("rankings_summary");
    if(error) throw error;
    captured.meta = summary || {};
    for(const div of ["men", "women"]){
      const info = captured.meta[div];
      if(!info || !info.players) continue;
      const rows = [];
      for(let from = 0; from < info.players + RANK_PAGE; from += RANK_PAGE){
        const r = await sb.from("rankings").select("rank,name,country,total,counting,average,played,divisor")
          .eq("division", div).order("rank", { ascending: true }).order("name", { ascending: true })
          .range(from, from + RANK_PAGE - 1);
        if(r.error) throw r.error;
        // Postgres numerics arrive as strings; the ranking maths compares them.
        rows.push(...r.data.map(x => Object.assign({}, x, {
          total: x.total == null ? null : Number(x.total),
          counting: x.counting == null ? null : Number(x.counting),
          average: x.average == null ? 0 : Number(x.average),
        })));
        if(r.data.length < RANK_PAGE) break;
      }
      if(rows.length) captured[div] = rows;
    }
    if(captured.men || captured.women) render();
    else loadEntryStats();
  } catch(e){ console.warn("captured rankings:", e && e.message); }
}



/* ---------- what every number means ---------- */
// Written for a player opening this for the first time, not for completeness.
// One shared tooltip element, positioned on hover, so nothing gets clipped by a
// table's overflow and the text can be longer than a native title allows.
const DEFS = {
  counting: ["Counting points", "The points that actually count towards your average — your best results inside the last 365 days. Anything the divisor drops is not in here."],
  playedwin: ["Played (in window)", "How many tournaments you have played in the last 365 days. Results older than that have expired and no longer count."],
  divisor: ["Divisor", "What your points get divided by. It is 11 until you have played 16 tournaments; after that it is your tournaments played minus four. A rising divisor pulls your average down, which is why it is worth watching."],
  average: ["Average", "Counting points ÷ divisor. This is the number the world ranking is built on."],
  projrank: ["Projected rank", "Where this average would place you in the current world rankings. It moves as you tick results on and off."],
  window: ["The window", "The 365 days your results count for. A result expires 364 days after the tournament's start date, so the window rolls forward with time."],
  honest: ["Raw average", "Total points ÷ tournaments played. Nothing dropped. Under 11 tournaments this is kinder than the official average, because the official one divides by 11 whatever you have played. Over 11, it is harsher, because the official one throws away your worst results."],
  official: ["Official average", "The PSA number: your best 11 results ÷ 11, or once past 15 tournaments, your best (played − 4) ÷ (played − 4). It always drops your worst four."],
  strength: ["Strength", "How good a player is, in points per tournament. It is their raw average — total points ÷ tournaments played — or their official average if you switch the basis. The model compares two strengths to work out who wins."],
  fieldcol: ["AdvisorScore", "What this tournament is worth to you: the points you would average if the draw were played out thousands of times, followed by where you would be seeded. Click it to see the whole field."],
  advrec: ["Advisor recommendation", "The answer to the question you opened this with, in three words. <b>Yes</b> means playing it clearly lifts your average. <b>No</b> means it would pull you down \u2014 which past fifteen played is easier than it sounds, because every extra event raises your divisor. <b>Depends</b> is not a hedge: it is what is true when the week turns on one or two matches the model calls a coin toss, or when the entry list is not final yet. The measure is not points, it is how far your average moves with this event in your season versus without it. Hover for the working."],
  finality: ["How final this field is", "An entry list is only the field once entries have closed. Before that it is a list in progress \u2014 and it fills from the top, because the stronger players enter late while they weigh their options. So a thin list months out is not a weak draw, it is an unfinished one, and treating it as weak is how you end up flying somewhere that became a different tournament by the time it was played."],
  planbasis: ["Which reading to plan on", "Five ways of reading the same tournaments, side by side. <b>Raw average</b> measures every opponent by total points \u00f7 tournaments played, nothing dropped. <b>Official average</b> measures them by the average PSA publishes, which drops the worst results. <b>My evaluation</b> ignores who entered and uses the round you expect at each category, from Settings. SquashLevels and ClubLocker are shown greyed because neither can be captured yet. Each button carries the average its own model lands on, so choosing and comparing are the same act \u2014 and where they disagree, the disagreement is the finding."],
  planrank: ["Which one to play", "The Advisor plan is picked from every tournament, the other only from what fits around what you have already entered \u2014 so the Advisor plan can never come out worse. The only question is whether it is actually better, and by enough to be worth going back on your word. When the two are level, keeping the commitment wins."],
  planload: ["Travel", "How many weeks away this schedule is, and how many of those are long haul \u2014 a trip to a region you rate 4 or 5 on the Settings matrix, where 1 is your own region. Switch on Weigh travel and it becomes a tiebreak: two schedules landing within half a percent of the same average are settled by the one that keeps you closer to home. It never trades real average for comfort \u2014 a schedule worth three more points still wins however far away it is."],
  plandefault: ["Valued from your Settings default", "No entry list has been captured for this event and you have not set a result on its row, so the only figure left is your default for the category in Settings. It is the weakest of the three readings by a distance: it is one number applied to every event of a size, so it cannot tell two of them apart \u2014 and the defaults you have set run higher than the fields that have actually been measured, which means these events come out looking better than the ones we know about. Capture the entry list, or type what you expect on that row, and this mark goes away."],
  planregions: ["Where you can play", "A PSA membership does not cover the whole tour. A Regional or Country membership covers its own region or country and nothing else, so an event outside it is not a long flight \u2014 it is not enterable at all, and the entry is refused before you get to the price of the ticket. Set the regions your membership actually covers and the schedule stops offering you tournaments you cannot enter. Leave it empty and nothing is excluded. An event whose country is still TBA is never excluded, because there is nothing yet to exclude it on."],
  planunvalued: ["Nothing to value these by", "The captured entry list puts you in the qualifying draw, and this event has not published a qualifying points table. Every available figure would be wrong: the main-draw value is three won matches away, and your category default in Settings is a main-draw figure as well. So it is reported rather than guessed at. PSA publishes these tables per event, so this usually resolves itself closer to the date."],
  planreserve: ["On the reserve list", "The captured entry list puts you outside the main draw here, so this is not in either schedule \u2014 you cannot plan on a place you do not have. It is not a no, though: players withdraw between entries closing and the first ball, and the reserves move up. Each row says how far down the list promotions have actually reached at that level, counted from the withdrawals in the draws captured so far \u2014 so \"deepest reserve to get in: #5\" means someone five places down the list played."],
  planceil: ["Highest category", "How far up the tour to look. Entry to the big draws is by ranking cut and nothing in the data says where that cut fell, so this defaults to the biggest event you have actually played, plus one step. Raise it if you know you would get in."],
  expected: ["AdvisorScore", "What a season of tournaments like this one would average you, over thousands of simulated draws. It sits above the most likely result because the weeks where you go deep pull it up — so it is a true average, not a prediction of any one week."],
  likely: ["Most likely", "The round you reach more often than any other, and how often. Beside it, the average points across every simulated draw — a true average, so it is a figure you may never actually score, the way nobody has 2.4 children. The round answers how far you get; the points answer what the week is worth."],
  chalk: ["No upsets", "Where you finish if every match goes to the stronger player. With normal seeding the top two reach the final, the top four the semis, the top eight the quarters — so your seeding alone decides it."],
  fieldstr: ["Field level", "The average strength of everyone entered, with your own beside it. Useful for spotting a weak week without thinking about the draw at all. The strongest eight average a separate figure, which matters more if you expect to go deep."],
  seat: ["Your place", "Two answers, and the gap between them is the point. By ranking is where a tournament director would seed you, because seeding follows the world ranking. By strength is where the model puts you, on raw averages. Seeded 25th but 13th strongest means the draw underrates you and an upset is likelier than the bracket suggests; the other way round is a warning."],
  modelp: ["Model", "The model's estimate of your chance of beating this player, from the gap between your two strengths."],
  yourp: ["Your own figure", "Your chance against this player, in your judgement. It replaces the model for them, here and in every tournament they enter from now on. Leave it blank to use the model."],
  yourest: ["Your own estimate", "What the planner already assumed for you: the round you told it to expect at this category, set on the Settings tab. Kept here so you can see when your own guess and the model disagree."],
  upsetk: ["Upset factor", "How much the gap in strength decides the match. Low means a chaotic sport where the weaker player often wins; high means the stronger player nearly always wins. Two players with the same average are always 50/50, whatever you set."],
  basis: ["Strength basis", "Which average the model treats as a player's true level — the raw one (everything counts) or the official one (worst results dropped). Where the two disagree, the field is ranked above or below its real consistency."],
  travel: ["Travel difficulty", "How hard this trip is from your home region, 1 to 5, from your own matrix in Settings. Not distance — your judgement of cost and hassle."],
  points: ["Points", "What you would score at this tournament for the result you expect, from the PSA points table for its category."],
  floor: ["Sensible floor", "Once you have 11 tournaments, a win at some categories is worth less than your current average — so entering can only pull you down. The floor is the smallest category still worth playing."],
  clash: ["Clash", "Two tournaments you have marked Yes or Planned whose dates overlap. You cannot play both."],
  gaptag: ["Tight turnaround", "These two events are within three days of each other. Possible, but it means travelling straight from one to the next with no rest."],
};

let tipEl = null;
function showTip(target){
  const d = target.dataset.tiptext
    ? [target.dataset.tiptitle || "", target.dataset.tiptext]
    : DEFS[target.dataset.tip];
  if(!d) return;
  if(!tipEl){ tipEl = document.createElement("div"); tipEl.id = "tip"; document.body.appendChild(tipEl); }
  tipEl.innerHTML = `<b>${esc(d[0])}</b>` + String(d[1]).split("\n")
    .map(l => `<div class="${l.startsWith("\u2022") ? "tb" : l.startsWith("\u2192") ? "tsum" : ""}">${esc(l)}</div>`).join("");
  tipEl.style.visibility = "hidden"; tipEl.classList.add("on");
  const anchor = target.closest(".tile, .mth") || target;
  const r = anchor.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left), window.innerWidth - t.width - 8);
  let top = r.bottom + 8;
  if(top + t.height > window.innerHeight - 8) top = Math.max(8, r.top - t.height - 8);
  tipEl.style.left = left + "px"; tipEl.style.top = top + "px";
  tipEl.style.visibility = "visible";
}
function hideTip(){ if(tipEl) tipEl.classList.remove("on"); }
function bindTips(){
  document.addEventListener("mouseover", e => { const t = e.target.closest("[data-tip]"); if(t) showTip(t); });
  document.addEventListener("mouseout", e => { if(e.target.closest("[data-tip]")) hideTip(); });
  document.addEventListener("click", e => { const t = e.target.closest("[data-tip]"); if(t) showTip(t); else hideTip(); });
  window.addEventListener("scroll", hideTip, { passive: true });
}

/* ---------- which columns the Planner shows ---------- */
// Every column but Use?, Date and Tournament can be switched off, and switched
// straight back on — one player wants continent and travel, another only wants
// dates and points. Kept on the profile so it follows them between machines.
const PLANNER_COLS = [
  { k: "continent", label: "Continent" },
  { k: "location",  label: "Location" },
  { k: "size",      label: "Category" },
  { k: "enter",     label: "Enter?" },
  { k: "points",    label: "Points" },
  { k: "field",     label: "Score" },
  { k: "result",    label: "Exact result & range" },
  { k: "notes",     label: "Notes" },
];
const colHidden = p => (p.cols && p.cols.hidden) || [];
function applyCols(p){
  const menu = $("#fCols .menu"); const hidden = colHidden(p);
  if(menu && !menu.childElementCount){
    menu.innerHTML = PLANNER_COLS.map(c => `<label><input type="checkbox" value="${esc(c.k)}"> ${esc(c.label)}</label>`).join("")
      + `<button type="button" class="clear">Show all</button>`;
  }
  if(menu) menu.querySelectorAll("input").forEach(i => { i.checked = !hidden.includes(i.value); });
  const sum = $("#fCols summary");
  if(sum){ const off = hidden.length;
    sum.querySelector("b").textContent = off ? `${PLANNER_COLS.length - off} of ${PLANNER_COLS.length}` : "All";
    sum.querySelector(".lbl").hidden = off > 0; }
  const st = $("#colStyle");
  if(st) st.textContent = hidden.length
    ? hidden.map(k => `#plannerTbl [data-col="${k}"]`).join(",") + "{display:none}" : "";
}
function toggleCol(p, k, show){
  p.cols = p.cols || {};
  const set = new Set(colHidden(p));
  if(show) set.delete(k); else set.add(k);
  p.cols.hidden = Array.from(set);
  savePlayer(p); renderPlanner();
}


// One cell per tournament: what the simulation thinks it is worth, and where you
// would slot into the draw. Blank when we have no entry list for that event.
const PLANNER_RUNS = 1200;
function fieldCell(r, p){
  if(!fields.lists) return "";
  const a = analyse(r, p, PLANNER_RUNS);
  if(!a) return `<span class="na" title="No entry list captured for this tournament">—</span>`;
  // A list we have but cannot read. Distinguished from having none, because the
  // two want different things from you: one wants a refresh, the other wants time.
  if(a.unreadable) return a.unreadable === "broken"
    ? `<span class="na warnna" title="The captured list has only ${a.places} name${a.places === 1 ? "" : "s"} in the main draw, and entries have closed. That is not a small field, it is a capture that did not come through \u2014 run the refresh.">broken</span>`
    : `<span class="na" title="Entries have only just opened here: ${a.places} name${a.places === 1 ? "" : "s"} in the main draw so far. Nothing to read yet.">too early</span>`;
  if(a.chalk && a.chalk.reserve) return `<button class="fieldbtn" data-field="${esc(r.id)}" title="Open the field">reserve #${a.chalk.reserve}</button>`;
  // In the qualifying draw with nothing published to value it by. A main-draw
  // number here would be wrong by three matches.
  if(a.qualUnvalued) return `<button class="fieldbtn" data-field="${esc(r.id)}" `
    + `title="You are in the qualifying draw, and this event has not published what its qualifying rounds pay">qualifying</button>`;
  if(!a.sim) return `<button class="fieldbtn" data-field="${esc(r.id)}">field</button>`;
  // Up or down against your own estimate for this event — and neutral when you
  // have not made one, since the category default is not an estimate of this.
  const diff = r.own == null ? 0 : a.sim.expected - r.own;
  const cls = Math.abs(diff) < 1 ? "" : diff > 0 ? "up" : "down";
  // A qualifying entry is labelled as one. The number is still the honest value
  // of turning up — the qualifying rounds plus the main draw discounted by how
  // often you reach it — but it is not a main-draw seeding, so it does not get
  // shown as one.
  // A field whose entries are still open is not comparable with one that has
  // closed, and this column is sortable — so ranking them against each other is
  // exactly the trap. The mark says the number is provisional; the tooltip says
  // why, and which way it will move.
  const prov = a.finality && a.finality.state !== "final"
    ? `<i class="prov" title="${esc(a.finality.label + " \u2014 " + a.finality.note.replace(/<[^>]+>/g, ""))}">*</i>` : "";
  if(a.mustQualify) return `<button class="fieldbtn ${cls}" data-field="${esc(r.id)}" `
    + `title="Qualifying draw: ${a.qual.rounds} matches to come through, ${Math.round(a.qual.pThrough * 100)}% of the time · click for the full field">`
    + `<b>${fmtN(Math.round(a.sim.expected))}${prov}</b><span>Q</span></button>`;
  return `<button class="fieldbtn ${cls}" data-field="${esc(r.id)}" title="Seed ${a.field.mine.pos} of ${a.field.places} · click for the full field">`
    + `<b>${fmtN(Math.round(a.sim.expected))}${prov}</b><span>#${a.field.mine.pos}</span></button>`;
}

/* ---------- field strength ---------- */
// Entry lists come from the PSA Sync extension; rankings give every entrant a
// strength. Everything below is a different way of answering the same question:
// what is this tournament worth to me.

const FIELD_MIN = 1;          // a player with no results is not literally zero
let fieldK = 2;               // P(A beats B) = sA^k / (sA^k + sB^k)
let fieldBasis = "honest";    // "honest" = total / played, "official" = the ranking average
const SIM_RUNS = 4000;

const fields = { lists: null, tried: false, index: null };

const normTitle = s => String(s || "").toLowerCase()
  .replace(/[‘’'`]/g, "")
  .replace(/\b(19|20)\d\d\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();
// Words that appear in half the tournament names on tour, plus the year, which
// every name carries. Matching on these alone is how "Charlottesville Open 2026"
// came to be scored against the field of "Champion Fiberglass Swedish Open 2026
// presented by Boka Bord" — the only tokens they shared were "open" and "2026",
// and both names are long enough that two hits cleared the threshold.
const TITLE_NOISE = new Set(["open", "classic", "championship", "championships",
  "international", "invitational", "squash", "psa", "tour", "cup", "challenger",
  "satellite", "presented", "sponsored", "the", "and", "men", "mens", "women",
  "womens", "presents", "masters", "series", "trophy"]);
const isYear = w => /^(19|20)\d\d$/.test(w);

// "U.S. Open" comes out of normTitle as "u s open": three words, two of them one
// letter. Glue runs of initials back together so it reads as "us open" whichever
// way the two pages punctuate it.
function titleWordList(s){
  const out = []; let buf = "";
  normTitle(s).split(" ").filter(Boolean).forEach(w => {
    if(w.length === 1){ buf += w; return; }
    if(buf){ out.push(buf); buf = ""; }
    out.push(w);
  });
  if(buf) out.push(buf);
  return out;
}
const titleTokens = s => new Set(titleWordList(s).filter(w => w.length > 2));
const titleCore = s => new Set(titleWordList(s)
  .filter(w => w.length > 2 && !isYear(w) && !TITLE_NOISE.has(w)));

function overlap(A, B){
  if(!A.size || !B.size) return 0;
  let hit = 0; A.forEach(w => { if(B.has(w)) hit++; });
  return hit / Math.min(A.size, B.size);
}
// Both ways round, so a short name cannot be swallowed by a long one.
function jaccard(A, B){
  if(!A.size || !B.size) return 0;
  let hit = 0; A.forEach(w => { if(B.has(w)) hit++; });
  return hit / (A.size + B.size - hit);
}
// How near-identical two whole names must be before a name made only of generic
// words is allowed to match.
const BARE_MIN = 0.6;
// Compare on the distinctive words. A few events really are called nothing but
// generic words — "U.S. Open", "The Open" — and for those the distinctive set is
// empty. Scoring those on shared tokens divided by the smaller set gives 1.0
// against every other "... Open" on tour, which is how the U.S. Open was handed
// the Charlottesville Open's field. When either side is bare, demand that the
// whole names agree instead, in both directions.
function titleSim(a, b){
  const A = titleCore(a), B = titleCore(b);
  if(A.size && B.size) return overlap(A, B);
  const j = jaccard(new Set(titleWordList(a)), new Set(titleWordList(b)));
  return j >= BARE_MIN ? j : 0;
}
// The level, as PSA writes it in the calendar cell. One cell can carry both
// genders at different levels — the real strings look like
// "M (Challenger: 12) W (Challenger: 6)" and "MW (Satellite: Satellite) M
// (Challenger: 12) W (Challenger: 9)" — so this returns every level named in
// the text, not the first one. Reading only the first would veto a women's
// Challenger 6 for not being the men's Challenger 12 printed beside it.
//
// Used only to refuse a match: if both sides name levels we recognise and they
// share none, it is not the same tournament however alike the names read.
function levelSizes(txt){
  const t = String(txt || "").toLowerCase();
  const out = new Set();
  let m; const ch = /challenger\D{0,4}(\d+)/g;
  while((m = ch.exec(t))){ const k = "Challenger " + m[1]; if(DATA.points[k]) out.add(k); }
  if(/world\s*champ/.test(t)) out.add("World Championship");
  for(const s of ["Satellite", "Copper", "Bronze", "Silver", "Gold", "Platinum", "Diamond"])
    if(t.includes(s.toLowerCase())) out.add(s);
  return out;
}
const shareLevel = (a, b) => { let hit = false; a.forEach(x => { if(b.has(x)) hit = true; }); return hit; };


// The same cell, read for one gender. PSA writes the level per gender in a
// single string — "M (Challenger: 18)", "M (Challenger: 12) W (Challenger: 6)",
// "MW (World: Platinum)" — and the whole string was being compared against the
// list of category names, which of course never matched. Every test had used a
// clean "Challenger 18", so it passed everywhere while doing nothing on real
// data: on the live site entry cuts and withdrawal statistics both came out
// empty, the reach ceiling quietly fell back to "the biggest event you have
// played, plus one", and the reserve questionnaire had no evidence to show.
//
// Returns null where the cell names more than one level for this gender (a
// Satellite and a Challenger at the same event), since guessing which division
// a list belongs to would be worse than declining to say.
const LEVEL_SEG = /\b(MW|M|W)\s*\*?\s*\(\s*([^)]*?)\s*\)/g;
function levelForGender(txt, gender){
  const want = gender === "W" ? "W" : "M";
  const t = String(txt || "");
  const hits = new Set();
  let m; LEVEL_SEG.lastIndex = 0;
  while((m = LEVEL_SEG.exec(t))){
    if(m[1].indexOf(want) < 0) continue;
    levelSizes(m[2]).forEach(x => hits.add(x));
  }
  // A plain "Copper", written with no gender marker at all, is read as it stands.
  // The fallback used to fire whenever *this* gender had no segment, which handed
  // the men's level to a women's division: "M (Challenger: 18)" read as a
  // Challenger 18 for the women too. A cell that names genders and does not name
  // this one is an answer, and the answer is nothing.
  if(!hits.size && !LEVEL_SEG.test(t)) levelSizes(t).forEach(x => hits.add(x));
  LEVEL_SEG.lastIndex = 0;
  return hits.size === 1 ? Array.from(hits)[0] : null;
}const normPerson = s => String(s || "").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

// Match a schedule row to a captured entry list: same tour, near-identical dates,
// then the best title overlap. Dates do most of the work; the title breaks ties.
function matchList(row, gender){
  if(!fields.lists) return null;
  const want = gender === "W" ? "women" : "men";
  const d = dnum(row.start);
  let best = null, bestSim = 0;
  fields.lists.forEach(L => {
    if(!/^(men|women)/i.test(L.division_name || "")) return;
    if((L.division_name || "").toLowerCase().indexOf(want) !== 0) return;
    const ld = L.start_date ? dnum(L.start_date) : null;
    if(ld == null || Math.abs(ld - d) > 3) return;
    const ls = levelSizes(L.level), rs = levelSizes(row.size);
    if(ls.size && rs.size && !shareLevel(ls, rs)) return;
    const sim = titleSim(row.name, L.tournament_name);
    if(sim > bestSim){ bestSim = sim; best = L; }
  });
  return bestSim >= 0.34 ? best : null;
}

function rankingIndex(gender){
  const rk = rankingsFor(gender) || [];
  const byName = new Map(), byRank = new Map();
  rk.forEach(r => {
    byName.set(normPerson(r.name), r);
    if(!byRank.has(r.rank)) byRank.set(r.rank, []);
    byRank.get(r.rank).push(r);
  });
  return { byName, byRank };
}
function strengthOf(r){
  if(!r) return null;
  const v = fieldBasis === "official" ? Number(r.average) : (honestAvg(r) || 0);
  return Math.max(Number.isFinite(v) ? v : 0, FIELD_MIN);
}

// One entrant, resolved against the rankings. Name first: both datasets come
// from PSA so it is reliable, and world ranking is a fallback for anyone whose
// name is spelt differently between the two pages.
// A published seed is "7", or "9/16" for a seeding band. A band means the draw
// puts you somewhere in that range, which is genuinely undetermined until the
// draw is made — so it stays a range here rather than being flattened to a guess.
function parseSeed(s){
  const m = String(s || "").match(/^(\d+)(?:\s*\/\s*(\d+))?$/);
  if(!m) return null;
  const lo = +m[1], hi = m[2] ? +m[2] : lo;
  return (lo >= 1 && hi >= lo) ? { lo, hi } : null;
}

// A withdrawal is sometimes shown in place, greyed out, before the list finishes
// reshuffling — PSA's own help page describes exactly that. Left in, the player
// is simulated as an opponent who will not be there.
const isWithdrawn = e => e && ((e.section === "withdrawn")
  || (e.flags || []).some(f => /^WITHDRAWN$/i.test(String(f))));

function rateEntry(e, idx, odds){
  const r = idx.byName.get(normPerson(e.name))
    || (e.wr != null && (idx.byRank.get(e.wr) || []).length === 1 ? idx.byRank.get(e.wr)[0] : null);
  const key = oddsKey(e);
  const own = odds && odds[key];
  const sd = parseSeed(e.seed);
  return { name: e.name, nat: e.nat, seed: e.seed, seedLo: sd && sd.lo, seedHi: sd && sd.hi,
           wr: e.wr, playerId: e.playerId, key,
           // The badges and the section travelled this far and were then thrown
           // away, so a player sitting in the main section with a WITHDRAWN badge
           // was modelled as a live opponent in the bracket.
           flags: e.flags || [], section: e.section || null, pos: e.pos || null,
           ranked: !!r, rank: r ? r.rank : null, played: r ? r.played : null,
           s: r ? strengthOf(r) : FIELD_MIN,
           myP: own && own.p != null ? Number(own.p) : null };
}

// Your own read of a matchup, kept by PSA player id where there is one and by
// name otherwise, so it follows the opponent from tournament to tournament.
const oddsKey = e => e.playerId ? "id:" + e.playerId : "n:" + normPerson(e.name);
function setOdds(p, entrant, prob){
  p.odds = p.odds || {};
  if(prob == null) delete p.odds[entrant.key];
  else p.odds[entrant.key] = { p: prob, name: entrant.name, at: iso(todayN()) };
  savePlayer(p); clearFieldCache();
}

const nextPow2 = n => { let p = 1; while(p < n) p *= 2; return Math.min(p, 64); };
const bandLabel = n => ROUNDS.find(r => r.endsWith("(" + n + ")")) || null;
function bandPoints(size, n){
  const lbl = bandLabel(n); if(!lbl) return 0;
  const v = DATA.points[size] && DATA.points[size][ROUNDS.indexOf(lbl)];
  return v == null ? 0 : v;
}
// Standard seeding: 1 plays the lowest seed, 2 is at the far end, and so on.
function seedOrder(n){
  let a = [1];
  while(a.length < n){ const m = a.length * 2 + 1, b = []; a.forEach(x => b.push(x, m - x)); a = b; }
  return a;
}

// The entry list has three sections and this used to read one of them.
//
// Proved on Yuri's own CCSA Chicago Open entry, which PSA shows as "Reserve #24"
// behind a main draw of 24. The model read only the main section, did not find
// him there, concluded he had not entered, pushed him into the main draw as a
// twenty-fifth player, ranked the 25 by strength, put him twentieth — and then
// compared twentieth against the *bracket* size of 32 rather than the 24 places
// that exist. Answer: "you are in, seed 20 of 32." Three errors stacked into one
// confident sentence, on three of his five current entries.
//
// Two numbers are needed and only one existed:
//   places — how many main-draw places the tournament actually has (24 here)
//   draw   — the bracket those places sit in (32, the rest byes)
// The first answers "am I in", the second builds the matches. They are equal
// only when the draw size happens to be a power of two.
//
// And the reserve position is published. PSA writes "R24." beside his name and
// orders the queue by ranking. There is no reason to infer it from strength.
const MIN_FIELD = 4;
const resNumber = (e, i) => {
  const m = String((e && e.pos) || "").match(/(\d+)/);
  return m ? Number(m[1]) : i + 1;
};
function buildField(list, p){
  const idx = rankingIndex(p.gender);
  const odds = p.odds || {};
  const all = list.entries || [];
  const main = all.filter(e => e.section === "main" && !isWithdrawn(e)).map(e => rateEntry(e, idx, odds));
  // How many places the tournament really has. Everything that asks "am I in"
  // asks this, not the bracket size.
  const places = main.length;
  // A list with almost nobody in it is not a weak field. Left alone, one entrant
  // plus the player became a two-man final and a winner's points — the most
  // confident wrong answer the model can give.
  //
  // Which of two things it is depends on the door. Once entries have closed, a
  // main draw of three is not a tournament, it is a capture that went wrong —
  // a mis-sectioned table, a page that did not finish loading — and the honest
  // response is to say so rather than to model around it. While entries are
  // still open it may be nothing worse than early: the window has opened and
  // few people have entered yet. Across roughly a hundred captures no real
  // event has read below sixteen, so neither case is common.
  if(places < MIN_FIELD) return { thin: true,
    why: /entries\s*close[^d]/i.test(String(list.status || "")) ? "early" : "broken",
    places };

  const reserves = all.filter(e => e.section === "reserve" && !isWithdrawn(e));
  const mineRes = reserves.findIndex(e => normPerson(e.name) === normPerson(p.name));
  const mineResNo = mineRes >= 0 ? resNumber(reserves[mineRes], mineRes) : 0;

  const me = { name: p.name, mine: true, ranked: false, s: FIELD_MIN };
  const mineRow = main.find(e => normPerson(e.name) === normPerson(p.name));
  if(mineRow){ mineRow.mine = true; }
  else {
    const own = (rankingsFor(p.gender) || []).find(r => normPerson(r.name) === normPerson(p.name));
    if(own){ me.ranked = true; me.rank = own.rank; me.played = own.played; me.s = strengthOf(own); }
    else { const sc = playedScenario(p); me.s = Math.max(sc.played > 0 ? sc.checkedPts / sc.played : sc.avg, FIELD_MIN); me.derived = true; }
    main.push(me);
  }
  main.sort((a, b) => b.s - a.s);
  main.forEach((e, i) => { e.pos = i + 1; });
  return { entrants: main, places, draw: nextPow2(Math.max(places, 2)),
           mine: main.find(e => e.mine),
           // 0 when he holds a place, his published queue number when he does not.
           mineReserve: mineResNo,
           listed: !!mineRow || mineRes >= 0,
           reserves: reserves.length,
           unrated: main.filter(e => !e.ranked).length,
           // Once the seeds are out, the bracket is no longer ours to guess.
           seeded: main.some(e => e.seedLo != null) };
}

function pWin(a, b){
  const x = Math.pow(a, fieldK), y = Math.pow(b, fieldK);
  return (x + y) <= 0 ? 0.5 : x / (x + y);
}
// Your figure wins over the model's for matches you are in — it is your
// judgement, so the upset dial does not touch it. Matches between two other
// players stay with the model, since you have no view on those.
function matchP(a, b){
  if(a.mine && b.myP != null) return b.myP;
  if(b.mine && a.myP != null) return 1 - a.myP;
  return pWin(a.s, b.s);
}

// Ten thousand draws is overkill for a 32 field; four is inside a point either way.
// Where everyone stands in the bracket for one run.
//
// Before the seeds are published there is nothing to read, so the model does what
// the tournament will do: seed by strength, top to bottom. That is the old
// behaviour and it is kept exactly.
//
// Once the seeds ARE published the bracket stops being ours to guess. A player
// seeded 7 sits in seed 7's slot every run. A player seeded 9/16 takes a free
// number inside that band at random, because that is what the draw itself does.
// Everyone unseeded lands in a free slot at random — so the run where you draw
// the top seed in the first round and the run where you get a kind quarter both
// happen, in the proportion the draw would actually give them.
function placeDraw(field, slotOfSeed){
  const draw = field.draw;
  const slots = new Array(draw).fill(null);
  const inDraw = field.entrants.filter(e => e.pos <= draw);

  if(!field.seeded){                                  // no seeds out yet
    inDraw.forEach(e => { const s = slotOfSeed.get(e.pos); if(s != null) slots[s] = e; });
    return slots;
  }

  const free = new Set();
  for(let k = 1; k <= draw; k++) free.add(k);
  const banded = [], loose = [];

  inDraw.forEach(e => {
    if(e.seedLo != null && e.seedLo === e.seedHi && free.has(e.seedLo)){
      slots[slotOfSeed.get(e.seedLo)] = e; free.delete(e.seedLo);
    } else if(e.seedLo != null) banded.push(e);
    else loose.push(e);
  });

  banded.forEach(e => {
    const opts = [];
    for(let k = e.seedLo; k <= Math.min(e.seedHi, draw); k++) if(free.has(k)) opts.push(k);
    if(!opts.length){ loose.push(e); return; }
    const k = opts[(Math.random() * opts.length) | 0];
    slots[slotOfSeed.get(k)] = e; free.delete(k);
  });

  const rest = Array.from(free);
  for(let i = rest.length - 1; i > 0; i--){          // Fisher-Yates
    const jx = (Math.random() * (i + 1)) | 0;
    const t = rest[i]; rest[i] = rest[jx]; rest[jx] = t;
  }
  loose.forEach((e, i) => { const k = rest[i]; if(k != null) slots[slotOfSeed.get(k)] = e; });
  return slots;
}

function simulate(field, size, runs = SIM_RUNS){
  const draw = field.draw;
  const order = seedOrder(draw);
  const slotOfSeed = new Map();
  order.forEach((seed, i) => slotOfSeed.set(seed, i));
  // A seeded draw is redrawn every run, so this is only a presence check.
  if(!placeDraw(field, slotOfSeed).some(x => x && x.mine)) return null;
  const bands = {};
  for(let run = 0; run < runs; run++){
    let alive = placeDraw(field, slotOfSeed);
    while(alive.length > 1){
      const next = [];
      for(let i = 0; i < alive.length; i += 2){
        const a = alive[i], b = alive[i + 1];
        if(!a && !b){ next.push(null); continue; }
        if(!a || !b){ next.push(a || b); continue; }
        const aWins = Math.random() < matchP(a, b);
        const w = aWins ? a : b, l = aWins ? b : a;
        if(l.mine) bands[alive.length] = (bands[alive.length] || 0) + 1;
        next.push(w);
      }
      alive = next;
      if(!alive.some(x => x && x.mine)) break;
    }
    if(alive.length === 1 && alive[0] && alive[0].mine) bands[1] = (bands[1] || 0) + 1;
  }
  const out = Object.entries(bands).map(([n, c]) => ({ n: +n, c, p: c / runs, pts: bandPoints(size, +n) }))
    .sort((a, b) => a.n - b.n);
  const expected = out.reduce((s, r) => s + r.p * r.pts, 0);
  const likely = out.slice().sort((a, b) => b.c - a.c)[0] || null;
  return { bands: out, expected, likely };
}

/* ---------- the qualifying draw ---------- */
// Until now an event with qualifying was valued as though you were already in
// the main draw, which is the most expensive thing the model could get wrong:
// it is exactly where "a bigger event has a higher floor" stops being true. The
// floor at a Diamond beats a Copper only from the main draw. From qualifying you
// might play one match for 70 points and fly home.
//
// Nothing here is guessed. How many rounds a qualifying draw has is read off the
// points table PSA publishes for it — "Round 1, Semi-final, Final, Qualifier
// (Winner)" is three matches to come through — so the model never has to invent
// how many qualifying places an event offers. Where an event publishes no table,
// there is no ladder and the tournament is reported as unvalued rather than
// valued wrongly.
function qualLadder(qp){
  if(!qp || typeof qp !== "object") return null;
  const rungs = Object.keys(qp)
    .map(label => ({ label, pts: Number(qp[label]) }))
    .filter(r => Number.isFinite(r.pts))
    .sort((a, b) => a.pts - b.pts);      // the further you go, the more you get
  if(rungs.length < 2) return null;
  // The top rung is coming through; every rung below it is where you lost.
  return { losses: rungs.slice(0, -1), win: rungs[rungs.length - 1], rounds: rungs.length - 1 };
}

// The qualifying field, with you in it. Same strength model as the main draw —
// it is the same players on the same evidence.
function buildQualField(list, p){
  const idx = rankingIndex(p.gender);
  const odds = p.odds || {};
  const q = (list.entries || []).filter(e => e.section === "qualifying").map(e => rateEntry(e, idx, odds));
  const mine = q.find(e => normPerson(e.name) === normPerson(p.name));
  if(!mine) return null;
  mine.mine = true;
  q.sort((a, b) => b.s - a.s);
  q.forEach((e, i) => { e.pos = i + 1; });
  return { entrants: q, mine };
}

// One qualifying mini-bracket: you and 2^rounds − 1 others, drawn at random from
// the rest of the qualifying field. Returns how often you came through and what
// the losses were worth on average.
function simulateQual(qfield, ladder, runs = SIM_RUNS){
  const size = Math.pow(2, ladder.rounds);
  const others = qfield.entrants.filter(e => !e.mine);
  if(!others.length) return null;
  let through = 0, lost = 0;
  for(let run = 0; run < runs; run++){
    // A fresh set of opponents each run — the kind draw and the brutal one both
    // happen, in the proportion the draw would actually give them.
    const pool = others.slice();
    const field = [qfield.mine];
    for(let i = 1; i < size && pool.length; i++){
      field.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    for(let i = field.length; i < size; i++) field.push(null);      // a bye
    // Shuffle so your own position in the bracket is not fixed.
    for(let i = field.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [field[i], field[j]] = [field[j], field[i]];
    }
    let alive = field, round = 0, out = false;
    while(alive.length > 1){
      const next = [];
      for(let i = 0; i < alive.length; i += 2){
        const a = alive[i], b = alive[i + 1];
        if(!a && !b){ next.push(null); continue; }
        if(!a || !b){ next.push(a || b); continue; }
        const aWins = Math.random() < matchP(a, b);
        const w = aWins ? a : b, l = aWins ? b : a;
        if(l.mine){ lost += (ladder.losses[round] || ladder.losses[0]).pts; out = true; }
        next.push(w);
      }
      alive = next; round++;
      if(out) break;
    }
    if(!out) through++;
  }
  const pThrough = through / runs;
  return {
    size, rounds: ladder.rounds, pThrough,
    // The average points banked from the qualifying draw alone, across all runs.
    lostPts: lost / runs,
    ladder,
  };
}

// One decimal, or an em dash. Defined once: it was declared identically inside
// two render functions and then needed by a third place that could see neither.
const money = v => v == null ? "\u2014" : fmtN(Math.round(v * 10) / 10);

/* ---------- the recommendation ---------- */
// The popup computed the upside, the downside and the long-run average and then
// left you to do the arithmetic. This answers the question you actually came
// with: should I play this one?
//
// Three answers only, and "Depends" is a real answer rather than a hedge — it is
// what honesty requires when the field is not final, or when the week genuinely
// turns on one or two matches you know more about than the model does.
//
// The spine is not the points. It is how much your *average* moves, because past
// fifteen played the divisor rises and a decent result can still cost you. That
// is computed the only honest way: score your season with this event in it, score
// it without, and take the difference.
const REC_GOOD = 1.5;    // average points gained that make it clearly worth a week
const REC_BAD = -0.25;   // below this it is actively pulling you down

function recommend(row, p, a){
  if(!a || !a.sim) return null;
  const when = dnum(row.end || row.start);
  if(when == null) return null;

  const hist = histRows(p).map(h => ({ d: h.d, pts: h.pts, incl: h.use !== false }));
  const rk = rankingsFor(p.gender);
  const without = scenario(hist.slice(), rk, when);
  const withIt = scenario(hist.concat([{ d: row.d, pts: a.sim.expected, incl: true }]), rk, when);
  const lift = withIt.avg - without.avg;
  const rankMove = (without.rank != null && withIt.rank != null) ? without.rank - withIt.rank : null;

  // The matches that actually decide the week: opponents you could plausibly
  // meet whose result is close to a coin toss. Those are the ones where your own
  // opinion is worth more than the model's.
  const meS = a.field.mine ? a.field.mine.s : FIELD_MIN;
  const swing = a.field.entrants
    .filter(e => !e.mine && e.pos <= a.field.places && e.ranked)
    .map(e => ({ name: e.name, pos: e.pos, pW: e.myP != null ? e.myP : pWin(meS, e.s) }))
    .filter(e => e.pW >= 0.35 && e.pW <= 0.65)
    .sort((x, y) => Math.abs(x.pW - 0.5) - Math.abs(y.pW - 0.5))
    .slice(0, 3);

  const fin = a.finality;
  const mine = a.field.mine;
  const yourOdds = a.field.entrants.filter(e => e.myP != null).length;

  // The verdict.
  let verdict, why;
  if(a.qualUnvalued){
    verdict = "Depends";
    why = "You are in the qualifying draw and this event has not published what its qualifying rounds pay, so there is no honest number to put on it.";
  } else if(fin && fin.state !== "final"){
    // Never a confident yes or no on a field that is still filling up.
    verdict = lift <= REC_BAD ? "No" : "Depends";
    why = lift <= REC_BAD
      ? `Even as the field stands now, this would take ${money(-lift)} off your average — and the field is only going to get stronger, so the answer will not improve.`
      : `On the field as it stands this is worth ${money(lift)} of average, but ${fin.label}. The players still to enter are usually the stronger ones, so this number is the optimistic end of the range. Come back when entries close.`;
  } else if(lift <= REC_BAD){
    verdict = "No";
    why = `Playing it would take about ${money(-lift)} off your average. ${without.played >= 15
      ? `You are on ${without.played} played, so every extra event raises your divisor — a week that does not beat your average actively costs you.`
      : `Your expected finish here is below what you already average.`}`;
  } else if(lift >= REC_GOOD){
    verdict = "Yes";
    why = `Worth about ${money(lift)} of average${rankMove ? `, roughly ${rankMove} place${Math.abs(rankMove) === 1 ? "" : "s"}` : ""}. ${
      swing.length ? `That already assumes you lose some of the close ones — it is not a best case.` : `The field is within reach of your level.`}`;
  } else {
    verdict = "Depends";
    why = swing.length
      ? `It moves your average by ${money(lift)} — too little to be obvious either way. It turns on ${swing.length === 1 ? "one match" : "a couple of matches"} the model calls a coin toss: ${swing.map(s => esc(s.name)).join(", ")}. If you think you beat ${swing.length === 1 ? "him" : "them"}, this is a yes.`
      : `It moves your average by only ${money(lift)}. Nothing here is wrong with it; there is just not much in it.`;
  }

  return { verdict, why, lift, rankMove, swing, finality: fin, yourOdds,
           played: without.played, divisor: without.divisor };
}

/* ---------- how final a field is ---------- */
// Yuri's warning, and it is the sharpest thing anyone has said about this model:
//
//   "A draw six months out — people haven't entered yet. It's far from final.
//    So it can be a weak draw, a FALSE weak."
//
// Everything the tool says about a field — its level, your seeding, the
// AdvisorScore, and above all any sentence comparing one event to another — is
// only as real as the entry list behind it. An event whose entries are still open
// will fill up, and it fills from the top: the strong players enter late because
// they are deciding between options. So an early list is not a weak field, it is
// an *unfinished* one, and reading it as weak is how you end up flying to a
// tournament that turned into something else by the time it was played.
//
// PSA publishes what we need: the list's own status says "Entries Closed" or
// "Entries Close <date>". That, plus how full the draw is, is the whole signal.
// Where it says entries are still open, the tool says so and softens what it
// claims — it never quietly presents an unfinished field as a finished one.
const FILLING_DAYS = 56;     // beyond this, an open list has barely started

// "Entries Close Oct 20" carries no year, and the year is not always the
// tournament's: an event in the first days of January closes the December
// before. So the date is read against the tournament's own start and pulled back
// a year if it lands after it.
//
// The entry deadline matters more than it looks. PSA sets the field on the
// ranking list current when entries close, not on the day the first ball is
// struck, and the two are about seven weeks apart — long enough for a ranking to
// move. Anything that asks "would I be in this draw" has to ask it on this date.
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
function closeDate(txt, startD){
  const t = String(txt || "").toLowerCase();
  const m = t.match(/(\d{1,2})\s*([a-z]{3,})|([a-z]{3,})\s*(\d{1,2})/);
  if(!m) return null;
  const dayStr = m[1] || m[4], monStr = (m[2] || m[3] || "").slice(0, 3);
  const mon = MONTHS.indexOf(monStr);
  const day = parseInt(dayStr, 10);
  if(mon < 0 || !Number.isFinite(day)) return null;
  const yr = t.match(/\b(20\d\d)\b/);
  const startY = startD != null
    ? new Date(startD * 86400000).getUTCFullYear() : new Date().getUTCFullYear();
  let d = dnum(`${yr ? yr[1] : startY}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  if(d == null) return null;
  if(!yr && startD != null && d > startD) d = dnum(`${startY - 1}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  return d;
}

function fieldFinality(list, row){
  const status = String((list && list.status) || "");
  const days = row && row.d != null ? row.d - todayN() : null;
  // A tournament that has started, or finished, is not "still taking entries".
  // Only the literal "Entries Closed" used to count as final, so an event being
  // played right now was described as a field that could still gain players, and
  // carried the provisional mark into the Plan tab.
  const closed = /entries\s*closed|in\s*play|complet|finish/i.test(status)
    || (days != null && days <= 0);
  // "Entries Close Oct 20" carries the date the door shuts.
  const m = status.match(/entries?\s*close[sd]?\s+(.+)$/i);
  const closesOn = (!closed && m) ? m[1].trim() : null;
  const closesD = closesOn ? closeDate(closesOn, row && row.d) : null;
  const closesIn = closesD != null ? closesD - todayN() : null;

  if(closed) return { state: "final", closed: true, days, closesOn: null, closesD: null, closesIn: null,
    label: "entries closed",
    note: "Entries are closed, so this is the field — give or take the withdrawals." };

  if(days != null && days > FILLING_DAYS) return { state: "early", closed: false, days, closesOn, closesD, closesIn,
    label: "entries still open",
    note: `Entries do not close for a while${closesOn ? ` (${esc(closesOn)})` : ""} and this event is ${Math.round(days / 7)} weeks away, so most of the field has not entered yet. Read the names below as a start, not as the draw — late entries are usually the stronger players, deciding between options.` };

  return { state: "filling", closed: false, days, closesOn, closesD, closesIn,
    label: "entries still open",
    note: `Entries are still open${closesOn ? ` until ${esc(closesOn)}` : ""}${closesIn != null && closesIn >= 0 ? ` \u2014 ${closesIn} day${closesIn === 1 ? "" : "s"} left to enter` : ""}, so this field can still gain players — and the ones who enter late tend to be the stronger ones. The field is set on the ranking list current at that deadline, not on the day the tournament starts.` };
}

// Comparing two fields is only honest when both are finished. One closed list
// against one that is still filling is not a comparison, it is a head start.
function comparableFields(a, b){
  return !!(a && b && a.state === "final" && b.state === "final");
}

/* ---------- a reserve place you have decided to travel for ---------- */
// Yuri's rule: either you play or you don't. So a reserve place is never worth a
// fraction of a tournament — it is worth nothing if you stay home, and worth a
// real draw if you go and get in.
//
// This is the second of those. If you come off the reserves it is because
// someone above you pulled out, so the field you would actually play is not the
// published one: it is the draw with its weakest direct entrant gone and you in
// that slot. Valuing it with the published field would count a player who is no
// longer there and quietly undervalue the week.
function buildReserveField(list, p){
  const f = buildField(list, p);
  if(!f || !f.mine) return null;
  if(!f.mineReserve && f.mine.pos <= f.places) return null;   // already in the draw
  // Clone: buildField's result is cached, and renumbering its entrants in place
  // would corrupt every later reading of the same tournament.
  const others = f.entrants.filter(e => !e.mine).slice(0, f.places - 1).map(e => Object.assign({}, e));
  const me = Object.assign({}, f.mine);
  const entrants = others.concat([me]).sort((a, b) => b.s - a.s);
  entrants.forEach((e, i) => { e.pos = i + 1; });
  return { entrants, places: f.places, draw: f.draw, mine: entrants.find(e => e.mine),
           mineReserve: 0, unrated: f.unrated, seeded: f.seeded };
}

// Chalk: no upsets. With standard seeding the top two make the final, the top
// four the semis, the top eight the quarters — so your seed alone tells you
// where you land if the draw goes to form.
function chalkFinish(field, size){
  if(!field.mine) return null;
  // PSA's own number first. Only when the player is on neither list does the
  // model estimate where he would land, and then the test is against the places
  // that exist rather than the bracket they sit in.
  if(field.mineReserve) return { reserve: field.mineReserve, pts: 0, label: null };
  const seed = field.mine.pos;
  if(seed > field.places) return { reserve: seed - field.places, pts: 0, label: null };
  const band = nextPow2(seed);
  return { band, pts: bandPoints(size, band), label: bandLabel(band), reserve: 0 };
}

function fieldSummary(field){
  const others = field.entrants.filter(e => !e.mine);
  const sorted = others.slice().sort((a, b) => b.s - a.s);
  const mean = arr => arr.length ? arr.reduce((t, e) => t + e.s, 0) / arr.length : 0;
  return {
    n: others.length,
    mean: mean(sorted),
    top8: mean(sorted.slice(0, 8)),
    strongest: sorted[0] || null,
    above: field.mine ? others.filter(e => e.s > field.mine.s).length : null,
    unrated: field.unrated,
  };
}

// Everything about one tournament, from every angle we have. Cached, because the
// Planner asks for a hundred of these on every redraw.
const fieldCache = new Map();
function analyse(row, p, runs){
  const list = matchList(row, p.gender);
  if(!list) return null;
  const key = [list.tournament_slug, list.division_id, p.id, p.gender, fieldBasis, fieldK, row.size, runs].join("|");
  if(fieldCache.has(key)) return fieldCache.get(key);
  const field = buildField(list, p);
  if(!field || field.thin) return field && field.thin
    ? { unreadable: field.why, places: field.places, list } : null;
  const out = {
    list, field,
    finality: fieldFinality(list, row),
    summary: fieldSummary(field),
    chalk: chalkFinish(field, row.size),
    sim: simulate(field, row.size, runs),
    yours: ownPts(row),
    captured: list.captured_at,
  };

  // If the entry list puts you in the qualifying draw, the main-draw simulation
  // above is not what entering is worth — it is what entering is worth *if you
  // get through*. The two are combined here: the points the qualifying rounds
  // themselves pay, plus the main draw discounted by how often you reach it.
  const qf = buildQualField(list, p);
  if(qf){
    const ladder = qualLadder(list.qual_points);
    out.mustQualify = true;
    out.qual = ladder ? simulateQual(qf, ladder, runs) : null;
    out.qualField = qf;
    if(out.qual && out.sim){
      out.mainSim = out.sim;      // kept: it is still the answer to "if I qualify"
      out.sim = {
        bands: out.sim.bands.map(b => Object.assign({}, b, { p: b.p * out.qual.pThrough })),
        expected: out.qual.lostPts + out.qual.pThrough * out.sim.expected,
        likely: out.sim.likely,
        throughQualifying: true,
      };
    } else if(!ladder){
      // No published qualifying points means no honest way to value the rounds
      // you would actually be playing. Saying so beats quoting a main-draw number
      // you have to come through three matches to reach.
      out.mainSim = out.sim;
      out.sim = null;
      out.qualUnvalued = true;
    }
  }

  // On the reserve list: what the week would be worth if you travelled and got
  // in. Not a discounted value — the full value of a draw you actually played.
  // Whether to take that gamble is the player's call, asked on the Plan tab.
  if(out.chalk && out.chalk.reserve){
    const rf = buildReserveField(list, p);
    out.ifPromoted = rf ? simulate(rf, row.size, runs) : null;
  }

  fieldCache.set(key, out);
  return out;
}
function clearFieldCache(){ fieldCache.clear(); }

/* ---------- the field, in full ---------- */
// Seeding in a real draw follows the world ranking, so this is his place in the
// field the way a tournament director would list it.
const ordinal = n => n + (["th","st","nd","rd"][(n % 100 - n % 10 !== 10) * (n % 10 < 4) * n % 10] || "th");
function placeByRanking(field){
  const list = field.entrants.slice().sort((a, b) =>
    (a.rank == null ? 1e9 : a.rank) - (b.rank == null ? 1e9 : b.rank));
  return list.findIndex(e => e.mine) + 1;
}
const placeByStrength = field => (field.entrants.find(e => e.mine) || {}).pos || 0;


const DETAIL_RUNS = 8000;
function analyseBoth(row, p, runs){
  const keep = fieldBasis;
  fieldBasis = "honest";  const honest = analyse(row, p, runs);
  fieldBasis = "official"; const official = analyse(row, p, runs);
  fieldBasis = keep;
  return { honest, official };
}
const bandShort = n => ({1:"W", 2:"F", 4:"SF", 8:"QF", 16:"R16", 32:"R32", 64:"R64"})[n] || ("L" + n);
const roundShort = label => { const m = String(label || "").match(/\((\d+)\)/); return m ? bandShort(+m[1]) : null; };
function bandName(n){
  return { 1: "Winner", 2: "Final", 4: "Semi-final", 8: "Quarter-final",
           16: "Round of 16", 32: "Round of 32", 64: "Round of 64" }[n] || ("last " + n);
}
function fieldModal(row, p){
  const both = analyseBoth(row, p, DETAIL_RUNS);
  const a = both[fieldBasis === "official" ? "official" : "honest"];
  if(!a || a.unreadable) return;
  const other = both[fieldBasis === "official" ? "honest" : "official"];
  const su = a.summary, mine = a.field.mine;

  // Every card that talks about a result says the same three things in the same
  // order: the points with their unit attached, then the round it came from and
  // how you got there. Same shape on every card, so the row compares down a column.
  const pair = (round, pts, note) =>
    `<b>${money(pts)}<u>pts</u></b><span class="sub"><em>${round}</em>${note ? ` · ${note}` : ""}</span>`;

  const chalk = a.chalk && a.chalk.reserve
    ? `<b>Reserve #${a.chalk.reserve}</b><span class="sub">outside the draw</span>`
    : a.chalk ? pair(bandShort(a.chalk.band), a.chalk.pts, `seed ${mine.pos}`) : `<b>—</b><span></span>`;
  const like = a.sim && a.sim.likely
    ? pair(bandShort(a.sim.likely.n), a.sim.likely.pts,
           `<span class="pct">${Math.round(a.sim.likely.p * 100)}% of the time</span>`)
    : `<b>—</b><span class="sub">not in the draw</span>`;
  // The score keeps its decimal even when it lands on a whole number: it is an
  // average of many draws, and a bare "40" reads like a result rather than one.
  const exp = a.sim
    ? `<b>${a.sim.expected.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}<u>pts</u></b><span class="sub">long-run average</span>`
    : `<b>—</b><span></span>`;
  // Explaining this one with its own numbers beats any fixed definition: you can
  // watch the average being built out of the outcomes it averages.
  const expTip = a.sim ? (() => {
    const top = a.sim.bands.slice().sort((x, y) => y.p - x.p).filter(b => b.p >= 0.01).slice(0, 5);
    const lines = top.map(b => { const n = Math.round(b.p * 100);
      return `• ${n} ${n === 1 ? "ends" : "end"} at ${bandShort(b.n)} — ${money(b.pts)} pts`; });
    const rest = 100 - top.reduce((t, b) => t + Math.round(b.p * 100), 0);
    if(rest > 0) lines.push(`• ${rest} ${rest === 1 ? "finishes" : "finish"} somewhere else`);
    return `Played 100 times:\n${lines.join("\n")}\n→ ${money(a.sim.expected)} points on average`;
  })() : "";
  // The label has to come from wherever the points came from.
  //
  // pointsFor reads three sources in order — the exact result set on this row,
  // a range set on this row, then your default for the category — but the label
  // used to read only the third. So a row where you had set "17/32" showed the
  // 33 points that came from it under the round from your Settings default:
  // "33 pts, R16", when R16 at that level is 54. Two right numbers, wrong pair.
  const yours = (() => {
    if(row.exact){
      const s = roundShort(row.exact);
      return pair(s || row.exact, a.yours, "the result you set here");
    }
    if(row.rfrom && row.rto){
      const from = roundShort(row.rfrom), to = roundShort(row.rto);
      return pair(from && to ? `${from}–${to}` : "range", a.yours, "the range you set here");
    }
    // Nothing set on this row, so this falls back to the category default in
    // Settings. Shown, and labelled as the category rather than as this event —
    // it is the same figure for every tournament of this size.
    const def = roundShort(p.perf && p.perf[row.size]);
    const dv = pointsFor(row, p.perf);
    return def ? pair(def, dv, `your default for any ${esc(row.size)}`)
      : `<b>—</b><span class="sub">nothing set here or in Settings</span>`;
  })();
  const meStr = mine ? mine.s : 0;
  const strength = `<b>${money(su.mean)}</b><span class="sub">you ${money(meStr)}</span>`;

  // Seeding follows the world ranking, the model follows raw strength; where they
  // disagree is worth knowing, but it belongs in the header rather than a card.
  const byRank = placeByRanking(a.field);
  const byStr = placeByStrength((both.honest || a).field);
  const placeNote = mine
    ? ` · <span data-tip="seat">you seed ${ordinal(byRank)}, ${ordinal(byStr)} by strength</span>`
      + (byStr + 2 < byRank ? " — underrated here" : byRank + 2 < byStr ? " — flattered here" : "")
    : "";

  const dist = a.sim ? a.sim.bands.slice().sort((x, y) => x.n - y.n).map(b =>
    `<div class="distrow${a.sim.likely && b.n === a.sim.likely.n ? " top" : ""}"><span class="dn">${bandName(b.n)}</span><i style="width:${Math.max(1, b.p * 100)}%"></i>`
    + `<span class="dp">${(b.p * 100).toFixed(b.p < 0.1 ? 1 : 0)}%</span><span class="dpts">${money(b.pts)}</span></div>`).join("") : "";

  const gap = (a.sim && other && other.sim) ? a.sim.expected - other.sim.expected : null;

  const meS = mine ? mine.s : FIELD_MIN;
  const rowsHtml = a.field.entrants.map(e => {
    const model = e.mine ? null : Math.round(pWin(meS, e.s) * 100);
    return `<tr class="${e.mine ? "me" : ""}${e.pos > a.field.places ? " out" : ""}">
      <td class="r num">${e.pos}</td>
      <td>${esc(e.name)}${e.mine ? " <b>(you)</b>" : ""}${e.nat ? ` <span class="na">${esc(e.nat)}</span>` : ""}</td>
      <td class="r num">${e.rank == null ? `<span class="na">unrated</span>` : "#" + e.rank}</td>
      <td class="r num">${e.ranked ? money(e.s) : `<span class="na">—</span>`}</td>
      <td class="r num">${e.mine ? "" : `<span class="${e.myP != null ? "na" : ""}">${model}%</span>`}</td>
      <td class="r">${e.mine ? "" : `<input class="oddsin${e.myP != null ? " set" : ""}" type="number" min="0" max="100" step="1"
        data-odds="${esc(e.key)}" value="${e.myP != null ? Math.round(e.myP * 100) : ""}" placeholder="${model}" aria-label="Your chance against ${esc(e.name)}">`}</td>
    </tr>`; }).join("");

  // The answer to the question you opened this with. It sits above the numbers
  // rather than below them, because the numbers are the working and this is the
  // conclusion — and it carries its own reasoning on hover rather than making
  // you reconstruct it from five cards.
  const rec = recommend(row, p, a);
  const recTip = rec ? [
    rec.why,
    "",
    `Worth ${money(a.sim ? a.sim.expected : 0)} points in the long run; that moves your average by ${money(rec.lift)}${rec.rankMove ? ` and your rank by about ${rec.rankMove}` : ""}.`,
    `You are on ${rec.played} played with a divisor of ${rec.divisor}.`,
    rec.finality && rec.finality.state !== "final" ? "" : null,
    rec.finality && rec.finality.state !== "final" ? rec.finality.note.replace(/<[^>]+>/g, "") : null,
    rec.swing.length ? "" : null,
    rec.swing.length ? `Coin tosses in your path: ${rec.swing.map(x => `${x.name} (${Math.round(x.pW * 100)}%)`).join(", ")}. Type your own number against them in the table below and this answer changes.` : null,
    rec.yourOdds ? `` : null,
    rec.yourOdds ? `${rec.yourOdds} of these are already your own figures, not the model's.` : null,
    "",
    `Read on the ${fieldBasis === "official" ? "official" : "raw"} average — switch the basis in Settings and this can change.`,
  ].filter(x => x !== null).join("\n") : "";
  const recBlock = rec ? `<div class="rec rec-${rec.verdict.toLowerCase()}" data-tip="advrec" data-tiptitle="Advisor recommendation" data-tiptext="${esc(recTip)}">
      <span class="rq">Play it?</span><b>${rec.verdict}</b><span class="rw">${rec.why}</span>
    </div>` : "";
  // Not a second box. The recommendation above already draws the conclusion —
  // "this is the optimistic end of the range" — and repeating it underneath in
  // its own panel was the same warning twice on one screen.
  //
  // What the recommendation does not carry is the two plain facts: when entries
  // close, and how far out the event is. Those belong in the factual line with
  // the draw size and the seeding, as a clause rather than a panel.
  // The deadline is the number to act on, not the tournament date: the field is
  // set on the ranking list current when entries close, and that is the day the
  // decision is actually taken away from you.
  const finFact = a.finality && a.finality.state !== "final"
    ? ` \u00b7 <span class="prov" data-tip="finality">entries still open${a.finality.closesOn ? ` until ${esc(a.finality.closesOn)}` : ""}${
        a.finality.closesIn != null && a.finality.closesIn >= 0
          ? ` \u2014 <b>${a.finality.closesIn === 0 ? "today" : a.finality.closesIn === 1 ? "1 day left to enter" : a.finality.closesIn + " days left to enter"}</b>`
          : a.finality.days != null && a.finality.days > 21 ? `, ${Math.round(a.finality.days / 7)} weeks out` : ""}</span>`
    : "";

  modal(`<h2>${esc(row.name)}</h2>
    <p>${esc(row.size)} · ${fmtD(row.d)} → ${fmtD(dnum(row.end || row.start))} · ${esc(row.location)} · draw of ${a.field.places}${a.field.reserves ? `, ${a.field.reserves} on the reserve list` : ""}, ${su.n} entered${placeNote}.
       Entry list captured ${a.captured ? new Date(a.captured).toLocaleDateString() : "—"}${finFact}.</p>
    ${recBlock}
    <div class="methods">
      <div class="mth"><span class="eyebrow" data-tip="chalk">No upsets</span>${chalk}</div>
      <div class="mth feature"><span class="eyebrow" data-tip="likely">Most likely</span>${like}</div>
      <div class="mth hero"><span class="eyebrow name" data-tip="expected" data-tiptitle="AdvisorScore" data-tiptext="${esc(expTip)}">AdvisorScore</span>${exp}</div>
      <div class="mth"><span class="eyebrow" data-tip="yourest">Your estimate</span>${yours}</div>
      <div class="mth"><span class="eyebrow" data-tip="fieldstr">Field level</span>${strength}</div>
    </div>
    ${gap == null ? "" : `<p class="basisnote">On ${fieldBasis === "official" ? "official" : "raw"} averages this reads ${money(a.sim.expected)}; on ${fieldBasis === "official" ? "raw" : "official"} it reads ${money(other.sim.expected)}.
      ${Math.abs(gap) < 1 ? "The two agree, so the field's ranking reflects its consistency." :
        gap > 0 ? "The field is ranked above its consistency — beatable." : "The field is more consistent than its ranking suggests."}</p>`}
    <h3>How far you get</h3>
    <div class="dist">${dist || `<span class="na">You are not in the draw.</span>`}</div>
    <h3>The field</h3>
    <p class="hint">Type your own chance of beating anyone in the last column. It replaces the model for that player, is remembered against them wherever they enter next, and is not touched by the upset dial. Clear the box to hand them back to the model.</p>
    <div class="twrap" style="max-height:320px"><table class="mini fieldtbl"><thead><tr>
      <th class="r">#</th><th>Player</th><th class="r">Rank</th><th class="r" data-tip="strength">Strength</th>
      <th class="r" data-tip="modelp">Model</th>
      <th class="r" data-tip="yourp">You win %</th>
    </tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="fmClose">Close</button></div>`, "wide");
  $("#fmClose").addEventListener("click", () => { $("#modalRoot").innerHTML = ""; });
  // Open the player table on your own row — in a draw of 32 you are rarely near
  // the top of it.
  //
  // Not with scrollIntoView. That scrolls every scrollable ancestor, so it
  // dragged the modal itself and the page behind it down too: the dialog opened
  // already scrolled past its own title, and you had to scroll back up to read
  // what tournament you were even looking at. Only the table's own wrapper
  // should move, so its scrollTop is set directly.
  const meRow = document.querySelector("table.fieldtbl tr.me");
  const wrap = meRow && meRow.closest(".twrap");
  if(meRow && wrap){
    wrap.scrollTop = Math.max(0, meRow.offsetTop - (wrap.clientHeight - meRow.offsetHeight) / 2);
  }
  // And the dialog itself always opens at its top, whatever was on screen before.
  const box = $("#modalRoot .modal");
  if(box) box.scrollTop = 0;
  const tbl = document.querySelector("table.fieldtbl");
  if(tbl) tbl.addEventListener("change", ev => {
    const inp = ev.target.closest("[data-odds]"); if(!inp) return;
    const ent = a.field.entrants.find(x => x.key === inp.dataset.odds); if(!ent) return;
    const raw = inp.value.trim();
    const pct = raw === "" ? null : Math.min(100, Math.max(0, Number(raw)));
    setOdds(p, ent, pct == null ? null : pct / 100);
    fieldModal(row, p);          // redraw with the new number folded in
  });
}

// Entry lists arrive from the extension; pull them once per session.
async function loadEntryLists(){
  if(fields.tried) return; fields.tried = true;
  const sb = supa(); if(!sb) return;
  try {
    const rows = []; const PAGE = 200;
    for(let from = 0; ; from += PAGE){
      // qual_points was missing from this list, so every qualifying draw came
      // back unvaluable however carefully the extension had captured its points
      // table. The order matters too: Postgres gives no stable row order across
      // LIMIT/OFFSET without one, so pages could silently repeat and skip.
      const r = await sb.from("entry_lists")
        .select("tournament_slug,division_id,tournament_name,division_name,level,start_date,end_date,status,entries,qual_points,captured_at")
        .order("tournament_slug", { ascending: true })
        .order("division_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if(r.error) throw r.error;
      rows.push(...r.data);
      if(r.data.length < PAGE) break;
    }
    fields.lists = rows;
    render();
  } catch(e){ console.warn("entry lists:", e && e.message); }
}

/* ---------- the recommender ---------- */
// The objective is the ranking average on a chosen date, not points won. Those
// are different questions: once you are past fifteen played the divisor rises,
// so a result you did not need costs you more than the points it brought.
//
// The arithmetic behind that, worth stating because it is the whole model:
// adding an (n+1)th result changes the average from best11/11 to best12/12 only
// when n reaches 15. That helps exactly when the twelfth-best result is worth at
// least your current average. Below sixteen played the divisor is frozen at 11,
// so another tournament can only displace a worse one — it never costs you
// anything. Below eleven played the gap is filled with zeros, so everything helps.

const PLAN_RUNS = 1200;
const PLAN_HORIZON = 365;      // default target: a year out
const PLAN_PASSES = 6;         // local search rounds before we call it settled

// What a tournament is projected to be worth, on one of the three readings.
// Returns null when you would not be in the draw at all.
// What the schedule builder is allowed to believe an event is worth, best source
// first: a simulation of a real captured entry list, then an estimate typed on
// that row, then the default for the category from Settings.
//
// The third source is the weakest by a distance and the row says so, because it
// is one figure applied to every event of a size. Yuri's figures also run higher
// than the fields we have measured — 202.5 at Silver against 150.5 and 163.4
// measured — so an event valued this way tends to look better than the ones we
// actually know about. Ranked below both of the others, kept because a blank is
// worse: it drops the event out of the schedule entirely.
const ownOrDefault = row => row.own != null ? row.own : row.pts;
const fromDefault = row => row.own == null;
function planValue(row, p, basis, taken){
  if(basis === "mine") return { value: ownOrDefault(row), reserve: 0, fromDefault: fromDefault(row) };
  const keep = fieldBasis;
  fieldBasis = (basis === "official") ? "official" : "honest";
  let a = null;
  try { a = analyse(row, p, PLAN_RUNS); } finally { fieldBasis = keep; }
  // No entry list captured yet: his figure for this event, or his category default.
  if(!a || a.unreadable) return { value: ownOrDefault(row), reserve: 0, fromDefault: fromDefault(row) };
  // A qualifying place is a place — unlike a reserve spot you can book the
  // flight — so it goes in the schedule, at what qualifying is actually worth.
  if(a.sim) return { value: a.sim.expected, reserve: 0, qualifying: !!a.mustQualify };
  // In qualifying, but the event publishes no qualifying points. Quoting the
  // main draw would be a lie by three matches, and quoting the category default
  // no better, so it is left out of the schedule and reported as unvalued.
  if(a.qualUnvalued) return { value: null, reserve: 0, qualUnvalued: true };
  // A reserve place. If the player has said he would travel for this one, it
  // enters the schedule at what the draw is worth once he is in it — a whole
  // tournament, because there is no half-playing. If he has not said so, it
  // stays out entirely. The model never splits the difference.
  if(a.chalk && a.chalk.reserve){
    if(!taken) return { value: null, reserve: a.chalk.reserve };
    return a.ifPromoted
      ? { value: a.ifPromoted.expected, reserve: a.chalk.reserve, promoted: true }
      : { value: ownOrDefault(row), reserve: a.chalk.reserve, promoted: true,
          fromDefault: fromDefault(row) };
  }
  return { value: ownOrDefault(row), reserve: 0, fromDefault: fromDefault(row) };
}

const planEnd = r => dnum(r.end || r.start);
// Two events overlap if you would have to be in both places at once. A tight
// turnaround is legal and flagged later, not forbidden here.
const planOverlap = (a, b) => a.d <= planEnd(b) && b.d <= planEnd(a);
// The recommender's own tightness test, on the same travel-aware gap as the
// Planner's clash warnings — two events three days apart on opposite sides of
// the world should not be scheduled together just because a flat three-day rule
// said they fit.
const planTight = (a, b, p) => !planOverlap(a, b)
  && Math.min(Math.abs(a.d - planEnd(b)), Math.abs(b.d - planEnd(a)))
     <= (p ? clashGap(a, b, p) : CLASH_GAP);

// Where a set of choices would leave you on the target date. Everything already
// played still counts if it is inside the 365 days before that date; `scenario`
// handles the window, the divisor and the ranking lookup.
function planScore(p, chosen, to){
  const hist = histRows(p).map(h => ({ d: h.d, pts: h.pts, incl: h.use !== false }));
  const mine = chosen.map(c => ({ d: c.d, pts: c.value, incl: true }));
  const s = scenario(hist.concat(mine), rankingsFor(p.gender), to);
  // `scenario` marks each item counting / in-window in place, so the caller can
  // ask which of the chosen events actually reached the counting set.
  s.chosen = mine;
  return s;
}

// What ranking actually gets into each category, learned rather than assumed.
//
// The guess this replaces — "the biggest event you have played, plus one" — is
// evidence about you, not about the tour. The entry lists are evidence about the
// tour: every captured main draw names the worst-ranked player who got in, and
// that is the entry cut for that week. Gather them by category and you have a
// number with a date and a sample size behind it.
//
// Read it as a floor on generosity, not a hard line. If someone ranked 312 made
// a Copper main draw, then 312 was good enough that week. Wildcards and the
// odd promoted reserve make it generous, which is the right direction for a
// filter that decides what you are allowed to consider.
// A wildcard is a gift, a qualifier came through the qualifying draw, a lucky
// loser got in on the day and a protected ranking is an injury return. None of
// them got in on their world ranking, so none of them says anything about the
// cut — and a single wildcard is exactly the kind of outlier that would make a
// category look wide open when it is not.
// LOCAL joined these on 16 Sep, from a real list: the PSA Sekwoja Open 6K 2025
// gave two of its 24 places to local entries with no world ranking at all, on
// top of two more players whose ranking was "Not Set". Four places out of
// twenty-four never went to the rankings, which is the denominator the entry
// chance has to divide by.
const DIRECT_RE = /^(WC|Q|LL|PROTECTED|LOCAL)$/;
const directEntry = e => !(e.flags || []).some(f => DIRECT_RE.test(String(f).toUpperCase()));

// A restricted event is not evidence about the open tour. A territory event that
// only Canadians may enter has a field drawn from one country, so the worst
// player in its main draw says nothing about what ranking gets into a Copper
// anywhere else — and the live data bears that out: the Nash Cup's worst direct
// entry is world 412, far below any open Copper. Since the calendar capture
// flags restricted draws, those lists can now be left out of the cut entirely
// rather than dragging every category's cut down with them.
function restrictedLists(gender){
  const out = new Set();
  schedule().filter(s => s.restricted && (s.gender === gender || s.gender === "MW"))
    .forEach(s => { const L = matchList(s, gender); if(L) out.add(L.tournament_slug + "|" + L.division_id); });
  return out;
}

function entryCuts(gender){
  const want = gender === "W" ? "women" : "men";
  const skip = restrictedLists(gender);
  const by = {};
  (fields.lists || []).forEach(L => {
    if((L.division_name || "").toLowerCase().indexOf(want) !== 0) return;
    if(skip.has(L.tournament_slug + "|" + L.division_id)) return;
    const size = levelForGender(L.level, gender);
    if(!size || SIZES.indexOf(size) < 0) return;
    // Qualifiers are not main-draw entrants. Before the entry list was sectioned
    // properly they were counted as though they were, which read the Egyptian
    // Open's Diamond cut as world 390 instead of 294.
    const main = (L.entries || []).filter(e => e.section === "main" && e.wr != null && directEntry(e));
    if(main.length < 4) return;                    // too thin to mean anything
    const worst = Math.max.apply(null, main.map(e => Number(e.wr)));
    (by[size] = by[size] || []).push({ worst, n: main.length, when: L.start_date, name: L.tournament_name });
  });
  const out = {};
  Object.keys(by).forEach(size => {
    const rows = by[size].slice().sort((a, b) => a.worst - b.worst);
    // The median, not the mean: one wildcard-stuffed week should not move it.
    const mid = rows[Math.floor((rows.length - 1) / 2)];
    out[size] = { cut: mid.worst, lists: rows.length,
                  low: rows[0].worst, high: rows[rows.length - 1].worst, sample: rows };
  });
  return out;
}

// A place on the reserve list is not a closed door. Between entries closing and
// the first ball there are withdrawals, and the reserves move up — so the useful
// question is not "am I in" but "how far up the list am I, and how many usually
// drop out here". The captured lists answer the second half: every one carries a
// withdrawn section.
function withdrawalStats(gender){
  const want = gender === "W" ? "women" : "men";
  const by = {};
  (fields.lists || []).forEach(L => {
    if((L.division_name || "").toLowerCase().indexOf(want) !== 0) return;
    const size = levelForGender(L.level, gender);
    if(!size || SIZES.indexOf(size) < 0) return;
    const out = (L.entries || []).filter(e => e.section === "withdrawn").length;
    (by[size] = by[size] || []).push(out);
  });
  const stats = {};
  Object.keys(by).forEach(size => {
    const rows = by[size].slice().sort((a, b) => a - b);
    stats[size] = { lists: rows.length, counts: rows,
                    median: rows[Math.floor((rows.length - 1) / 2)],
                    most: rows[rows.length - 1] };
  });
  return stats;
}
// The useful number is not a probability, it is a high-water mark: how far down
// the reserve list the promotions have actually reached at this level. If four
// players withdrew, reserves #1 to #4 got in, so the deepest across the captured
// weeks is the deepest anyone has come in from.
function reserveOdds(stats, size, n){
  const s = stats[size];
  if(!s || !s.lists) return null;
  return { deepest: s.most, lists: s.lists, reach: n <= s.most, short: n - s.most };
}

// Your own ranking, as the cut has to see it: your PSA ranking if you have it,
// otherwise wherever the projection currently puts you.
function myRank(p){
  if(p.card && p.card.rank) return Number(p.card.rank);
  const s = playedScenario(p);
  return s.rank == null ? null : s.rank;
}

// How high and how low it is worth looking.
//
// The floor is the Planner's existing one: a category where winning would still
// not beat your average is a week spent standing still.
//
// The ceiling is the harder one, and it is a guess by construction — but only
// where it has to be. Entry to the big draws is by ranking cut, and the schedule
// says nothing about where that cut falls, so without a ceiling the recommender
// happily books you into the U.S. Open. Your own record is the only evidence
// there is: the biggest event you have actually been in, plus one step up.
//
// Where an entry list HAS been captured the guess is not needed at all, and
// `planPool` waives it. The list plus the draw size answers the question
// outright: sort the entrants by strength, take the first power of two, and
// either you are in it or you are reserve #3. Measured beats assumed, so a
// captured Platinum you would actually make the draw of stays in the running,
// and a Copper you would miss drops out.
function planReach(p){
  const f = floorInfo(p);

  // Best evidence first: the captured entry lists say what ranking got in at
  // each category. The highest category whose cut reaches you is the ceiling,
  // and every category below it is presumed open — a Copper that let in 312
  // tells you nothing about the Bronze above it, but it does not shut it either.
  const cuts = entryCuts(p.gender);
  const rank = myRank(p);
  let learned = -1, evidence = null;
  if(rank != null){
    SIZES.forEach((s, i) => { const c = cuts[s];
      if(c && rank <= c.cut && i > learned){ learned = i; evidence = { size: s, cut: c.cut, lists: c.lists }; }; });
  }

  // Fallback: evidence about you rather than about the tour — the biggest event
  // you have actually been in, plus one step.
  const seen = (p.played || []).map(h => SIZES.indexOf(h.size)).filter(i => i >= 0);
  const auto = seen.length ? Math.min(SIZES.length - 1, Math.max.apply(null, seen) + 1) : SIZES.length - 1;

  const base = learned >= 0 ? Math.max(learned, auto) : auto;
  const set = (p.plan && p.plan.ceiling) ? SIZES.indexOf(p.plan.ceiling) : -1;
  return { floor: (f.active && f.size) ? SIZES.indexOf(f.size) : 0,
           ceil: set >= 0 ? set : base, auto: SIZES[base],
           source: learned >= 0 && learned >= auto ? "lists" : "record",
           evidence, cuts, rank };
}

// Everything you could enter between two dates, valued on one reading. Returns
// the ones worth considering plus a count of what was ruled out and why, since
// "nothing good in March" and "we could not see March" are different answers.
function planPool(p, from, to, basis, taken){
  const reach = planReach(p);
  const pr = planPrefs(p);
  const out = [], outside = [];
  let measured = 0, assumed = 0, defaulted = 0, provisional = 0, barred = 0;
  pool(p).forEach(r => {
    if(r.d == null || r.d < from || r.d > to) return;
    if(r.restricted || /cancel|postpon|complete/i.test(r.status || "")) return;
    if(!regionOk(pr, r.continent)){ barred++; return; }
    const lst = matchList(r, p.gender);
    const listed = !!lst;
    const i = SIZES.indexOf(r.size);
    if(i < reach.floor) return;
    if(!listed && i > reach.ceil) return;      // the guess, used only where it must be
    const { value, reserve, qualifying, qualUnvalued, promoted, fromDefault } = planValue(r, p, basis, !!(taken && taken[r.id]));
    // A reserve place cannot be planned on, so it stays out of the schedule —
    // but it is not a rejection either, and the tab lists it separately. The
    // same goes for a qualifying draw whose points this event never published.
    if(value == null){ outside.push(Object.assign({}, r, { reserve, qualUnvalued })); return; }
    if(listed) measured++; else if(fromDefault) defaulted++; else assumed++;
    // How finished the field is travels with the row. The Plan tab is where the
    // schedule actually gets built, so this is where it matters most: a draw six
    // months out with entries still open is not a weak field, it is an
    // unfinished one, and the value below it will move.
    const finality = lst ? fieldFinality(lst, r) : null;
    if(finality && finality.state !== "final") provisional++;
    out.push(Object.assign({}, r, { value, listed, finality, fromDefault,
      provisional: !!(finality && finality.state !== "final"),
      qualifying, promoted, travel: planTierOf(p, r) }));
  });
  out.outside = outside;
  out.measured = measured;
  out.assumed = assumed;
  out.defaulted = defaulted;
  out.provisional = provisional;
  out.barred = barred;
  return out;
}

// Greedy by value, then swap and drop passes. Greedy alone is wrong in two ways
// this fixes: one fat event can block two better ones, and a commitment you
// already made can be worth dropping once the divisor starts moving.

// Add whatever still improves the average, best-valued first, until nothing does.
// Travel, without knowing what a flight costs.
//
// Yuri's argument, and it is airtight: if two schedules land you in the same
// place and one of them crosses the planet twice, you do not need a fare table to
// know which is better. So this is a tiebreak, never a price. The load is the sum
// of the travel tiers already on the Planner — 1 for your own region, 5 for the
// far side of the world — and it only speaks when the averages are level.
const planLoad = chosen => Math.round(chosen.reduce((s, x) => s + (x.travel || 0), 0));
// The load is the right thing to optimise and the wrong thing to show: "travel
// 26" is not a number anyone can feel. Trips and long hauls are.
const LONG_TIER = 4;
const planLong = chosen => chosen.filter(x => (x.travel || 0) >= LONG_TIER).length;
// Seven events on the schedule have no location announced yet. Their tier is 0,
// and counting that as 0 would make "somewhere, to be confirmed" the cheapest
// trip on the tour — so an unknown place is charged your average trip instead,
// which neither rewards nor punishes it.
function planTierOf(p, r){
  if(r.tier) return r.tier;
  const row = (p.matrix && p.matrix[p.home]) || [];
  const known = row.filter(v => v > 0);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : 3;
}
// "Level" has to mean something: half a percent of the average, so a schedule
// worth 0.2 more is a tie and one worth 3 more simply wins.
const planTol = (avg, travel) => travel ? Math.max(0.25, Math.abs(avg) * 0.005) : 1e-9;

function planBetter(a, b, travel){
  const tol = planTol(Math.max(a.avg, b.avg), travel);
  if(a.avg > b.avg + tol) return true;
  if(b.avg > a.avg + tol) return false;
  return travel ? a.load < b.load : false;
}
const planState = (p, chosen, to) => ({ chosen, avg: planScore(p, chosen, to).avg, load: planLoad(chosen) });

function planFill(p, chosen, rank, to, travel, from){
  let cur = from || planState(p, chosen.slice(), to);
  for(let guard = 0; guard < PLAN_PASSES; guard++){
    let moved = false;
    // Two sweeps: everything that fits with enough rest for the hop involved,
    // then the rest. With equal-valued candidates this is the only thing standing
    // between you and a year of back-to-back flights.
    for(const tolerate of [false, true]){
      for(const c of rank){
        if(cur.chosen.indexOf(c) >= 0 || cur.chosen.some(x => planOverlap(x, c))) continue;
        if(!tolerate && cur.chosen.some(x => planTight(x, c, p))) continue;
        const t = planState(p, cur.chosen.concat([c]), to);
        if(planBetter(t, cur, travel)){ cur = t; moved = true; }
      }
    }
    if(!moved) break;
  }
  return cur;
}

function planOptimise(p, locked, free, to, travel){
  const rank = free.slice().sort((a, b) => b.value - a.value);
  let cur = planFill(p, locked.slice(), rank, to, travel);

  for(let pass = 0; pass < PLAN_PASSES; pass++){
    let moved = false;

    // Swap: drop everything one candidate collides with, put it in, then refill.
    // The refill is the point — a fat event often blocks two smaller ones that
    // together beat it, and no one-for-one swap can ever see that.
    for(const c of rank){
      if(cur.chosen.indexOf(c) >= 0) continue;
      if(cur.chosen.some(x => x.locked && planOverlap(x, c))) continue;
      const blockers = cur.chosen.filter(x => planOverlap(x, c));
      if(!blockers.length) continue;
      const t = planFill(p, cur.chosen.filter(x => blockers.indexOf(x) < 0).concat([c]), rank, to, travel);
      if(planBetter(t, cur, travel)){ cur = t; moved = true; }
    }

    // Drop: past fifteen played, a result you did not need costs more than it
    // brings — and with travel weighed, a trip that buys nothing goes too.
    // Refilling here would only undo the drop, so it happens next pass.
    for(const x of cur.chosen.slice()){
      if(x.locked) continue;
      const t = planState(p, cur.chosen.filter(y => y !== x), to);
      if(planBetter(t, cur, travel)){ cur = t; moved = true; }
    }

    if(!moved) break;
    cur = planFill(p, cur.chosen, rank, to, travel, cur);
  }

  const chosen = cur.chosen.slice().sort((a, b) => a.d - b.d);
  const tight = [];
  for(let i = 0; i < chosen.length - 1; i++)
    if(planTight(chosen[i], chosen[i + 1], p)) tight.push([chosen[i], chosen[i + 1]]);
  return { chosen, tight, load: planLoad(chosen), score: planScore(p, chosen, to) };
}

// The two answers he asked for side by side: the best schedule that keeps the
// promises you have already made, and the best one if you were free.
function planBoth(p, opts){
  const from = opts && opts.from != null ? opts.from : todayN();
  const to = opts && opts.to != null ? opts.to : todayN() + PLAN_HORIZON;
  const basis = (opts && opts.basis) || "honest";

  const cands = planPool(p, from, to, basis, (opts && opts.taken) || null);
  const committed = cands.filter(r => r.enter === "Yes");
  const locked = committed.map(r => Object.assign({}, r, { locked: true }));
  const lockedIds = new Set(locked.map(r => r.id));

  const travel = !!(opts && opts.travel);
  return {
    from, to, basis, travel,
    pool: cands,
    committed,
    keep: planOptimise(p, locked, cands.filter(r => !lockedIds.has(r.id)), to, travel),
    free: planOptimise(p, [], cands, to, travel),
    now: planScore(p, committed.map(r => Object.assign({}, r)), to),
  };
}

/* ---------- field model settings ---------- */
const LS_FIELD = "psa-field-model";
function loadFieldPrefs(){
  try { const o = JSON.parse(localStorage.getItem(LS_FIELD) || "{}");
    if(o.basis === "honest" || o.basis === "official") fieldBasis = o.basis;
    if(o.k >= 1 && o.k <= 3) fieldK = o.k;
  } catch(e){}
}
function saveFieldPrefs(){ try { localStorage.setItem(LS_FIELD, JSON.stringify({ basis: fieldBasis, k: fieldK })); } catch(e){} }
function renderBasisSeg(){
  const seg = $("#basisSeg"); if(!seg) return;
  seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.b === fieldBasis));
}
function setBasis(v){ fieldBasis = v; saveFieldPrefs(); clearFieldCache(); renderFieldPrefs(); render(); }
function renderFieldPrefs(){
  const b = $("#fBasis"), k = $("#fK"), m = $("#fKMsg");
  if(!b || !k) return;
  b.value = fieldBasis; k.value = fieldK;
  // Anchor the dial to something you can actually judge: a player with twice
  // your average should beat you how often?
  const twice = Math.pow(2, fieldK) / (Math.pow(2, fieldK) + 1);
  if(m) m.textContent = `k = ${fieldK.toFixed(1)} — someone with double your average wins ${Math.round(twice * 100)}% of the time. Equal averages are always 50/50.`;
}

/* ---------- events ---------- */
function bind(){
  loadFieldPrefs(); setupIntros(); watchPin(); bindTips(); bindSyncBridge();
  $("#tabs").addEventListener("click", e => { const b = e.target.closest(".tab"); if(!b) return; state.tab = b.dataset.tab; document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t === b)); document.querySelectorAll(".panel").forEach(pn => pn.classList.toggle("active", pn.id === "panel-" + state.tab)); render(); pinVisibility(); });
  // plan tab
  const planTo = $("#planTo");
  if(planTo) planTo.addEventListener("change", e => { const p = P(); planPrefs(p).to = e.target.value; savePlayer(p); renderPlan(); });
  const planCeil = $("#planCeil");
  if(planCeil) planCeil.addEventListener("change", e => { const p = P(); planPrefs(p).ceiling = e.target.value; savePlayer(p); renderPlan(); });
  const planTravel = $("#planTravel");
  if(planTravel) planTravel.addEventListener("change", e => { const p = P(); planPrefs(p).travel = e.target.checked; savePlayer(p); renderPlan(); });
  // Where you may enter. The same control the Planner filters with, doing a
  // different job: the filter hides rows, this one takes them out of the pool
  // the schedule is built from. A saved choice, not a view.
  const planRegions = $("#planRegions");
  if(planRegions) planRegions.addEventListener("change", e => {
    if(e.target.type !== "checkbox") return;
    const p = P(), pr = planPrefs(p);
    pr.regions = Array.from(planRegions.querySelectorAll(".menu input"))
      .filter(i => i.checked).map(i => i.value);
    savePlayer(p); renderPlan();
  });
  if(planRegions) planRegions.addEventListener("click", e => {
    if(!e.target.classList || !e.target.classList.contains("clear")) return;
    const p = P(); planPrefs(p).regions = []; savePlayer(p); renderPlan();
  });
  // The basis strip is rebuilt with each run, so its handler is bound there.
  $("#playerSel").addEventListener("change", e => { state.active = e.target.value; rememberActive(); render(); });
  $("#emptyNewBtn").addEventListener("click", newPlayerModal);
  $("#newPlayerBtn").addEventListener("click", newPlayerModal);
  // planner filters
  $("#pSearch").addEventListener("input", e => { state.filters.q = e.target.value; renderPlanner(); });
  $("#fEnter").addEventListener("change", e => { state.filters.enter = e.target.value; renderPlanner(); });
  [["fCont","cont"],["fSize","size"]].forEach(([id,k]) => {
    const el = $("#"+id);
    el.addEventListener("change", e => { if(e.target.type !== "checkbox") return;
      const v = e.target.value, cur = state.filters[k];
      state.filters[k] = e.target.checked ? cur.concat(v) : cur.filter(x => x !== v);
      renderPlanner(); });
    el.addEventListener("click", e => { if(!e.target.classList.contains("clear")) return;
      state.filters[k] = []; el.open = false; renderPlanner(); });
  });
  const cols = $("#fCols");
  if(cols){
    cols.addEventListener("change", e => { if(e.target.type === "checkbox") toggleCol(P(), e.target.value, e.target.checked); });
    cols.addEventListener("click", e => { if(!e.target.classList.contains("clear")) return;
      const p = P(); p.cols = { hidden: [] }; savePlayer(p); cols.open = false; renderPlanner(); });
  }
  // Click anywhere else and any open filter menu closes.
  document.addEventListener("click", e => {
    document.querySelectorAll("details.multi[open]").forEach(d => { if(!d.contains(e.target)) d.open = false; });
  });
  [["fFrom","from"],["fTo","to"]].forEach(([id,k]) => { const el = $("#"+id); if(el) el.addEventListener("change", e => { state.filters[k] = e.target.value; renderPlanner(); }); });
  const datesClear = $("#fDatesClear");
  if(datesClear) datesClear.addEventListener("click", () => { state.filters.from = ""; state.filters.to = ""; $("#fFrom").value = ""; $("#fTo").value = ""; renderPlanner(); });
  const ptbl = $("#plannerTbl");
  if(ptbl) ptbl.addEventListener("click", e => { const th = e.target.closest("th[data-sort]"); if(th) setSort(th.dataset.sort); });
  [["fFloor","floor"],["fPast","past"],["fRestricted","restricted"]].forEach(([id,k]) => $("#"+id).addEventListener("change", e => { state.filters[k] = e.target.checked; renderPlanner(); }));
  $("#addCustomBtn").addEventListener("click", customModal);
  $("#plannerTbl").addEventListener("change", e => { const tr = e.target.closest("tr"); if(!tr) return; const p = P(), id = tr.dataset.id, k = e.target.dataset.k; if(!k) return;
    const custom = p.custom.find(c => c.id === id); if(k === "size" && custom){ custom.size = e.target.value; } else { const o = p.planner[id] = p.planner[id] || {}; o[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value; if(k === "enter" && o.enter === "No") delete o.enter; if(!o[k] && k !== "use") delete o[k]; if(!Object.keys(o).length) delete p.planner[id]; }
    savePlayer(p); renderStrip(); if(k === "use" || k === "enter" || k === "size") renderPlanner(); else { const row = pool(p).find(r => r.id === id); tr.querySelector("td.r b").textContent = fmtN(row.pts); } });
  $("#plannerTbl").addEventListener("click", e => {
    const fb = e.target.closest("[data-field]");
    if(fb){ const r = pool(P()).find(x => x.id === fb.dataset.field); if(r) fieldModal(r, P()); return; }
    if(!e.target.dataset.del) return; const p = P(), id = e.target.closest("tr").dataset.id; p.custom = p.custom.filter(c => c.id !== id); delete p.planner[id]; delete p.playedIncl[id]; savePlayer(p); render(); });
  // played
  $("#addPlayedBtn").addEventListener("click", () => { const p = P(); p.played.push({ id: "h" + uid(), date: iso(todayN()), name: "New result", location: "", size: "Challenger 6", enter: "Yes", exact: "", rfrom: "", rto: "", use: true }); savePlayer(p); render(); setTimeout(() => { const last = document.querySelector(`#playedTbl tr[data-id="${p.played[p.played.length-1].id}"] input[data-k=name]`); if(last) last.focus(); }, 0); });
  $("#playedTbl").addEventListener("change", e => { const tr = e.target.closest("tr"); if(!tr || !e.target.dataset.k) return; const p = P(), k = e.target.dataset.k;
    if(tr.dataset.kind === "auto"){ if(k === "incl"){ if(e.target.checked) p.playedIncl[tr.dataset.id] = true; else delete p.playedIncl[tr.dataset.id]; } }
    else { const h = p.played.find(x => x.id === tr.dataset.id); if(!h) return; if(k === "incl") h.use = e.target.checked; else h[k] = e.target.value; }
    savePlayer(p); render(); });
  $("#playedTbl").addEventListener("click", e => { if(!e.target.dataset.del) return; const p = P(), id = e.target.closest("tr").dataset.id; if(!confirm("Remove this result from the history?")) return; p.played = p.played.filter(h => h.id !== id); savePlayer(p); render(); });
  // settings
  const sv = () => { const p = P(); savePlayer(p); renderPlayerSel(); renderStrip(); };
  $("#sName").addEventListener("change", e => { P().name = e.target.value.trim() || P().name; sv(); });
  $("#sGender").addEventListener("change", e => { P().gender = e.target.value; sv(); renderSettings(); });
  $("#sHome").addEventListener("change", e => { P().home = e.target.value; sv(); renderSettings(); });
  $("#sNotes").addEventListener("change", e => { P().notes = e.target.value; sv(); });
  [["cCounting","counting"],["cPlayed","played"],["cAverage","average"],["cRank","rank"],["cDate","date"]].forEach(([id,k]) => $("#"+id).addEventListener("change", e => { const p = P(); p.card = p.card || {}; p.card[k] = k === "date" ? e.target.value : (e.target.value === "" ? null : Number(e.target.value)); sv(); renderSettings(); }));
  $("#perfTbl").addEventListener("change", e => { if(!e.target.dataset.perf) return; P().perf[e.target.dataset.perf] = e.target.value; sv(); renderSettings(); });
  $("#perfAutoBtn").addEventListener("click", () => { const p = P(); p.perf = autoPerf(floorInfo(p).avg); sv(); renderSettings(); toast("Expected rounds derived from the current average"); });
  $("#matrixTbl").addEventListener("change", e => { const f = e.target.dataset.mf; if(!f) return; const v = Math.min(5, Math.max(1, Number(e.target.value) || 1)); P().matrix[f][Number(e.target.dataset.mj)] = v; e.target.value = v; sv(); });
  $("#matrixResetBtn").addEventListener("click", () => { P().matrix = JSON.parse(JSON.stringify(DEFAULT_MATRIX)); sv(); renderSettings(); });
  $("#deletePlayerBtn").addEventListener("click", async () => { const p = P(); if(!confirm(`Delete ${p.name} and all of their data? This cannot be undone.`)) return; await deletePlayer(p.id); state.active = Object.keys(state.players)[0] || null; rememberActive(); render(); });
  $("#xlsxFile").addEventListener("change", e => importXlsx(e.target.files[0], P()));
  $("#exportBtn").addEventListener("click", exportPlayer);
  $("#jsonFile").addEventListener("change", e => { const f = e.target.files[0]; if(!f) return; f.text().then(t => { const p = normalize(JSON.parse(t)); if(!p.name) throw new Error("no name"); p.id = slug(p.name) + "-" + uid().slice(0,4); p.owner = ctx.user.id; state.players[p.id] = p; state.active = p.id; rememberActive(); savePlayer(p); render(); toast(`Imported ${p.name}`); }).catch(() => { $("#dataMsg").innerHTML = `<span class="warn">That file is not a player export from this planner.</span>`; }); e.target.value = ""; });
  $("#schedFile").addEventListener("change", e => importScheduleCsv(e.target.files[0]));
  $("#rankFile").addEventListener("change", e => importRankingsCsv(e.target.files[0]));
  $("#rSearch").addEventListener("input", e => { state.rq = e.target.value; renderRankings(); });
  const fb = $("#fBasis"); if(fb) fb.addEventListener("change", e => setBasis(e.target.value));
  const seg = $("#basisSeg"); if(seg) seg.addEventListener("click", e => { const b = e.target.closest("button"); if(b) setBasis(b.dataset.b); });
  const fk = $("#fK"); if(fk) fk.addEventListener("input", e => { fieldK = Number(e.target.value); renderFieldPrefs(); });
  if(fk) fk.addEventListener("change", () => { saveFieldPrefs(); clearFieldCache(); render(); });
  const revealBtn = $("#tokenRevealBtn");
  if(revealBtn) revealBtn.addEventListener("click", () => { const i = $("#ingestToken"); if(!i) return;
    const hidden = i.type === "password"; i.type = hidden ? "text" : "password"; revealBtn.textContent = hidden ? "Hide" : "Reveal"; });
  const copyBtn = $("#tokenCopyBtn");
  if(copyBtn) copyBtn.addEventListener("click", async () => {
    if(!ingestTokenValue){ $("#tokenMsg").textContent = "No token loaded yet."; return; }
    try { await navigator.clipboard.writeText(ingestTokenValue); toast("Token copied"); $("#tokenMsg").textContent = "Copied. Paste it into the extension."; }
    catch(e){ const i = $("#ingestToken"); if(i){ i.type = "text"; i.focus(); i.select(); } $("#tokenMsg").textContent = "Select the token above and press Ctrl+C."; } });
}
function toast(t){ const el = document.createElement("div"); el.className = "toast"; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 2600); }
function modal(html, cls){ const root = $("#modalRoot"); root.innerHTML = `<div class="modal-bg"><div class="modal ${cls || ""}" role="dialog">${html}</div></div>`; root.querySelector(".modal-bg").addEventListener("click", e => { if(e.target.classList.contains("modal-bg")) root.innerHTML = ""; }); return root; }
function newPlayerModal(){ const root = modal(`<h2>New player</h2><p>Each player gets their own Planner, history, calendar and settings. Where they live decides travel difficulty — ask, don't assume from nationality.</p>
  <div class="form"><label for="npName">Name</label><input id="npName" type="text" placeholder="Full name">
  <label for="npGender">Tour</label><select id="npGender"><option value="M">Men's</option><option value="W">Women's</option></select>
  <label for="npHome">Home region</label><select id="npHome">${selOpts(REGIONS, "Europe")}</select>
  <label>Start from</label><div><label class="chk"><input type="radio" name="npMode" value="blank" checked> Empty — add results on the Played tab</label><br><label class="chk"><input type="radio" name="npMode" value="xlsx"> Import a planner workbook (.xlsx)</label><input type="file" id="npFile" accept=".xlsx" style="margin-top:6px"></div></div>
  <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="npCancel">Cancel</button><button class="btn primary" id="npCreate">Create player</button></div>`);
  $("#npCancel").addEventListener("click", () => root.innerHTML = "");
  $("#npCreate").addEventListener("click", async () => { const name = $("#npName").value.trim(); const file = $("#npFile").files[0]; const mode = root.querySelector("input[name=npMode]:checked").value; if(mode === "xlsx" && !file){ alert("Choose the .xlsx workbook first."); return; } if(!name && mode !== "xlsx"){ $("#npName").focus(); return; }
    const p = newPlayer({ name: name || "Imported player", gender: $("#npGender").value, home: $("#npHome").value }); state.players[p.id] = p; state.active = p.id; rememberActive(); root.innerHTML = ""; if(mode === "xlsx") await importXlsx(file, p, name); else { savePlayer(p); state.tab = "played"; document.querySelector('.tab[data-tab="played"]').click(); } render(); }); }
function customModal(){ const root = modal(`<h2>Add a tournament</h2><p>For an event that is not in the schedule snapshot. It behaves like any other Planner row.</p>
  <div class="form"><label for="ctName">Name</label><input id="ctName" type="text"><label for="ctStart">Start</label><input id="ctStart" type="date" value="${iso(todayN())}"><label for="ctEnd">End</label><input id="ctEnd" type="date"><label for="ctLoc">Location</label><input id="ctLoc" type="text" placeholder="City, Country"><label for="ctCont">Continent</label><select id="ctCont">${selOpts(REGIONS.concat("TBA"), "Europe")}</select><label for="ctSize">Size</label><select id="ctSize">${selOpts(SIZES, "Challenger 6")}</select></div>
  <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="ctCancel">Cancel</button><button class="btn primary" id="ctAdd">Add</button></div>`);
  $("#ctCancel").addEventListener("click", () => root.innerHTML = "");
  $("#ctAdd").addEventListener("click", () => { const name = $("#ctName").value.trim(); if(!name || !$("#ctStart").value){ $("#ctName").focus(); return; } const p = P(); p.custom.push({ id: "c" + uid(), name, start: $("#ctStart").value, end: $("#ctEnd").value || "", location: $("#ctLoc").value.trim() || "TBA", continent: $("#ctCont").value, size: $("#ctSize").value, restricted: false }); savePlayer(p); root.innerHTML = ""; render(); }); }

/* ---------- imports / exports ---------- */
function cellV(ws, addr){ const c = ws[addr]; return c ? c.v : undefined; }
function cellHasFormula(ws, addr){ const c = ws[addr]; return !!(c && c.f); }
let XLSXref = null;
function toIso(v){ if(v instanceof Date) return iso(Math.round((Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())) / 86400000)); if(typeof v === "number"){ const d = XLSXref && XLSXref.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}` : ""; } if(typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10); return ""; }
async function importXlsx(file, p, forcedName){ if(!file) return; const msg = $("#dataMsg");
  try { const XLSX = await import("xlsx"); XLSXref = XLSX; const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true, cellFormula: true });
    const pl = wb.Sheets["Played"], pn = wb.Sheets["Planner"], ps = wb.Sheets["PerfSettings"]; if(!pl || !pn) throw new Error("This workbook has no Planner / Played tabs.");
    const title = String(cellV(pn, "A1") || ""); const m = title.match(/^(.+?)\s+[—-]\s+Tournament Planner/); if(!forcedName && m) p.name = m[1].trim();
    p.played = []; for(let r = 9; r < 400; r++){ const b = cellV(pl, "B" + r); if(b === undefined || b === "" || cellHasFormula(pl, "B" + r)) break; const use = cellV(pl, "R" + r);
      p.played.push({ id: "h" + uid(), date: toIso(b), name: String(cellV(pl, "C" + r) || ""), location: String(cellV(pl, "E" + r) || ""), size: String(cellV(pl, "F" + r) || ""), enter: String(cellV(pl, "G" + r) || "Yes"), exact: String(cellV(pl, "H" + r) || ""), rfrom: String(cellV(pl, "I" + r) || ""), rto: String(cellV(pl, "J" + r) || ""), use: !(use === false || use === "FALSE") }); }
    const byName = {}; schedule().filter(s => s.gender === p.gender || s.gender === "MW").forEach(s => byName[s.name] = s);
    p.planner = {}; p.custom = []; let matched = 0, added = 0;
    for(let r = 9; r < 600; r++){ const b = cellV(pn, "B" + r); const name = cellV(pn, "C" + r); if(b === undefined || b === "" || !name) { if(r > 9) break; else continue; }
      const date = toIso(b); if(!date) break; let s = byName[name]; if(!s){ s = { id: "c" + uid(), name: String(name), start: date, end: "", location: String(cellV(pn, "E" + r) || "TBA"), continent: String(cellV(pn, "D" + r) || "TBA"), size: String(cellV(pn, "F" + r) || "Challenger 6"), restricted: false }; p.custom.push(s); added++; } else matched++;
      const o = {}; const enter = String(cellV(pn, "G" + r) || "No"); if(enter !== "No") o.enter = enter; ["H","I","J"].forEach((col, i) => { const v = cellV(pn, col + r); if(v) o[["exact","rfrom","rto"][i]] = String(v); }); const notes = cellV(pn, "P" + r); if(notes) o.notes = String(notes); const use = cellV(pn, "R" + r); if(use === true || use === "TRUE") o.use = true; if(Object.keys(o).length) p.planner[s.id] = o; }
    if(ps){ for(let r = 5; r <= 18; r++){ const sz = cellV(ps, "A" + r), rd = cellV(ps, "B" + r); if(sz && rd && DATA.points[sz]) p.perf[sz] = String(rd); } const home = cellV(ps, "B23"); if(home && REGIONS.includes(home)) p.home = home;
      for(let r = 28; r <= 34; r++){ const from = cellV(ps, "A" + r); if(REGIONS.includes(from)) p.matrix[from] = "BCDEFGH".split("").map(c => Number(cellV(ps, c + r)) || 3); } }
    const rk = rankingsFor(p.gender); const me = rk && rk.find(x => x.name.toLowerCase() === p.name.toLowerCase()); if(me) p.card = { counting: me.counting, played: me.played, average: me.average, rank: me.rank, date: state.shared.rankingsDate || DATA.rankingsDate };
    savePlayer(p); render(); const t = `Imported ${p.name}: ${p.played.length} results, ${matched} planner rows matched to the schedule, ${added} added as custom rows${me ? ", your ranking filled from the rankings snapshot" : ""}.`; if(msg) msg.textContent = t; toast("Workbook imported");
  } catch(e){ console.warn(e); if(msg) msg.innerHTML = `<span class="warn">Import failed: ${esc(e.message)}</span>`; else alert("Import failed: " + e.message); }
  const fi = $("#xlsxFile"); if(fi) fi.value = ""; }
function exportPlayer(){ const p = P(); const data = JSON.stringify(p, null, 1); const blob = new Blob([data], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = slug(p.name) + "-planner.json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast("Exported"); }
function parseCsv(text){ const rows = []; let row = [], cell = "", q = false; for(let i = 0; i < text.length; i++){ const ch = text[i]; if(q){ if(ch === '"'){ if(text[i+1] === '"'){ cell += '"'; i++; } else q = false; } else cell += ch; } else if(ch === '"') q = true; else if(ch === ","){ row.push(cell); cell = ""; } else if(ch === "\n" || ch === "\r"){ if(ch === "\r" && text[i+1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; } else cell += ch; } if(cell !== "" || row.length){ row.push(cell); rows.push(row); } const head = rows.shift().map(h => h.trim().toLowerCase()); return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()]))); }
async function importScheduleCsv(file){ if(!file) return; const msg = $("#sharedMsg"); if(!ctx.isAdmin){ msg.innerHTML = `<span class="warn">Only an admin can replace the shared schedule.</span>`; $("#schedFile").value = ""; return; } try { const rows = parseCsv(await file.text()); const need = ["start_date","name","level_type","level","gender"]; if(!rows.length || need.some(k => !(k in rows[0]))) throw new Error("Expected the PSA schedule export columns: start_date, end_date, name, city, country, gender, level_type, level, restricted, status.");
    const out = []; rows.forEach(r => { const s = scheduleRow(r); if(s) out.push(s); });
    state.shared.schedule = out; state.shared.scheduleDate = iso(todayN()); await saveSharedKey("schedule"); render(); msg.textContent = `Schedule replaced: ${out.length} World Tour draws. Planner rows keep their settings where the tournament name and gender match.`; } catch(e){ msg.innerHTML = `<span class="warn">${esc(e.message)}</span>`; } $("#schedFile").value = ""; }
async function importRankingsCsv(file){ if(!file) return; const msg = $("#sharedMsg"); if(!ctx.isAdmin){ msg.innerHTML = `<span class="warn">Only an admin can replace the shared rankings.</span>`; $("#rankFile").value = ""; return; } try { const rows = parseCsv(await file.text()); if(!rows.length || !("rank" in rows[0]) || !("average" in rows[0])) throw new Error("Expected columns: rank, name, country, code, total, counting, average, played.");
    const out = rows.map(r => ({ rank: Number(r.rank), name: r.name, country: r.country || "", code: r.code || "", total: Number(r.total) || 0, counting: Number(r.counting) || 0, average: Number(r.average) || 0, played: Number(r.played) || 0 })).filter(r => r.rank);
    const tour = P().gender === "W" ? "rankingsW" : "rankings"; state.shared[tour] = out; state.shared[tour + "Date"] = iso(todayN()); await saveSharedKey(tour); render(); msg.textContent = `${tour === "rankingsW" ? "Women's" : "Men's"} rankings replaced: ${out.length} rows (applied to the ${P().gender === "W" ? "women's" : "men's"} tour because that is the active player's tour).`; } catch(e){ msg.innerHTML = `<span class="warn">${esc(e.message)}</span>`; } $("#rankFile").value = ""; }

/* ---------- mount ---------- */
export async function mountPlanner(context){
  ctx = context; bind();
  $("#whoami").textContent = ctx.user.email + (ctx.isAdmin ? " · admin" : "");
  document.querySelectorAll(".admin-only").forEach(el => { el.hidden = !ctx.isAdmin; });
  try { await loadAll(); setSaveState("Synced"); } catch(e){ console.warn(e); setSaveState("Could not load: " + e.message); }
  render();
  // Anything a previous session could not send is still in this browser. Send it
  // now, after the page is usable — a change made last night should not be lost
  // because the connection dropped for a second while it was being saved.
  flushPending().catch(e => console.warn(e));
  // And try again whenever the browser says the network is back.
  window.addEventListener("online", () => flushPending().catch(e => console.warn(e)));
}
