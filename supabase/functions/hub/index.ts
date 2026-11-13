// Lodge Trip Hub: the page's helper. Only signed-in, approved people can call it.
//   action "trips": booked lodge trips with saved departure times
//   action "drive": { depart, direction: "up" | "home" } drive time plus checkpoint weather and alerts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { trips, drive } from "./core.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

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
    if (body.action === "drive") return json(await drive(body.depart ?? null, body.direction === "home" ? "home" : "up"));
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
