-- Gestionale FHT: database schema for Supabase.
-- Paste the whole file into Supabase → SQL Editor → Run. It is safe to run again.

-- ---------- people ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null default '',
  title text not null default '',
  grp text not null default '',
  role text not null default 'collab' check (role in ('admin','coord','collab')),
  must_change boolean not null default true,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

-- Accounts with these emails become super admin when they are created.
create table if not exists public.admin_emails (email text primary key);
alter table public.admin_emails enable row level security;
insert into public.admin_emails values ('giorgio.colombo@sec.ethz.ch') on conflict do nothing;

-- Every new auth user gets a profile. Only admin emails are active right away;
-- everyone else is activated by the admin-users function, so self sign-ups get no access.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare is_adm boolean := exists(select 1 from public.admin_emails where email = lower(new.email));
begin
  insert into public.profiles (id, email, name, role, must_change, active)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'name', ''),
          case when is_adm then 'admin' else 'collab' end, not is_adm, is_adm)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;
create or replace function public.is_member() returns boolean language sql stable as $$ select public.my_role() is not null $$;
create or replace function public.is_manager() returns boolean language sql stable as $$ select coalesce(public.my_role() in ('admin','coord'), false) $$;
create or replace function public.is_admin() returns boolean language sql stable as $$ select coalesce(public.my_role() = 'admin', false) $$;

-- Non-admins may change only their own name and must_change flag.
create or replace function public.guard_profile() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_admin() then
    new.role := old.role; new.grp := old.grp; new.title := old.title;
    new.email := old.email; new.active := old.active;
  end if;
  return new;
end $$;
drop trigger if exists guard_profile on public.profiles;
create trigger guard_profile before update on public.profiles
  for each row execute function public.guard_profile();

alter table public.profiles enable row level security;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (public.is_member() or id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_admin() or id = auth.uid()) with check (public.is_admin() or id = auth.uid());

-- ---------- documents (tasks, goals, statuses, comments, …) ----------
-- Same model as the claude.ai prototype: a collection name plus a document id.
-- Per-person collections use the person's user id as document id.
create table if not exists public.docs (
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (col, id)
);

create or replace function public.can_read_doc(c text, i text, d jsonb) returns boolean
language sql stable as $$
  select public.is_member() and case c
    when 'prefs' then i = auth.uid()::text or public.is_manager()
    when 'digests' then public.is_admin()
    -- requests: id is "<author id>:<request id>"; private unless the author made it public
    when 'req' then split_part(i, ':', 1) = auth.uid()::text or public.is_manager() or coalesce(d->>'private', 'true') = 'false'
    else true end
$$;
create or replace function public.can_write_doc(c text, i text) returns boolean
language sql stable as $$
  select public.is_member() and case
    when c in ('tasks','goals','templates') then public.is_manager()
    when c in ('prefs','status','notes','files','work') then i = auth.uid()::text or public.is_manager()
    when c = 'req' then split_part(i, ':', 1) = auth.uid()::text or public.is_manager()
    when c = 'digests' then public.is_admin()
    else false end
$$;

alter table public.docs enable row level security;
drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated using (public.can_read_doc(col, id, data));
drop function if exists public.can_read_doc(text, text);
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated with check (public.can_write_doc(col, id));
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (public.can_write_doc(col, id)) with check (public.can_write_doc(col, id));
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (public.can_write_doc(col, id));

-- Recursive merge used for partial updates (nested objects merge, everything else replaces).
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; result jsonb;
begin
  if jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then return b; end if;
  result := a;
  for k in select jsonb_object_keys(b) loop
    if result ? k then result := jsonb_set(result, array[k], public.jsonb_deep_merge(result->k, b->k));
    else result := result || jsonb_build_object(k, b->k); end if;
  end loop;
  return result;
end $$;

create or replace function public.doc_merge(p_col text, p_id text, p_patch jsonb) returns void
language sql security invoker as $$
  insert into public.docs (col, id, data, updated_at, updated_by) values (p_col, p_id, p_patch, now(), auth.uid())
  on conflict (col, id) do update
    set data = public.jsonb_deep_merge(public.docs.data, excluded.data), updated_at = now(), updated_by = auth.uid();
$$;

-- Live updates in the app.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'profiles') then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

-- ---------- files ----------
-- Private bucket, 50 MB per file. Everyone in the team reads; each person uploads into
-- their own folder; nothing can be overwritten (no update policy); a person can delete
-- their own upload within 24 hours, the super admin can delete anything.
insert into storage.buckets (id, name, public, file_size_limit)
values ('documenti', 'documenti', false, 52428800)
on conflict (id) do nothing;

drop policy if exists fht_files_read on storage.objects;
create policy fht_files_read on storage.objects for select to authenticated
  using (bucket_id = 'documenti' and public.is_member());
drop policy if exists fht_files_upload on storage.objects;
create policy fht_files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'documenti' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists fht_files_delete on storage.objects;
create policy fht_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documenti' and (public.is_admin()
    or ((storage.foldername(name))[1] = auth.uid()::text and created_at > now() - interval '1 day')));
