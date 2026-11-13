// Lodge Trip Hub: the verdict rules, shared by the page and the trip emails.
// Plain JavaScript with no outside libraries, so the same file runs in the browser and in Supabase.
// Every rule here was agreed with Fred (see the project note in his vault).

export const TZ = "America/New_York";
export const RULES = {
  windChillYellowF: 5, windChillRedF: -10,      // upper-mountain forecast, ski hours
  terrainYellowPct: 33, terrainRedPct: 15,      // better of the two mountains
  rainRedPop: 50, rainYellowPop: 20, thawF: 32, // ski days, upper mountain
  snowRedIn: 8, snowYellowIn: 3,                // on the route around the drive
  skiFromHour: 9, skiToHour: 16,                // "ski hours", Eastern time
};
export const RED_ALERTS = ["Blizzard Warning", "Ice Storm Warning"];
export const YELLOW_ALERTS = ["Winter Storm Warning"];
export const NOTE_ALERTS = ["Winter Weather Advisory"];
export const UPPER = ["mrg_summit", "mount_ellen", "lincoln_peak"];
export const POINT_NAME = { mrg_summit: "Mad River Glen", mount_ellen: "Mt. Ellen", lincoln_peak: "Lincoln Peak", lodge: "the lodge" };
const RAIN = ["rain", "rain_showers", "drizzle", "freezing_rain", "freezing_drizzle"];
const ICE = ["freezing_rain", "freezing_drizzle"];

// ---------- time ----------
export function etParts(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const g = (k) => p.find((x) => x.type === k).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24, minute: Number(g("minute")) };
}
export const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export function wallToMs(dateStr, hh, mm) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  for (const off of [5, 4]) { const t = Date.UTC(y, mo - 1, d, hh + off, mm); const p = etParts(t); if (p.date === dateStr && p.hour === hh && p.minute === mm) return t; }
  return Date.UTC(y, mo - 1, d, hh + 5, mm);
}
export const fmtTime = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
export const fmtDay = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));
export const fmtDayTime = (ms) => `${fmtDay(ms)}, ${fmtTime(ms)}`;
export const dateLabel = (d) => fmtDay(Date.parse(d + "T12:00:00Z"));
export const weekdayName = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(d + "T12:00:00Z"));

// ---------- weather-service series ----------
export function interval(vt) {
  const [s, d] = vt.split("/"); const start = Date.parse(s);
  const m = d.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/) || [];
  return [start, start + (((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600000 + (+m[3] || 0) * 60000)];
}
export function hourly(series, perHourShare = false) {
  const out = [];
  for (const v of series?.values ?? []) {
    const [a, b] = interval(v.validTime); const n = Math.max(1, Math.round((b - a) / 3600000));
    for (let i = 0; i < n; i++) out.push({ t: a + i * 3600000, v: perHourShare && typeof v.value === "number" ? v.value / n : v.value });
  }
  return out;
}
export const cToF = (c) => c * 9 / 5 + 32;
export const kmhToMph = (k) => k / 1.609344;
export const mmToIn = (mm) => mm / 25.4;
export const lastHour = (series) => { const v = series?.values ?? []; return v.length ? interval(v[v.length - 1].validTime)[1] : 0; };
function seriesMap(series, share = false) { return new Map(hourly(series, share).map((x) => [x.t, x.v])); }
function sumBetween(series, from, to) { let s = 0; for (const { t, v } of hourly(series, true)) if (t >= from && t < to && typeof v === "number") s += v; return s; }

// ---------- upper mountain, ski days ----------
// Worst case across the three upper-mountain points, ski hours (9 AM–4 PM) on each ski day
export function upperAnalysis(forecasts, skiDays) {
  const out = { windChill: null, wind: null, gust: null, rainRed: [], rainYellow: [], thaw: [], missingDays: [], perDay: {} };
  const days = new Set(skiDays); const covered = new Set();
  for (const id of UPPER) {
    const f = forecasts[id]; if (!f) continue;
    const h = f.hourly; const end = lastHour(h.temperature);
    const pop = seriesMap(h.probabilityOfPrecipitation), wx = seriesMap(h.weather), wind = seriesMap(h.windSpeed), gust = seriesMap(h.windGust), wc = seriesMap(h.windChill);
    for (const { t, v } of hourly(h.temperature)) {
      if (t >= end || typeof v !== "number") continue; const p = etParts(t);
      if (!days.has(p.date) || p.hour < RULES.skiFromHour || p.hour >= RULES.skiToHour) continue;
      covered.add(p.date);
      const day = (out.perDay[p.date] ??= { minWC: null, maxGustMph: 0, rain: 0, thaw: false });
      const tF = cToF(v); const wcF = typeof wc.get(t) === "number" ? cToF(wc.get(t)) : tF;
      if (out.windChill == null || wcF < out.windChill.f) out.windChill = { f: Math.round(wcF), t, id };
      if (day.minWC == null || wcF < day.minWC) day.minWC = wcF;
      const ws = wind.get(t), gs = gust.get(t);
      if (typeof ws === "number" && (out.wind == null || ws > out.wind.v)) out.wind = { v: ws, t, id };
      if (typeof gs === "number") { if (out.gust == null || gs > out.gust.v) out.gust = { v: gs, t, id }; day.maxGustMph = Math.max(day.maxGustMph, kmhToMph(gs)); }
      const rainy = (wx.get(t) ?? []).some((w) => w && RAIN.includes(w.weather));
      const pp = pop.get(t) ?? 0;
      if (rainy && pp >= RULES.rainRedPop) { day.rain = 2; out.rainRed.push(t); }
      else if (rainy && pp >= RULES.rainYellowPop) { day.rain = Math.max(day.rain, 1); out.rainYellow.push(t); }
      if (tF > RULES.thawF) { day.thaw = true; out.thaw.push(t); }
    }
  }
  out.missingDays = skiDays.filter((d) => !covered.has(d));
  return out;
}

// ---------- best day of the trip ----------
// Fresh snow boosts a day (overnight snow counts fully, snow during ski hours half);
// harsh wind chill, strong wind, rain and thaw count against it, so a frigid powder day can lose to a mild one.
export function bestDays(forecasts, skiDays, reportedNew24) {
  const up = upperAnalysis(forecasts, skiDays);
  const today = etParts(Date.now()).date;
  const rows = [];
  for (const d of skiDays) {
    const pd = up.perDay[d]; if (!pd) continue;
    // average fresh snow across the upper points
    let snow = 0, n = 0;
    for (const id of UPPER) {
      const f = forecasts[id]; if (!f) continue; n++;
      const overnight = sumBetween(f.hourly.snowfallAmount, wallToMs(addDays(d, -1), 16, 0), wallToMs(d, RULES.skiFromHour, 0));
      const daytime = sumBetween(f.hourly.snowfallAmount, wallToMs(d, RULES.skiFromHour, 0), wallToMs(d, RULES.skiToHour, 0));
      snow += mmToIn(overnight) + 0.5 * mmToIn(daytime);
    }
    snow = n ? snow / n : 0;
    if (d === today && typeof reportedNew24 === "number") snow = Math.max(snow, reportedNew24);
    let score = Math.min(snow, 12);
    const notes = [];
    if (snow >= 1) notes.push(`${Math.round(snow)} in fresh`);
    const wc = pd.minWC;
    if (wc != null) {
      if (wc <= RULES.windChillRedF) { score -= 8; notes.push(`wind chill ${Math.round(wc)}°F`); }
      else if (wc <= RULES.windChillYellowF) { score -= 4; notes.push(`wind chill ${Math.round(wc)}°F`); }
      else if (wc <= 15) score -= 1;
    }
    if (pd.maxGustMph >= 45) { score -= 4; notes.push(`gusts ${Math.round(pd.maxGustMph)} mph`); }
    else if (pd.maxGustMph >= 30) { score -= 2; notes.push(`gusts ${Math.round(pd.maxGustMph)} mph`); }
    if (pd.rain === 2) { score -= 10; notes.push("rain likely"); }
    else if (pd.rain === 1) { score -= 4; notes.push("chance of rain"); }
    else if (pd.thaw) { score -= 3; notes.push("above freezing"); }
    if (!notes.length) notes.push(wc != null && wc > 15 ? "mild, calm and dry" : "dry, no fresh snow");
    rows.push({ date: d, score, snowIn: snow, reason: notes.join(", ") });
  }
  const ranked = [...rows].sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return { days: rows, best: ranked[0] ?? null, missingDays: up.missingDays };
}

// ---------- conditions at the lodge at a given time ----------
export function lodgeConditions(lodgeForecast, atMs) {
  if (!lodgeForecast) return null;
  const h = lodgeForecast.hourly;
  if (atMs >= lastHour(h.temperature)) return { beyond: true };
  const hourStart = Math.floor(atMs / 3600000) * 3600000;
  const at = (series) => seriesMap(series).get(hourStart);
  const tC = at(h.temperature), wcC = at(h.windChill), pop = at(h.probabilityOfPrecipitation);
  const wx = (at(h.weather) ?? []).filter((w) => w && w.weather);
  const snow6 = mmToIn(sumBetween(h.snowfallAmount, atMs - 6 * 3600000, atMs + 3600000));
  const ice6 = mmToIn(sumBetween(h.iceAccumulation, atMs - 6 * 3600000, atMs + 3600000));
  const iceWx = wx.some((w) => ICE.includes(w.weather));
  return {
    tempF: typeof tC === "number" ? Math.round(cToF(tC)) : null,
    windChillF: typeof wcC === "number" ? Math.round(cToF(wcC)) : null,
    pop: typeof pop === "number" ? pop : null,
    weather: wx.map((w) => ({ weather: w.weather, coverage: w.coverage, intensity: w.intensity })),
    snowIn: Math.round(snow6 * 10) / 10, ice: ice6 > 0 || iceWx,
  };
}

export function wxLabel(list) {
  if (!list?.length) return "";
  const w = list[0]; const name = String(w.weather).replace(/_/g, " ");
  const lead = w.coverage === "slight_chance" ? "Slight chance of " : w.coverage === "chance" ? "Chance of " : "";
  const txt = lead + (w.intensity === "heavy" ? "heavy " : w.intensity === "light" || w.intensity === "very_light" ? "light " : "") + name;
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

// ---------- terrain ----------
export function terrainBest(mountains) {
  const pcts = mountains.filter((m) => m && m.trails_total).map((m) => ({ id: m.mountain, pct: (100 * (m.trails_open ?? 0)) / m.trails_total }));
  if (!pcts.length) return null;
  const best = pcts.reduce((a, b) => (b.pct > a.pct ? b : a));
  return { ...best, name: best.id === "sugarbush" ? "Sugarbush" : "Mad River Glen" };
}

// ---------- the verdict ----------
// direction "up": ski days of the trip + the drive up + terrain.
// direction "home": the drive home + the last ski day (the day you leave) + terrain.
// drive: the drive result, or null with driveState "needTime" | "error" (driveError text).
export function computeVerdict({ forecasts, skiDays, drive, driveState, driveError, mountains, direction = "up" }) {
  const red = [], yellow = [], notes = [], clear = [], unchecked = [];
  const up = upperAnalysis(forecasts, skiDays);
  if (!skiDays.length || up.missingDays.length === skiDays.length) unchecked.push("mountain weather (not in the forecast yet)");
  else {
    if (up.rainRed.length) red.push(`Rain likely on the mountain ${fmtDay(up.rainRed[0])}`);
    else if (up.rainYellow.length) yellow.push(`Chance of rain on the mountain ${fmtDay(up.rainYellow[0])}`);
    else if (up.thaw.length) yellow.push(`Above freezing on the upper mountain ${fmtDay(up.thaw[0])}`);
    else clear.push("rain or thaw");
    const wc = up.windChill;
    if (wc && wc.f <= RULES.windChillRedF) red.push(`Wind chill ${wc.f}°F on the upper mountain, ${fmtDayTime(wc.t)}`);
    else if (wc && wc.f <= RULES.windChillYellowF) yellow.push(`Wind chill ${wc.f}°F on the upper mountain, ${fmtDayTime(wc.t)}`);
    else clear.push("cold");
    if (up.missingDays.length) notes.push(`Not in the forecast yet: ${up.missingDays.map(dateLabel).join(", ")}`);
  }
  const way = direction === "home" ? "home" : "up";
  if (driveState === "needTime") unchecked.push(`the drive ${way} (pick a departure time)`);
  else if (!drive) unchecked.push(`the drive ${way}` + (driveError ? ` (${String(driveError).replace(/\.$/, "")})` : ""));
  else {
    const before = red.length + yellow.length;
    if (drive.freezingRain) red.push(`Freezing rain or ice on the route ${way}`);
    for (const a of drive.alerts ?? []) {
      if (RED_ALERTS.includes(a.event)) red.push(`${a.event} on the route ${way}`);
      else if (YELLOW_ALERTS.includes(a.event)) yellow.push(`${a.event} on the route ${way}`);
      else if (NOTE_ALERTS.includes(a.event)) notes.push(`${a.event} on the route ${way}`);
    }
    if (drive.maxSnowIn >= RULES.snowRedIn) red.push(`About ${drive.maxSnowIn} in of snow on the route ${way}`);
    else if (drive.maxSnowIn >= RULES.snowYellowIn) yellow.push(`About ${drive.maxSnowIn} in of snow on the route ${way}`);
    else if (drive.maxSnowIn >= 0.5) notes.push(`Light snow on the route ${way} (about ${drive.maxSnowIn} in)`);
    if (red.length + yellow.length === before) clear.push(`the drive ${way}`);
    if (drive.forecastGaps) notes.push(`Part of the drive ${way} is beyond the weather forecast`);
  }
  const best = terrainBest(mountains);
  if (!best) unchecked.push("terrain");
  else if (best.pct < RULES.terrainRedPct) red.push(best.pct === 0 ? "Both mountains are closed" : `Little terrain open: best is ${best.name}, ${Math.round(best.pct)}%`);
  else if (best.pct < RULES.terrainYellowPct) yellow.push(`Limited terrain: best is ${best.name}, ${Math.round(best.pct)}%`);
  else clear.push("terrain open");
  const level = red.length ? "reconsider" : yellow.length ? "caution" : unchecked.length ? "unknown" : "go";
  const title = { reconsider: "Reconsider", caution: "Go with caution", go: "Go", unknown: "Looks OK so far" }[level];
  return { level, title, red, yellow, notes, clear, unchecked };
}

export const LEVEL_RANK = { go: 0, unknown: 1, caution: 2, reconsider: 3 };
