// Account management for the super admin: create collaborators with a temporary
// password, reset passwords, deactivate and reactivate accounts.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function tempPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !user) return json({ error: "Accesso non valido: rientra nel gestionale." }, 401);
    const { data: me } = await admin.from("profiles").select("role, active").eq("id", user.id).single();
    if (!me || me.role !== "admin" || !me.active) return json({ error: "Solo il super admin può gestire gli account." }, 403);

    const body = await req.json();
    const role = ["coord", "collab"].includes(body.role) ? body.role : "collab";

    if (body.action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Email non valida." }, 400);
      const password = tempPassword();
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name: body.name || "" },
      });
      if (error) {
        const exists = /already|registered|exists/i.test(error.message);
        return json({ error: exists ? "Esiste già un account con questa email." : error.message }, 400);
      }
      await admin.from("profiles").update({
        name: String(body.name || ""), title: String(body.title || ""), grp: String(body.grp || ""),
        role, must_change: true, active: true,
      }).eq("id", data.user.id);
      return json({ id: data.user.id, password });
    }

    if (body.action === "reset") {
      const password = tempPassword();
      const { error } = await admin.auth.admin.updateUserById(body.id, { password });
      if (error) return json({ error: error.message }, 400);
      await admin.from("profiles").update({ must_change: true }).eq("id", body.id);
      return json({ password });
    }

    if (body.action === "deactivate" || body.action === "reactivate") {
      if (body.id === user.id) return json({ error: "Non puoi disattivare il tuo account." }, 400);
      const on = body.action === "reactivate";
      const { error } = await admin.auth.admin.updateUserById(body.id, { ban_duration: on ? "none" : "876000h" });
      if (error) return json({ error: error.message }, 400);
      await admin.from("profiles").update({ active: on }).eq("id", body.id);
      return json({ ok: true });
    }

    return json({ error: "Azione sconosciuta." }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
