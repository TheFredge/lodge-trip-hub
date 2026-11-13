// Lodge Trip Hub: the page's helper. Only signed-in, approved people can call it.
//   action "trips": booked lodge trips from the Skiing calendar's private link (secret SKIING_CALENDAR_ICS)
//   action "drive": live drive time from Towaco plus weather and alerts at checkpoints along the way
//                   (secret GOOGLE_MAPS_KEY; uses Google's traffic-aware routing)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "LodgeTripHub (personal, non-commercial)";
const ORIGIN = "Towaco, NJ 07082";
const DEST = "235 Schuss Pass, Waitsfield, VT 05673";
const KEYWORDS = ["mad river glen", "sugarbush", "lodge"];
const CHECKPOINT_MILES = 45;
const TZ = "America/New_York";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: approved } = await userClient.rpc("is_approved");
  if (approved !== true) return json({ error: "not_approved" }, 403);
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === "trips") return json(await trips());
    if (body.action === "drive") return json(await drive(body.depart ?? null));
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});

// ---------- time helpers (Eastern time) ----------
function etParts(ms: number) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const g = (k: string) => p.find((x) => x.type === k)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24, minute: Number(g("minute")) };
}
function wallTimeToMs(y: number, mo: number, d: number, h: number, mi: number): number {
  for (const off of [5, 4]) {
    const t = Date.UTC(y, mo, d, h + off, mi);
    const p = etParts(t);
    if (p.date === `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` && p.hour === h && p.minute === mi) return t;
  }
  return Date.UTC(y, mo, d, h + 5, mi);
}
const addDays = (date: string, n: number) => { const t = new Date(date + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const weekday = (date: string) => new Date(date + "T12:00:00Z").getUTCDay(); // 0 = Sunday

// ---------- booked trips ----------
function icsDate(field: { params: string; value: string }) {
  const v = field.value;
  if (/^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, ms: null as number | null, allDay: true };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  // Times without Z are treated as Eastern (the calendar's own time zone)
  const ms = m[7] === "Z" ? Date.UTC(y, mo - 1, d, h, mi) : wallTimeToMs(y, mo - 1, d, h, mi);
  return { date: etParts(ms).date, ms, allDay: false };
}

async function trips() {
  const url = Deno.env.get("SKIING_CALENDAR_ICS");
  if (!url) return { error: "no_calendar" };
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`The calendar link returned HTTP ${r.status}`);
  const text = (await r.text()).replace(/\r?\n[ \t]/g, "");
  const today = etParts(Date.now()).date;
  const out: any[] = [];
  let skippedRecurring = 0;
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const get = (name: string) => {
      const m = body.match(new RegExp(`^${name}(;[^:\\r\\n]*)?:(.*)$`, "m"));
      return m ? { params: m[1] ?? "", value: m[2].trim() } : null;
    };
    const title = (get("SUMMARY")?.value ?? "").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").replace(/\\\\/g, "\\");
    if (!KEYWORDS.some((k) => title.toLowerCase().includes(k))) continue;
    if ((get("STATUS")?.value ?? "").toUpperCase() === "CANCELLED") continue;
    if (get("RRULE")) { skippedRecurring++; continue; }
    const ds = get("DTSTART");
    const de = get("DTEND");
    const start = ds ? icsDate(ds) : null;
    if (!start) continue;
    const end = de ? icsDate(de) : null;
    // All-day events end the day after their last day
    const lastDate = end ? (end.allDay ? addDays(end.date, -1) : end.date) : start.date;
    if (lastDate < today) continue;
    const days: string[] = [];
    for (let d = start.date; d <= lastDate && days.length < 21; d = addDays(d, 1)) days.push(d);
    // Lodge rule: free cancellation until 2 PM on the Monday before the stay
    let back = (weekday(start.date) + 6) % 7; if (back === 0) back = 7;
    const monday = addDays(start.date, -back);
    const [y, mo, d] = monday.split("-").map(Number);
    out.push({
      title, startDate: start.date, lastDate, days, allDay: start.allDay,
      startTime: start.ms ? new Date(start.ms).toISOString() : null,
      cancelDeadline: new Date(wallTimeToMs(y, mo - 1, d, 14, 0)).toISOString(),
    });
  }
  out.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return { trips: out.slice(0, 8), skippedRecurring };
}

// ---------- weather service helpers ----------
async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/geo+json, application/json", ...headers }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}
function interval(vt: string): [number, number] {
  const [s, d] = vt.split("/");
  const start = Date.parse(s);
  const m = d.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/) ?? [];
  const ms = ((Number(m[1] ?? 0) * 24) + Number(m[2] ?? 0)) * 3600000 + Number(m[3] ?? 0) * 60000;
  return [start, start + ms];
}
function valueAt(series: any, t: number) {
  for (const v of series?.values ?? []) { const [a, b] = interval(v.validTime); if (t >= a && t < b) return v.value; }
  return undefined;
}
function sumOver(series: any, from: number, to: number) {
  let total = 0;
  for (const v of series?.values ?? []) {
    const [a, b] = interval(v.validTime);
    const overlap = Math.min(b, to) - Math.max(a, from);
    if (overlap > 0 && v.value) total += v.value * (overlap / (b - a));
  }
  return total;
}
function lastTime(series: any) {
  const vals = series?.values ?? [];
  return vals.length ? interval(vals[vals.length - 1].validTime)[1] : 0;
}
const ICE_TYPES = ["freezing_rain", "freezing_drizzle"];
const UNLIKELY = ["slight_chance", "chance"];

async function gridFor(lat: number, lon: number) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const { data } = await admin.from("nws_grid_cache").select("*").eq("latlon", key).maybeSingle();
  if (data) return data;
  const p = (await getJson(`https://api.weather.gov/points/${key}`)).properties ?? {};
  const rl = p.relativeLocation?.properties;
  const row = { latlon: key, office: p.gridId, grid_x: p.gridX, grid_y: p.gridY, label: rl ? `${rl.city}, ${rl.state}` : null };
  await admin.from("nws_grid_cache").upsert(row);
  return row;
}

// ---------- the drive ----------
function decodePolyline(s: string) {
  const pts: [number, number][] = [];
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lon += delta;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}
function miles(a: [number, number], b: [number, number]) {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function drive(departIso: string | null) {
  const key = Deno.env.get("GOOGLE_MAPS_KEY");
  if (!key) return { error: "no_maps_key" };
  const now = Date.now();
  let depart = departIso ? Date.parse(departIso) : now;
  if (isNaN(depart)) throw new Error("Bad departure time");
  const future = depart > now + 2 * 60000;
  if (!future) depart = now;

  // Reuse a recent answer to save Google lookups (10 minutes for "now", 1 hour for a planned time)
  const cacheKey = future ? `f:${Math.floor(depart / 600000)}` : `now:${Math.floor(now / 600000)}`;
  const maxAge = future ? 3600000 : 600000;
  const { data: hit } = await admin.from("drive_cache").select("result, created_at").eq("cache_key", cacheKey).maybeSingle();
  if (hit && now - Date.parse(hit.created_at) < maxAge) return { ...hit.result, cached: true };

  const gr = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline" },
    body: JSON.stringify({
      origin: { address: ORIGIN }, destination: { address: DEST }, travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE",
      ...(future ? { departureTime: new Date(depart).toISOString() } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const g = await gr.json();
  if (!gr.ok) throw new Error(`Google: ${g.error?.message ?? gr.status}`);
  const route = g.routes?.[0];
  if (!route) throw new Error("Google returned no route");
  const durSec = parseInt(route.duration);
  const staticSec = route.staticDuration ? parseInt(route.staticDuration) : null;
  const arrive = depart + durSec * 1000;

  // Checkpoints: the start, every ~45 miles, and the lodge. Pass times assume an even pace along the route.
  const pts = decodePolyline(route.polyline.encodedPolyline);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + miles(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  const marks: number[] = [0];
  for (let m = CHECKPOINT_MILES; m < total - CHECKPOINT_MILES / 2; m += CHECKPOINT_MILES) marks.push(m);
  marks.push(total);
  const cps = marks.map((m) => {
    const i = cum.findIndex((c) => c >= m);
    const p = pts[i < 0 ? pts.length - 1 : i];
    return { lat: p[0], lon: p[1], mile: Math.round(m), pass: depart + durSec * 1000 * (total ? m / total : 0) };
  });

  const gridData = new Map<string, Promise<any>>();
  const windowStart = depart - 3 * 3600000;
  const checkpoints = await Promise.all(cps.map(async (c, idx) => {
    const out: any = { mile: c.mile, lat: c.lat, lon: c.lon, pass: new Date(c.pass).toISOString() };
    try {
      const grid = await gridFor(c.lat, c.lon);
      out.label = idx === 0 ? "Towaco, NJ" : idx === cps.length - 1 ? "The lodge" : grid.label;
      const gkey = `${grid.office}/${grid.grid_x},${grid.grid_y}`;
      if (!gridData.has(gkey)) gridData.set(gkey, getJson(`https://api.weather.gov/gridpoints/${gkey}`).then((j) => j.properties));
      const gp = await gridData.get(gkey);
      if (c.pass > lastTime(gp.temperature)) { out.noForecast = true; return out; }
      const tC = valueAt(gp.temperature, c.pass);
      out.tempF = typeof tC === "number" ? Math.round(tC * 9 / 5 + 32) : null;
      const wx = (valueAt(gp.weather, c.pass) ?? []).filter((w: any) => w?.weather);
      out.weather = wx.map((w: any) => ({ weather: w.weather, coverage: w.coverage, intensity: w.intensity }));
      const snowMm = sumOver(gp.snowfallAmount, windowStart, c.pass + 3600000);
      out.snowIn = Math.round((snowMm / 25.4) * 10) / 10;
      const iceMm = sumOver(gp.iceAccumulation, windowStart, c.pass + 3600000);
      let iceWx = false;
      for (let t = windowStart; t <= c.pass + 3600000; t += 3600000) {
        for (const w of valueAt(gp.weather, t) ?? []) if (w && ICE_TYPES.includes(w.weather) && !UNLIKELY.includes(w.coverage)) iceWx = true;
      }
      out.iceIn = Math.round((iceMm / 25.4) * 100) / 100;
      out.freezingRain = iceMm > 0 || iceWx;
    } catch (e) {
      out.error = String((e as any)?.message ?? e);
    }
    return out;
  }));

  // Weather alerts at each checkpoint that overlap the drive
  const alerts = new Map<string, any>();
  await Promise.all(cps.map(async (c) => {
    try {
      const j = await getJson(`https://api.weather.gov/alerts/active?point=${c.lat.toFixed(4)},${c.lon.toFixed(4)}`);
      for (const f of j.features ?? []) {
        const a = f.properties ?? {};
        const from = Date.parse(a.onset ?? a.effective ?? a.sent ?? "");
        const to = Date.parse(a.ends ?? a.expires ?? "");
        if ((isNaN(from) || from <= arrive) && (isNaN(to) || to >= depart)) {
          alerts.set(a.id, { id: a.id, event: a.event, severity: a.severity, headline: a.headline, area: a.areaDesc, onset: a.onset ?? a.effective, ends: a.ends ?? a.expires });
        }
      }
    } catch { /* one failed alert lookup shouldn't sink the drive */ }
  }));

  const result = {
    depart: new Date(depart).toISOString(), arrive: new Date(arrive).toISOString(), future,
    durationSec: durSec, usualSec: staticSec, distanceMi: Math.round(total),
    checkpoints, alerts: [...alerts.values()],
    maxSnowIn: Math.max(0, ...checkpoints.map((c: any) => c.snowIn ?? 0)),
    freezingRain: checkpoints.some((c: any) => c.freezingRain),
    forecastGaps: checkpoints.filter((c: any) => c.noForecast || c.error).length,
  };
  await admin.from("drive_cache").upsert({ cache_key: cacheKey, created_at: new Date().toISOString(), result });
  await admin.from("drive_cache").delete().lt("created_at", new Date(now - 2 * 86400000).toISOString());
  return result;
}
