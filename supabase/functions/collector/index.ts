// Lodge Trip Hub collector: reads every source and saves the readings.
// Called every 30 minutes by a scheduled job that sends the x-collector-token header.
// Add ?dry=1 to read and parse everything without saving (for testing).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "LodgeTripHub (personal, non-commercial)";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const SUGARBUSH = "https://mtnpowder.com/feed?resortId=70";
const MRG = "https://www.madriverglen.com/conditions";
const STAKE = "https://forecast.weather.gov/product.php?site=BTV&issuedby=BTV&product=HYD&format=CI&version=1";
const STAKE_HISTORY = "https://s3.amazonaws.com/matthewparrilla.com/snow-depth.csv";
const NWS = "https://api.weather.gov";

async function fetchText(url: string, accept = "*/*"): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": accept }, signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return text;
}
const fetchJson = async (url: string) => JSON.parse(await fetchText(url, "application/geo+json, application/json"));

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s === "--" || s.toUpperCase() === "N/A") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "--" || s.toUpperCase() === "N/A" ? null : s;
}
function isoFix(s: string | null): string | null {
  if (!s) return null;
  const fixed = s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  return isNaN(Date.parse(fixed)) ? null : new Date(fixed).toISOString();
}
const stripHtml = (h: string) => h.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();

async function sha(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Eastern time label like "November 13, 2026 5:00 AM" -> ISO, using the right offset for that date
function easternToIso(label: string): string | null {
  const m = label.match(/([A-Za-z]+) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)/);
  if (!m) return null;
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const mo = months.indexOf(m[1].toLowerCase());
  if (mo < 0) return null;
  let h = Number(m[4]) % 12; if (m[6] === "PM") h += 12;
  return wallTimeToIso(Number(m[3]), mo, Number(m[2]), h, Number(m[5]));
}
function wallTimeToIso(y: number, mo: number, d: number, h: number, mi: number): string {
  // Try both Eastern offsets and keep the one that maps back to the same wall-clock time in America/New_York
  for (const off of [5, 4]) {
    const t = new Date(Date.UTC(y, mo, d, h + off, mi));
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(t);
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    if (g("day") === d && (g("hour") % 24) === h && g("minute") === mi) return t.toISOString();
  }
  return new Date(Date.UTC(y, mo, d, h + 5, mi)).toISOString();
}

// ---------- Sugarbush ----------
async function readSugarbush() {
  const j = await fetchJson(SUGARBUSH);
  const sr = j.SnowReport ?? {};
  const area = (a: any) => a ? { in24: txt(a.Last24HoursIn), in48: txt(a.Last48HoursIn), in72: txt(a.Last72HoursIn), in7d: txt(a.Last7DaysIn), cm7d: txt(a.Last7DaysCm), baseIn: txt(a.BaseIn) } : null;
  const summit = sr.SummitArea ?? {};
  const lifts: any[] = [];
  for (const a of j.MountainAreas ?? []) for (const l of a.Lifts ?? []) lifts.push({ name: l.Name, status: l.StatusEnglish ?? l.Status, area: l.MountainAreaName ?? a.Name });
  const cc = j.CurrentConditions ?? {};
  // Trails by difficulty. Uphill routes and glades are left out, matching the resort's headline count (111).
  const LEVEL: Record<string, string> = { GreenCircle: "green", BlueSquare: "blue", BlackDiamond: "black", DoubleBlackDiamond: "black" };
  const levels: any = { green: { open: 0, total: 0 }, blue: { open: 0, total: 0 }, black: { open: 0, total: 0 } };
  const seen = new Set<string>();
  for (const a of j.MountainAreas ?? []) for (const t of a.Trails ?? []) {
    const lv = LEVEL[t.TrailIcon]; if (!lv) continue;
    const st = String(t.StatusEnglish ?? t.Status ?? "").toLowerCase(); seen.add(st);
    levels[lv].total++; if (st === "open") levels[lv].open++;
  }
  levels.statuses = [...seen]; // only "closed" seen so far (off-season); re-check the open wording in season
  // Scheduled lift hours by weekday: earliest opening and latest closing across all lifts
  const mins = (s: string) => { const m = String(s ?? "").match(/(\d{1,2}):(\d{2})\s*([AP]M)/i); if (!m) return null; let h = Number(m[1]) % 12; if (m[3].toUpperCase() === "PM") h += 12; return h * 60 + Number(m[2]); };
  const hours: any = {};
  for (const day of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
    let first: any = null, last: any = null;
    for (const a of j.MountainAreas ?? []) for (const l of a.Lifts ?? []) {
      const h = l.Hours?.[day]; if (!h) continue;
      const o = mins(h.Open), c = mins(h.Close);
      if (o != null && (first == null || o < first.m)) first = { m: o, text: h.Open };
      if (c != null && (last == null || c > last.m)) last = { m: c, text: h.Close };
    }
    hours[day] = { first: first?.text ?? null, last: last?.text ?? null };
  }
  return {
    mountain: "sugarbush",
    source_updated_text: txt(sr.LastUpdate) ?? txt(j.LastUpdate),
    source_updated_at: isoFix(txt(sr.LastUpdate) ?? txt(j.LastUpdate)),
    operating_status: txt(j.OperatingStatus),
    trails_open: num(sr.TotalOpenTrails), trails_total: num(sr.TotalTrails),
    lifts_open: num(sr.TotalOpenLifts), lifts_total: num(sr.TotalLifts),
    new_snow_24h_in: num(summit.Last24HoursIn), new_snow_48h_in: num(summit.Last48HoursIn), new_snow_72h_in: num(summit.Last72HoursIn), new_snow_7d_in: num(summit.Last7DaysIn),
    new_snow_text: null,
    season_total_in: num(sr.SeasonTotalIn), season_total_text: txt(sr.SeasonTotalIn),
    base_depth_text: txt(sr.SnowBaseRangeIn),
    surface_primary: txt(sr.BaseConditions), surface_secondary: null,
    base_temp_f: num(cc.Base?.TemperatureF), summit_temp_f: num(cc.Summit?.TemperatureF),
    snow_by_area: { base: area(sr.BaseArea), mid: area(sr.MidMountainArea), summit: area(sr.SummitArea), snowmaking: txt(sr.SnowMakingActive), trailsMakingSnow: num(sr.TotalTrailsMakingSnow) },
    terrain_levels: levels,
    lift_hours: { byWeekday: hours },
    lifts,
    report_text: sr.Report ? stripHtml(String(sr.Report)).slice(0, 3000) : null,
  };
}

// ---------- Mad River Glen ----------
// Status icons: cross.png = closed. The open icon is not known yet (mountain closed during testing),
// so any other icon is stored as "icon:<file name>" until we can see it in season.
const iconStatus = (f: string) => f === "cross.png" ? "closed" : `icon:${f}`;
async function readMrg() {
  const html = await fetchText(MRG, "text/html");
  const plain = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#8243;|&quot;/g, '"').replace(/\s+/g, " ");
  // The page carries an old 2017 block, so every value appears twice: take the first match.
  const first = (re: RegExp) => { const m = plain.match(re); return m ? m[1].trim() : null; };
  const updated = first(/Updated:\s*[A-Za-z]+,? ([A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M)/);
  const stop = "(?=\\s+(?:Current|Secondary:|Primary:|New Snow|Lifts|Trails|Snowfall|Updated|Hours)|$)";

  // Lifts: the table right after the LIFTS heading; each row is a name then a status icon
  const li = html.indexOf("<h4>LIFTS</h4>");
  const liEnd = li < 0 ? -1 : html.indexOf("</table>", li);
  const liftHtml = li < 0 || liEnd < 0 ? "" : html.slice(li, liEnd);
  const lifts = [...liftHtml.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td>\s*<img src="[^"]*\/img\/([^"\/]+)"/g)]
    .map((m) => ({ name: m[1].trim(), kind: "lift", status: iconStatus(m[2]) }));

  // Trails: everything from the TRAILS heading to the next heading; grouped by chairlift,
  // each row has a difficulty symbol, the trail name, a status icon and an optional groomed icon
  const ti = html.indexOf("<h4>TRAILS</h4>");
  const tiEnd = ti < 0 ? -1 : html.indexOf("<h4>", ti + 15);
  const trailHtml = ti < 0 ? "" : html.slice(ti, tiEnd < 0 ? undefined : tiEnd);
  const trails: any[] = [];
  let group: string | null = null;
  for (const m of trailHtml.matchAll(/<th[^>]*>([^<]*)<\/th>|<tr>\s*<td>\s*(?:<img src="[^"]*\/([^"\/]+)"\s*\/?>)?\s*([^<]+?)\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    if (m[3] === undefined) { const t = (m[1] ?? "").trim(); if (t) group = t; continue; }
    const icons = [...m[4].matchAll(/\/img\/([^"\/]+)"/g)].map((x) => x[1]);
    trails.push({ name: m[3].trim(), kind: "trail", group, difficulty: m[2] ? m[2].replace(/\.(gif|png)$/, "") : null, status: icons[0] ? iconStatus(icons[0]) : "unknown", groomed: icons[1] ?? null });
  }

  const newSnow = first(/New Snow:\s*([\d"\s\-–.]+?)(?=\s+[A-Za-z]|$)/);
  const toDate = first(/Snowfall to Date:\s*([\d"\s\-–.]+?)(?=\s+[A-Za-z]|$)/);
  const firstNum = (s: string | null) => { const m = s?.match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
  const lastNum = (s: string | null) => { const all = s?.match(/\d+(\.\d+)?/g); return all ? Number(all[all.length - 1]) : null; };
  return {
    mountain: "mad_river_glen",
    source_updated_text: updated,
    source_updated_at: updated ? easternToIso(updated) : null,
    operating_status: null,
    trails_open: num(first(/Trails Open Today:\s*(\d+)/)), trails_total: trails.length || null,
    lifts_open: num(first(/Lifts Open Today:\s*(\d+)/)), lifts_total: lifts.length || null,
    new_snow_24h_in: lastNum(newSnow), new_snow_48h_in: null, new_snow_72h_in: null, new_snow_7d_in: null,
    new_snow_text: newSnow,
    season_total_in: lastNum(toDate), season_total_text: toDate,
    base_depth_text: null,
    surface_primary: first(new RegExp("Primary:\\s*(.+?)" + stop)), surface_secondary: first(new RegExp("Secondary:\\s*(.+?)" + stop)),
    base_temp_f: num(first(/Current Base Temp:\s*(-?\d+)/)), summit_temp_f: num(first(/Current Summit Temp:\s*(-?\d+)/)),
    snow_by_area: { newSnowLow: firstNum(newSnow), newSnowHigh: lastNum(newSnow) },
    // Trails by difficulty. "Open" here means any icon other than the closed cross (the open icon is unconfirmed until the mountain opens).
    terrain_levels: (() => {
      const lv: any = { green: { open: 0, total: 0 }, blue: { open: 0, total: 0 }, black: { open: 0, total: 0 } };
      const map: Record<string, string> = { greencircle: "green", bluesquare: "blue", blackdiamond: "black", doubleblackdiamond: "black", doubleblack: "black" };
      for (const t of trails) { const k = map[String(t.difficulty ?? "").toLowerCase()]; if (!k) continue; lv[k].total++; if (t.status !== "closed" && t.status !== "unknown") lv[k].open++; }
      return lv;
    })(),
    lift_hours: { today: { first: first(/Lifts Open Today At:\s*([\d:]+(?:\s*[AP]M)?)/i), last: first(/Lifts Close Today At:\s*([\d:]+(?:\s*[AP]M)?)/i) } },
    lifts: [...lifts, ...trails],
    report_text: null,
  };
}

async function saveMountain(row: any) {
  const hash = await sha(JSON.stringify(row));
  const { data: last, error: e1 } = await db.from("mountain_reports").select("id, content_hash").eq("mountain", row.mountain).order("collected_at", { ascending: false }).limit(1).maybeSingle();
  if (e1) throw e1;
  if (last && last.content_hash === hash) {
    const { error } = await db.from("mountain_reports").update({ checked_at: new Date().toISOString() }).eq("id", last.id);
    if (error) throw error;
    return "unchanged";
  }
  const { error } = await db.from("mountain_reports").insert({ ...row, content_hash: hash });
  if (error) throw error;
  return "new row";
}

// ---------- Mount Mansfield stake ----------
async function readStake() {
  const t = await fetchText(STAKE, "text/html");
  const im = t.match(/(\d{3,4}) ([AP]M) (E[SD]T) \w{3} (\w{3}) (\d{1,2}) (\d{4})/);
  const line = (t.match(/^.*Mount Mansfield.*$/m) ?? [null])[0];
  if (!im || !line) throw new Error("Mount Mansfield line or issue time not found");
  const hhmm = im[1].padStart(4, "0");
  let h = Number(hhmm.slice(0, 2)) % 12; if (im[2] === "PM") h += 12;
  const mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const off = im[3] === "EDT" ? 4 : 5;
  const issued_at = new Date(Date.UTC(Number(im[6]), mons.indexOf(im[4]), Number(im[5]), h + off, Number(hhmm.slice(2)))).toISOString();
  const toks = line.trim().split(/\s+/);
  const val = (s: string) => s === "T" ? { v: 0, trace: true } : (s === "M" ? { v: null, trace: false } : { v: num(s), trace: false });
  const ns = val(toks[toks.length - 2]);
  const dp = val(toks[toks.length - 1]);
  return { issued_text: im[0], issued_at, new_snow_in: ns.v, new_snow_trace: ns.trace, depth_in: dp.v, depth_trace: dp.trace, raw_line: line.trim() };
}

// ---------- Stake history file ----------
async function readStakeHistory(dry: boolean) {
  const csv = await fetchText(STAKE_HISTORY, "text/csv");
  const hash = await sha(csv);
  const { data: st } = await db.from("source_state").select("value").eq("key", "stake_history_hash").maybeSingle();
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length);
  const unq = (s: string) => s.trim().replace(/^"|"$/g, "");
  const header = lines[0].split(",").map(unq);
  if (st?.value === hash) return { status: "unchanged", seasons: lines.length - 1 };
  const rows: any[] = [];
  for (const l of lines.slice(1)) {
    const cells = l.split(",").map(unq);
    const season = cells[0];
    for (let i = 1; i < header.length; i++) rows.push({ season, day_index: i - 1, day_label: header[i], depth_in: num(cells[i]) });
  }
  if (dry) return { status: "changed (dry run, not saved)", seasons: lines.length - 1, rows: rows.length };
  for (let i = 0; i < rows.length; i += 2000) {
    const { error } = await db.from("stake_history").upsert(rows.slice(i, i + 2000), { onConflict: "season,day_index" });
    if (error) throw error;
  }
  await db.from("source_state").upsert({ key: "stake_history_hash", value: hash, updated_at: new Date().toISOString() });
  return { status: "saved", seasons: lines.length - 1, rows: rows.length };
}

// ---------- Weather service forecasts ----------
const GRID_KEYS = ["temperature", "windChill", "windSpeed", "windGust", "snowfallAmount", "iceAccumulation", "probabilityOfPrecipitation", "quantitativePrecipitation", "skyCover", "weather"];
async function readForecast(p: any) {
  const base = `${NWS}/gridpoints/${p.office}/${p.grid_x},${p.grid_y}`;
  const [f, g] = await Promise.all([fetchJson(`${base}/forecast`), fetchJson(base)]);
  const periods = (f.properties?.periods ?? []).map((x: any) => ({ name: x.name, start: x.startTime, end: x.endTime, isDaytime: x.isDaytime, temperature: x.temperature, unit: x.temperatureUnit, wind: x.windSpeed, windDir: x.windDirection, pop: x.probabilityOfPrecipitation?.value ?? null, short: x.shortForecast, detailed: x.detailedForecast }));
  const gp = g.properties ?? {};
  const hourly: any = {};
  for (const k of GRID_KEYS) if (gp[k]) hourly[k] = { uom: gp[k].uom ?? null, values: gp[k].values ?? [] };
  return { point_id: p.id, fetched_at: new Date().toISOString(), forecast_updated_at: f.properties?.updateTime ?? null, grid_updated_at: gp.updateTime ?? null, periods, hourly };
}

// ---------- Weather service alerts ----------
async function readAlerts(scope: string, query: string) {
  const j = await fetchJson(`${NWS}/alerts/active?${query}`);
  const alerts = (j.features ?? []).map((f: any) => { const a = f.properties ?? {}; return { id: a.id, event: a.event, severity: a.severity, certainty: a.certainty, urgency: a.urgency, headline: a.headline, area: a.areaDesc, zones: a.affectedZones, onset: a.onset, ends: a.ends, expires: a.expires, description: (a.description ?? "").slice(0, 1500) }; });
  return { scope, fetched_at: new Date().toISOString(), alerts };
}

async function step(results: any, name: string, fn: () => Promise<any>) {
  const t = Date.now();
  try { results[name] = { ok: true, ms: Date.now() - t, ...(await fn()) }; results[name].ms = Date.now() - t; }
  catch (e) { results[name] = { ok: false, ms: Date.now() - t, error: String((e as any)?.message ?? e) }; }
}

Deno.serve(async (req: Request) => {
  const token = req.headers.get("x-collector-token") ?? "";
  const { data: okToken, error: tokErr } = await db.rpc("check_collector_token", { token });
  if (tokErr || okToken !== true) return new Response("Forbidden", { status: 403 });

  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const started = new Date().toISOString();
  const results: any = {};
  const { data: points } = await db.from("weather_points").select("*").order("sort_order");
  const lodge = (points ?? []).find((p: any) => p.id === "lodge");

  await Promise.all([
    step(results, "sugarbush", async () => { const r = await readSugarbush(); return dry ? { parsed: { ...r, lifts: r.lifts.length, report_text: r.report_text?.slice(0, 200) } } : { saved: await saveMountain(r), trails: `${r.trails_open}/${r.trails_total}`, lifts: `${r.lifts_open}/${r.lifts_total}`, updated: r.source_updated_text }; }),
    step(results, "mad_river_glen", async () => { const r = await readMrg(); return dry ? { parsed: { ...r, lifts: r.lifts.slice(0, 8), liftsAndTrails: r.lifts.length, statuses: [...new Set(r.lifts.map((x: any) => x.status))], groups: [...new Set(r.lifts.map((x: any) => x.group).filter(Boolean))] } } : { saved: await saveMountain(r), trails: `${r.trails_open}/${r.trails_total}`, lifts: `${r.lifts_open}/${r.lifts_total}`, updated: r.source_updated_text }; }),
    step(results, "stake", async () => { const r = await readStake(); if (dry) return { parsed: r }; const { error } = await db.from("stake_readings").upsert(r, { onConflict: "issued_text", ignoreDuplicates: true }); if (error) throw error; return { issued: r.issued_text, line: r.raw_line }; }),
    step(results, "stake_history", () => readStakeHistory(dry)),
    ...(points ?? []).map((p: any) => step(results, `forecast_${p.id}`, async () => { const r = await readForecast(p); if (dry) return { periods: r.periods.length, hourlyKeys: Object.keys(r.hourly), first: r.periods[0] }; const { error } = await db.from("forecast_latest").upsert(r); if (error) throw error; return { periods: r.periods.length, updated: r.forecast_updated_at }; })),
    ...[["VT", "area=VT"], ["NY", "area=NY"], ["NJ", "area=NJ"], ...(lodge ? [["lodge", `point=${lodge.lat},${lodge.lon}`]] : [])].map(([scope, q]) => step(results, `alerts_${scope}`, async () => { const r = await readAlerts(scope, q); if (dry) return { count: r.alerts.length, events: r.alerts.map((a: any) => a.event) }; const { error } = await db.from("alerts_latest").upsert(r); if (error) throw error; return { count: r.alerts.length }; })),
  ]);

  const ok = Object.values(results).every((r: any) => r.ok);
  if (!dry) {
    await db.from("collector_runs").insert({ started_at: started, finished_at: new Date().toISOString(), ok, results });
    await db.from("collector_runs").delete().lt("started_at", new Date(Date.now() - 90 * 86400000).toISOString());
  }
  return new Response(JSON.stringify({ ok, dry, results }, null, 1), { headers: { "Content-Type": "application/json" } });
});
