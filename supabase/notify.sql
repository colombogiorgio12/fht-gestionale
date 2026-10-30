-- Slack notifications. Run after schema.sql. Safe to run again.
-- Slack member IDs are set only by the admin (used for @mentions in #mind).
alter table public.profiles add column if not exists slack_id text;
create or replace function public.guard_profile() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    new.role := old.role; new.grp := old.grp; new.title := old.title;
    new.email := old.email; new.active := old.active; new.slack_id := old.slack_id;
  end if;
  return new;
end $$;

-- One row per notification already sent (only the server can see it).
create table if not exists public.notify_log (key text primary key, at timestamptz not null default now());
alter table public.notify_log enable row level security;

-- settings/slack: readable by the team, writable by the admin.
create or replace function public.can_write_doc(c text, i text) returns boolean
language sql stable as $$
  select public.is_member() and case
    when c in ('tasks','goals','templates') then public.is_manager()
    when c in ('prefs','status','notes','files','work') then i = auth.uid()::text or public.is_manager()
    when c = 'req' then split_part(i, ':', 1) = auth.uid()::text or public.is_manager()
    when c in ('digests','settings') then public.is_admin()
    else false end
$$;

-- New or changed requests and tasks call the notify function.
create extension if not exists pg_net;
create or replace function public.notify_doc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.col in ('req','tasks') then
    perform net.http_post(
      url := 'https://noayuqmlmkbrzfgdppku.supabase.co/functions/v1/notify',
      body := jsonb_build_object('type', tg_op, 'record', to_jsonb(new), 'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vYXl1cW1sbWticnpmZ2RwcGt1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyODIzOTgsImV4cCI6MjEwODg1ODM5OH0.PxQHVqAUKd2cb8eFfhFrP9yk4F91I47Y2nDxClcMiKM'));
  end if;
  return new;
end $$;
drop trigger if exists notify_docs on public.docs;
create trigger notify_docs after insert or update on public.docs for each row execute function public.notify_doc();

-- Morning summary, Monday to Friday at 08:00 Singapore time (00:00 UTC).
create extension if not exists pg_cron;
select cron.unschedule('fht-daily') where exists (select 1 from cron.job where jobname = 'fht-daily');
select cron.schedule('fht-daily', '0 0 * * 1-5', $job$ select net.http_post(url := 'https://noayuqmlmkbrzfgdppku.supabase.co/functions/v1/notify', body := '{"type":"daily"}'::jsonb, headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vYXl1cW1sbWticnpmZ2RwcGt1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyODIzOTgsImV4cCI6MjEwODg1ODM5OH0.PxQHVqAUKd2cb8eFfhFrP9yk4F91I47Y2nDxClcMiKM"}'::jsonb) $job$);
