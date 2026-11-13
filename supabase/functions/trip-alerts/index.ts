// Lodge Trip Hub: trip emails.
//   * 8 AM on the Monday the lodge's free cancellation ends (2 PM): the trip's verdict and reasons.
//   * Any booked trip within a week whose verdict turns red (Reconsider): one email when it turns red.
// Runs every hour from a scheduled job (password in x-collector-token); it only does real work at 8 AM, 2 PM and 8 PM Eastern.
// Testing: ?dry=1 builds the emails without sending or saving; add &force=monday or &force=red to pretend it's time.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, trips, drive, etParts, wallTimeToMs, tripKey } from "./core.ts";
import { computeVerdict, bestDays, LEVEL_RANK, dateLabel, fmtTime, fmtDayTime } from "./verdict.js";

const HUB_URL = "https://thefredge.github.io/lodge-trip-hub/";
const FROM = "Lodge Trip Hub <noreply@hub.heismeyerproductions.com>";
const CHECK_HOURS = [8, 14, 20]; // Eastern
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b, null, 1), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function tripRange(t: any) {
  const a = dateLabel(t.startDate), b = dateLabel(t.lastDate);
  return t.startDate === t.lastDate ? a : `${a} – ${b}`;
}

async function evaluate(trip: any, forecasts: any, mountains: any[], today: string) {
  const out: any = {};
  for (const direction of ["up", "home"] as const) {
    const time = direction === "up" ? trip.upTime : trip.homeTime;
    const day = direction === "up" ? trip.startDate : trip.lastDate;
    const skiDays = direction === "up" ? trip.days.filter((d: string) => d >= today) : [trip.lastDate];
    let d: any = null, driveState = "ok", driveError: string | null = null;
    if (direction === "up" && trip.startDate < today) { driveState = "error"; driveError = "already at the lodge"; }
    else if (!time) driveState = "needTime";
    else {
      const [h, m] = time.split(":").map(Number);
      try {
        const r: any = await drive(new Date(wallTimeToMs(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m)).toISOString(), direction);
        if (r.error) { driveState = "error"; driveError = r.error === "daily_limit" ? "daily drive-lookup limit reached" : r.error === "no_maps_key" ? "Maps key missing" : r.error; }
        else d = r;
      } catch (e) { driveState = "error"; driveError = String((e as any)?.message ?? e); }
    }
    out[direction] = { time, day, drive: d, verdict: computeVerdict({ forecasts, skiDays, drive: d, driveState, driveError, mountains, direction }) };
  }
  const upRank = LEVEL_RANK[out.up.verdict.level as keyof typeof LEVEL_RANK], homeRank = LEVEL_RANK[out.home.verdict.level as keyof typeof LEVEL_RANK];
  out.level = upRank >= homeRank ? out.up.verdict.level : out.home.verdict.level;
  const sb = mountains.find((m) => m.mountain === "sugarbush");
  out.best = bestDays(forecasts, trip.days.filter((d: string) => d >= today), sb?.new_snow_24h_in ?? null);
  return out;
}

const COLORS: Record<string, string> = { reconsider: "#9B1C1C", caution: "#8A4500", go: "#1E6B3A", unknown: "#4A5866" };
function verdictBlock(label: string, v: any, part: any) {
  const items = [...v.red, ...v.yellow].map((x: string) => `<li>${esc(x)}</li>`).join("");
  let driveLine = "";
  if (part.drive) driveLine = `Leaving ${fmtDayTime(Date.parse(part.drive.depart))}, arriving about ${fmtTime(Date.parse(part.drive.arrive))} (${Math.round(part.drive.durationSec / 60)} min).`;
  else if (!part.time) driveLine = "No departure time picked yet. Pick one on the hub to include the drive.";
  return `<div style="border-radius:12px;padding:14px 16px;margin:12px 0;color:#fff;background:${COLORS[v.level]}">
    <div style="font-size:12px;opacity:.9;text-transform:uppercase;letter-spacing:.05em">${esc(label)}</div>
    <div style="font-size:20px;font-weight:700">${esc(v.title)}</div>
    ${items ? `<ul style="margin:8px 0 0;padding-left:18px">${items}</ul>` : ""}
    ${v.notes.length ? `<div style="font-size:13px;margin-top:6px">${esc(v.notes.join(" · "))}</div>` : ""}
    ${v.clear.length ? `<div style="font-size:12px;margin-top:6px;opacity:.9">Clear: ${esc(v.clear.join(" · "))}</div>` : ""}
    ${v.unchecked.length ? `<div style="font-size:12px;margin-top:4px;opacity:.9">Not checked: ${esc(v.unchecked.join(" · "))}</div>` : ""}
    ${driveLine ? `<div style="font-size:13px;margin-top:8px">${esc(driveLine)}</div>` : ""}
  </div>`;
}
function buildEmail(kind: "monday" | "red", trip: any, ev: any) {
  const range = tripRange(trip);
  const deadline = Date.parse(trip.cancelDeadline);
  const subject = kind === "monday"
    ? `Lodge trip ${range}: free cancellation ends 2 PM today (${ev.up.verdict.title === ev.home.verdict.title ? ev.up.verdict.title : `${ev.up.verdict.title} / ${ev.home.verdict.title}`})`
    : `Lodge trip ${range} now says Reconsider`;
  const best = ev.best?.best ? `<p style="margin:12px 0 0"><b>Best day:</b> ${esc(dateLabel(ev.best.best.date))}: ${esc(ev.best.best.reason)}</p>` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#14202B;max-width:520px">
    <h2 style="margin:0 0 4px">${esc(trip.title)}, ${esc(range)}</h2>
    <div style="color:#4A5866;font-size:13px">${deadline > Date.now() ? `Free cancellation until ${esc(fmtDayTime(deadline))}.` : `The free-cancellation deadline (${esc(fmtDayTime(deadline))}) has passed.`}</div>
    ${verdictBlock("Driving up", ev.up.verdict, ev.up)}
    ${verdictBlock("Going home", ev.home.verdict, ev.home)}
    ${best}
    <p style="margin:16px 0"><a href="${HUB_URL}" style="background:#1A4FA0;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open the Lodge Trip Hub</a></p>
    <p style="color:#4A5866;font-size:12px">Sent by your Lodge Trip Hub (${kind === "monday" ? "cancel-deadline check" : "the verdict turned red"}). Mountain forecasts are for about 900–1,000 ft below the summits.</p>
  </div>`;
  return { subject, html };
}

async function send(to: string[], subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "no_resend_key" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }), signal: AbortSignal.timeout(20000),
  });
  const body = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: body.id } : { ok: false, error: body.message ?? `HTTP ${r.status}` };
}

Deno.serve(async (req: Request) => {
  const token = req.headers.get("x-collector-token") ?? "";
  const { data: okToken, error: tokErr } = await admin.rpc("check_collector_token", { token });
  if (tokErr || okToken !== true) return new Response("Forbidden", { status: 403 });
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const force = url.searchParams.get("force");
  const now = Date.now(); const et = etParts(now); const today = et.date;
  if (!force && !CHECK_HOURS.includes(et.hour)) return json({ skipped: `not a check hour (${et.hour}:00 Eastern)` });

  const t: any = await trips();
  if (t.error) return json({ skipped: t.error });
  const [{ data: f }, { data: rep }, { data: rcpt }] = await Promise.all([
    admin.from("forecast_latest").select("*"),
    admin.from("mountain_reports").select("mountain,trails_open,trails_total,new_snow_24h_in,collected_at").order("collected_at", { ascending: false }).limit(40),
    admin.rpc("alert_recipients"),
  ]);
  const forecasts = Object.fromEntries((f ?? []).map((x: any) => [x.point_id, x]));
  const mountains = ["sugarbush", "mad_river_glen"].map((m) => (rep ?? []).find((r: any) => r.mountain === m)).filter(Boolean);
  const to = (rcpt ?? []).map((r: any) => r.email);

  const results: any[] = [];
  for (const trip of t.trips) {
    const key = tripKey(trip);
    const daysUntil = Math.round((Date.parse(trip.startDate + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86400000);
    const deadlineDay = etParts(Date.parse(trip.cancelDeadline)).date;
    const mondayDue = force === "monday" || (deadlineDay === today && et.hour === 8);
    const withinWeek = daysUntil <= 7 && trip.lastDate >= today;
    if (!mondayDue && !withinWeek && force !== "red") { results.push({ trip: key, skipped: `${daysUntil} days away` }); continue; }

    const ev = await evaluate(trip, forecasts, mountains, today);
    const { data: state } = await admin.from("trip_alert_state").select("last_level").eq("trip_key", key).maybeSingle();
    const res: any = { trip: key, level: ev.level, previous: state?.last_level ?? null };

    let kind: "monday" | "red" | null = null;
    if (mondayDue) {
      const { data: sent } = await admin.from("trip_alert_log").select("id").eq("trip_key", key).eq("kind", "monday").limit(1);
      if (force === "monday" || !sent?.length) kind = "monday";
    }
    if (!kind && (force === "red" || (withinWeek && ev.level === "reconsider" && state?.last_level !== "reconsider"))) kind = "red";

    if (kind) {
      const email = buildEmail(kind, trip, ev);
      res.email = { kind, subject: email.subject, to: to.length };
      if (dry) res.email.html = email.html;
      else {
        const s = await send(to, email.subject, email.html);
        res.email.result = s;
        if (s.ok) await admin.from("trip_alert_log").insert({ trip_key: key, kind, level: ev.level, recipients: to.length, result: s });
      }
    }
    if (!dry) await admin.from("trip_alert_state").upsert({ trip_key: key, last_level: ev.level, checked_at: new Date().toISOString() });
    results.push(res);
  }
  return json({ ok: true, dry, at: `${today} ${et.hour}:00 Eastern`, recipients: to.length, results });
});
