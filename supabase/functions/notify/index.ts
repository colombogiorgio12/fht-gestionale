// Slack notifications for the FHT Tracker.
// Called by a database trigger (new/changed requests and tasks) and by a daily cron job.
// Posts only through two incoming webhooks: #mind and the owner's private chat.
// It re-reads every record from the database and sends each notification once (notify_log).
import { createClient } from "jsr:@supabase/supabase-js@2";

const APP = "https://colombogiorgio12.github.io/fht-gestionale/";
const TZ = "Asia/Singapore";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MIND = Deno.env.get("SLACK_WEBHOOK_MIND");
const OWNER = Deno.env.get("SLACK_WEBHOOK_OWNER");
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

type Doc = Record<string, any>;
type Person = { id: string; name: string; email: string; slack_id: string | null; role: string; active: boolean; grp: string };

async function post(hook: string | undefined, text: string) {
  if (!hook) return false;
  const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, unfurl_links: false }) });
  return r.ok;
}
// true the first time a key is seen, false afterwards
async function once(key: string) {
  const { error } = await db.from("notify_log").insert({ key });
  return !error;
}
async function people() {
  const { data } = await db.from("profiles").select("id,name,email,slack_id,role,active,grp");
  const m: Record<string, Person> = {};
  for (const p of (data || []) as Person[]) m[p.id] = p;
  return m;
}
async function settings(): Promise<Doc> {
  const { data } = await db.from("docs").select("data").eq("col", "settings").eq("id", "slack").maybeSingle();
  return (data && data.data) || {};
}
async function col(c: string) {
  const { data } = await db.from("docs").select("id,data").eq("col", c);
  return (data || []) as { id: string; data: Doc }[];
}
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nameOf = (P: Record<string, Person>, id: string) => (P[id] && (P[id].name || P[id].email.split("@")[0])) || "Someone";
const tag = (P: Record<string, Person>, id: string) => (P[id]?.slack_id ? `<@${P[id].slack_id}>` : `*${esc(nameOf(P, id))}*`);
const admins = (P: Record<string, Person>) => Object.values(P).filter((p) => p.active && p.role === "admin").map((p) => tag(P, p.id)).join(" ");
const asg = (t: Doc): string[] => (Array.isArray(t.assignees) ? t.assignees.filter(Boolean) : t.assignee ? [t.assignee] : []);
const tid = (t: Doc) => (t.num ? `FHT-${t.num} ` : "");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const days = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const fmt = (d?: string | null) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "no due date");
const open = `<${APP}|Open the tracker>`;

async function taskTitle(id: string) {
  const { data } = await db.from("docs").select("data").eq("col", "tasks").eq("id", id).maybeSingle();
  return data ? `${tid(data.data)}“${esc(data.data.title)}”` : "a deleted task";
}
async function describe(r: Doc) {
  return r.type === "extend" ? `extension for ${await taskTitle(r.task)} to ${fmt(r.newDue)}` : `new task “${esc(r.title)}”`;
}

async function onRequest(op: string, id: string, old: Doc | null) {
  const { data: cur } = await db.from("docs").select("data").eq("col", "req").eq("id", id).maybeSingle();
  if (!cur) return "gone";
  const r = cur.data as Doc;
  const uid = id.split(":")[0];
  const P = await people();
  const S = await settings();
  const why = r.reason || r.desc ? `\n> ${esc(r.reason || r.desc)}` : "";
  if (op === "INSERT" && r.state === "pending") {
    if (!(await once(`req:${id}:new`))) return "dup";
    if (r.private) return post(OWNER, `:lock: Private request from *${esc(nameOf(P, uid))}*: ${await describe(r)}${why}\n${open}`);
    const lead = S.channelOnRequests ? "<!channel>" : admins(P);
    return post(MIND, `${lead} New request from ${tag(P, uid)}: ${await describe(r)}${why}\n${open}`);
  }
  if (op === "UPDATE" && old?.state === "pending" && r.state !== "pending") {
    if (!(await once(`req:${id}:${r.state}`))) return "dup";
    if (r.private) return "private";
    const verdict = r.state === "approved" ? "approved" : "declined";
    return post(MIND, `${tag(P, uid)} your request (${await describe(r)}) was *${verdict}* by ${esc(nameOf(P, r.decidedBy))}${r.reply ? `\n> ${esc(r.reply)}` : ""}`);
  }
  return "skip";
}

async function onTask(op: string, id: string, old: Doc | null, updatedAt: string) {
  const { data: cur } = await db.from("docs").select("data").eq("col", "tasks").eq("id", id).maybeSingle();
  if (!cur) return "gone";
  const t = cur.data as Doc;
  const before = op === "UPDATE" && old ? asg(old) : [];
  const added = asg(t).filter((x) => !before.includes(x));
  if (!added.length) return "skip";
  if (!(await once(`task:${id}:asg:${added.sort().join(",")}:${updatedAt}`))) return "dup";
  const P = await people();
  const who = added.map((x) => tag(P, x)).join(" ");
  return post(MIND, `${who} you've been assigned *${tid(t)}${esc(t.title)}* (due ${fmt(t.due)}). ${open}`);
}

// ----- daily summary -----
function latestStatus(statuses: { id: string; data: Doc }[], taskId: string) {
  let best: Doc | null = null;
  for (const s of statuses) {
    const e = s.data?.items?.[taskId];
    if (e && (!best || e.at > best.at)) best = e;
  }
  return best?.s || "todo";
}
function progress(t: Doc, st: string, work: { id: string; data: Doc }[]) {
  if (st === "done") return 1;
  const done: Record<string, { v: boolean; at: string }> = {};
  const extra = new Set<string>();
  for (const w of work) {
    const e = w.data?.items?.[t.id];
    if (!e) continue;
    for (const [c, v] of Object.entries(e.done || {})) {
      const x = v && typeof v === "object" ? (v as any) : { v: !!v, at: "" };
      if (!done[c] || (x.at || "") >= (done[c].at || "")) done[c] = x;
    }
    for (const it of e.extra || []) extra.add(it.id);
  }
  const ids = [...(t.checklist || []).map((c: Doc) => c.id), ...extra];
  if (ids.length) return ids.filter((c) => done[c]?.v).length / ids.length;
  return ({ todo: 0, doing: 0.4, review: 0.8 } as Record<string, number>)[st] || 0;
}
function risk(t: Doc, st: string, p: number, d: string) {
  if (!t.due || st === "done") return null;
  const left = days(d, t.due);
  if (left < 0) return "late";
  const start = t.start || (t.createdAt || "").slice(0, 10) || d;
  const since = days(start, d);
  const span = Math.max(1, left + since);
  const el = Math.min(1, Math.max(0, since / span));
  if ((el >= 0.5 && el - p >= 0.35) || (left <= 2 && p < 0.6)) return "risk";
  return null;
}

async function daily() {
  const d = today();
  if (!(await once(`daily:${d}`))) return "dup";
  const [P, S, tasks, statuses, work, prefs, reqs] = await Promise.all([people(), settings(), col("tasks"), col("status"), col("work"), col("prefs"), col("req")]);
  const late: string[] = [], atRisk: string[] = [], remind: string[] = [];
  for (const { id, data } of tasks) {
    const t: Doc = { ...data, id };
    const st = latestStatus(statuses, id);
    if (st === "done") continue;
    const p = progress(t, st, work);
    const r = risk(t, st, p, d);
    const who = asg(t);
    const line = `${tid(t)}*${esc(t.title)}*: ${who.length ? who.map((x) => tag(P, x)).join(" ") : "_unassigned_"} (due ${fmt(t.due)}, ${Math.round(p * 100)}%)`;
    if (r === "late") late.push(line);
    else if (r === "risk") atRisk.push(line);
    if (t.due && r !== "late") {
      const left = days(d, t.due);
      for (const x of who) {
        const want: number[] = prefs.find((q) => q.id === x)?.data?.remind || [1, 3];
        if (want.includes(left)) remind.push(`${tag(P, x)} ${tid(t)}*${esc(t.title)}* is due ${left === 0 ? "today" : left === 1 ? "tomorrow" : `in ${left} days`}`);
      }
    }
  }
  const parts: string[] = [];
  if (late.length) parts.push(`:red_circle: *Overdue*\n${late.map((l) => "• " + l).join("\n")}`);
  if (atRisk.length) parts.push(`:large_orange_circle: *At risk*\n${atRisk.map((l) => "• " + l).join("\n")}`);
  if (remind.length) parts.push(`:bell: *Reminders*\n${remind.map((l) => "• " + l).join("\n")}`);
  if (parts.length) await post(MIND, `${S.channelOnDaily ? "<!channel> " : ""}Good morning! Here's where we are.\n\n${parts.join("\n\n")}\n\n${open}`);

  const pending = reqs.filter((q) => q.data?.state === "pending");
  const priv = pending.filter((q) => q.data?.private).length;
  const mine = [`*${late.length}* overdue · *${atRisk.length}* at risk`, `*${pending.length}* pending requests${priv ? ` (${priv} private)` : ""}`];
  await post(OWNER, `:sunrise: Your morning summary\n${mine.map((l) => "• " + l).join("\n")}\n${open}`);
  return "sent";
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    if (body.type === "daily") return reply({ result: await daily() });
    const rec = body.record;
    if (!rec || typeof rec.id !== "string") return reply({ result: "ignored" });
    const old = body.old_record?.data ?? null;
    if (rec.col === "req") return reply({ result: await onRequest(body.type, rec.id, old) });
    if (rec.col === "tasks") return reply({ result: await onTask(body.type, rec.id, old, String(rec.updated_at || "")) });
    return reply({ result: "ignored" });
  } catch (e) {
    return reply({ error: String((e as Error)?.message || e) }, 500);
  }
});
