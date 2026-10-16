// Ranking engine — mirrors the workbook formulas exactly. Pure functions, no DOM.
import { DATA } from "./data.js";
export const ROUNDS = DATA.rounds, REGIONS = DATA.regions, SIZES = Object.keys(DATA.points);
export const DEFAULT_MATRIX = {"North America":[1,2,3,3,4,5,5],"Central America":[2,1,2,4,5,5,5],"South America":[3,2,1,4,4,5,5],"Europe":[3,4,4,1,2,3,5],"Africa":[4,5,4,2,1,3,5],"Asia":[4,5,5,3,4,1,3],"Oceania":[4,5,5,4,5,3,1]};
export const $ = (s, el) => (el || document).querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
export const dnum = iso => { if(!iso) return null; const [y,m,d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m-1, d) / 86400000); };
export const iso = n => new Date(n * 86400000).toISOString().slice(0,10);
export const todayN = () => { const t = new Date(); return Math.round(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / 86400000); };
export const fmtD = n => { if(n == null) return ""; const d = new Date(n*86400000); return d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric", timeZone:"UTC"}); };
export const fmtN = (v, dp=2) => (Math.round(v*100)/100).toLocaleString("en-US", {minimumFractionDigits:0, maximumFractionDigits:dp});
export const round2 = v => Math.round(v*100)/100;
export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "player";
export const uid = () => Math.random().toString(36).slice(2, 9);


export function refPts(size, round){ const row = DATA.points[size]; if(!row) return null; const i = ROUNDS.indexOf(round); return i < 0 ? null : row[i]; }
export function pointsFor(r, perf){
  if(!r.size || !DATA.points[r.size]) return 0;
  if(r.exact){ const v = refPts(r.size, r.exact); return v == null ? 0 : v; }
  if(r.rfrom && r.rto){
    const a = ROUNDS.indexOf(r.rfrom), b = ROUNDS.indexOf(r.rto); if(a < 0 || b < 0) return 0;
    const vals = DATA.points[r.size].slice(Math.min(a,b), Math.max(a,b)+1).filter(x => x != null);
    return vals.length ? vals.reduce((s,x) => s+x, 0) / vals.length : 0;
  }
  const v = refPts(r.size, (perf||{})[r.size]); return v == null ? 0 : v;
}
// The same value, but only when the player set it on this tournament — an exact
// round, or a range, entered on that row. The per-category default in Settings is
// deliberately not consulted.
//
// Yuri's rule, and the reason for it: the default made the advice worse than
// useless. A Silver he had never looked at was valued at his Settings figure of
// 202.5 while two Silvers whose real entry lists we had came out at 150 and 163,
// so the schedule builder kept choosing the tournaments it knew nothing about.
// A guess that applies to a whole category is not a reading on any one event.
export function ownPts(r){
  if(!r || !r.size || !DATA.points[r.size]) return null;
  if(r.exact){ const v = refPts(r.size, r.exact); return v == null ? null : v; }
  if(r.rfrom && r.rto){
    const a = ROUNDS.indexOf(r.rfrom), b = ROUNDS.indexOf(r.rto);
    if(a < 0 || b < 0) return null;
    const vals = DATA.points[r.size].slice(Math.min(a,b), Math.max(a,b)+1).filter(x => x != null);
    return vals.length ? vals.reduce((s,x) => s+x, 0) / vals.length : null;
  }
  return null;
}
// The divisor, learned from the published list rather than assumed.
//
// It was `played - 4` above fifteen, taken from the workbook, and it is wrong.
// PSA publishes every player's counting points, average and tournaments played,
// so the divisor each player is actually being given is `counting / average` —
// and across 259 men on the 14 Sep 2026 list it reads:
//
//     played  2..15  ->  11      (229 players)
//     played  16     ->  12      (22)
//     played  17     ->  12      (4)
//     played  18     ->  13      (2)
//     played  19     ->  13      (1)
//     played  21     ->  15      (1)
//
// `played - 4` matches only at 16. At 17 it says 13 where PSA says 12, at 19 it
// says 15 where PSA says 13. It is wrong in the harsh direction, so the tool has
// been overstating what an extra tournament costs — in exactly the range where
// the Plan tab's whole argument lives.
//
// The scale above 17 rests on one or two players a bucket, so rather than fit a
// formula to that, the table is read from whatever ranking list is loaded and
// grows more reliable every time the rankings are captured. Between two observed
// counts it interpolates; past the last one it falls back to the old formula,
// never going below the deepest divisor actually seen.
let DIVISOR_TABLE = null;
export function learnDivisors(rankings){
  const by = new Map();
  (rankings || []).forEach(r => {
    const played = Number(r.played);
    let d = Number(r.divisor);
    if(!Number.isFinite(d) && Number(r.average) > 0) d = Math.round(Number(r.counting) / Number(r.average));
    if(!Number.isFinite(played) || !Number.isFinite(d) || d <= 0) return;
    if(!by.has(played)) by.set(played, new Map());
    const m = by.get(played);
    m.set(d, (m.get(d) || 0) + 1);
  });
  const out = new Map();
  by.forEach((m, played) => {
    let best = null, bn = 0;
    m.forEach((n, d) => { if(n > bn || (n === bn && d < best)){ bn = n; best = d; } });
    out.set(played, best);
  });
  DIVISOR_TABLE = out.size ? out : null;
  return out.size;
}
const divisorGuess = n => n <= 15 ? 11 : n - 4;
export function divisorFor(n){
  if(!DIVISOR_TABLE || !Number.isFinite(n)) return divisorGuess(n);
  const hit = DIVISOR_TABLE.get(n);
  if(hit) return hit;
  let lo = null, hi = null;
  DIVISOR_TABLE.forEach((d, p) => {
    if(p < n && (lo == null || p > lo)) lo = p;
    if(p > n && (hi == null || p < hi)) hi = p;
  });
  if(lo == null) return divisorGuess(n);
  const dLo = DIVISOR_TABLE.get(lo);
  // Past the deepest player on the list, carry on from him at one more per
  // tournament. That is the harshest growth the observed points allow — the
  // slope from 15 to 21 is nearer two-thirds — and harsh is the safe direction
  // here, since the error would otherwise tell you a heavy schedule is cheaper
  // than it is. Never worse than the old formula either.
  if(hi == null) return Math.max(dLo, Math.min(dLo + (n - lo), divisorGuess(n)));
  const dHi = DIVISOR_TABLE.get(hi);
  return Math.round(dLo + (dHi - dLo) * ((n - lo) / (hi - lo)));
}
export function rankPos(avg, rankings){ if(!rankings || !rankings.length) return null; const a = round2(avg); return rankings.filter(r => r.average > a).length + 1; }
// items: [{d (day number|null), pts, incl}] in table order. Ties broken by table order, like the workbook.
export function scenario(items, rankings, asOf){
  // asOf lets callers ask "where would this stand on date X"; defaults to today.
  const today = (asOf == null) ? todayN() : asOf;
  const inclDates = items.filter(i => i.incl && i.d != null).map(i => i.d);
  const end = Math.max(today, ...inclDates), start = end - 364;
  items.forEach(i => { i.inwin = !!(i.incl && i.d != null && i.d >= start && i.d <= end); });
  const inw = items.filter(i => i.inwin);
  inw.forEach((i, idx) => { i.prank = inw.filter(j => j.pts > i.pts).length + inw.slice(0, idx).filter(j => j.pts === i.pts).length + 1; });
  const played = inw.length, divisor = divisorFor(played);
  items.forEach(i => { i.counting = i.inwin && i.prank <= divisor; });
  const total = inw.filter(i => i.prank <= divisor).reduce((s,i) => s + i.pts, 0);
  const avg = divisor ? total / divisor : 0;
  return { start, end, played, divisor, total, avg, rank: rankPos(avg, rankings) };
}
export function autoPerf(avg){ // deepest round whose points <= average; else the last round that exists at that level
  const out = {};
  for(const size of SIZES){ const row = DATA.points[size]; let pick = null;
    for(let i = 0; i < row.length; i++){ if(row[i] != null && row[i] <= avg){ pick = ROUNDS[i]; break; } }
    if(!pick){ for(let i = row.length-1; i >= 0; i--){ if(row[i] != null){ pick = ROUNDS[i]; break; } } }
    out[size] = pick; }
  return out;
}
