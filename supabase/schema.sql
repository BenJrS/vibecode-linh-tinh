-- Memory-Graph, phase 1: accounts + private sync.
-- Paste into Supabase > SQL Editor > New query > Run. Safe to run again.
-- Every row belongs to one user and only that user can read or change it (row level security).

-- ---------- profiles (used by friends in phase 2) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- places and memories ----------
create table if not exists public.places (
  id uuid primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  thumb text,
  mind_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.memories (
  id uuid primary key,
  place_id uuid not null references public.places (id) on delete cascade,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  x double precision not null,
  y double precision not null,
  text text not null default '',
  color text,
  audio_dur integer,
  peaks jsonb,
  photo_path text,
  audio_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists places_owner_updated on public.places (owner, updated_at);
create index if not exists memories_owner_updated on public.memories (owner, updated_at);
create index if not exists memories_place on public.memories (place_id);

-- the server clock decides updated_at, so devices with wrong clocks cannot break sync
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists places_touch on public.places;
create trigger places_touch before insert or update on public.places
  for each row execute function public.touch_updated_at();
drop trigger if exists memories_touch on public.memories;
create trigger memories_touch before insert or update on public.memories
  for each row execute function public.touch_updated_at();

-- ---------- row level security: owner only ----------
alter table public.profiles enable row level security;
alter table public.places enable row level security;
alter table public.memories enable row level security;

drop policy if exists "profiles read own" on public.profiles;
create policy "profiles read own" on public.profiles for select to authenticated
  using (id = (select auth.uid()));
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "places select own" on public.places;
create policy "places select own" on public.places for select to authenticated
  using (owner = (select auth.uid()));
drop policy if exists "places insert own" on public.places;
create policy "places insert own" on public.places for insert to authenticated
  with check (owner = (select auth.uid()));
drop policy if exists "places update own" on public.places;
create policy "places update own" on public.places for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
drop policy if exists "places delete own" on public.places;
create policy "places delete own" on public.places for delete to authenticated
  using (owner = (select auth.uid()));

drop policy if exists "memories select own" on public.memories;
create policy "memories select own" on public.memories for select to authenticated
  using (owner = (select auth.uid()));
drop policy if exists "memories insert own" on public.memories;
create policy "memories insert own" on public.memories for insert to authenticated
  with check (owner = (select auth.uid()));
drop policy if exists "memories update own" on public.memories;
create policy "memories update own" on public.memories for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
drop policy if exists "memories delete own" on public.memories;
create policy "memories delete own" on public.memories for delete to authenticated
  using (owner = (select auth.uid()));

-- ---------- private file storage (tracking data, photos, voice) ----------
-- files live under <user id>/...; nobody can touch another user's folder
insert into storage.buckets (id, name, public, file_size_limit)
values ('mg', 'mg', false, 5242880)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "mg select own" on storage.objects;
create policy "mg select own" on storage.objects for select to authenticated
  using (bucket_id = 'mg' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "mg insert own" on storage.objects;
create policy "mg insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'mg' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "mg update own" on storage.objects;
create policy "mg update own" on storage.objects for update to authenticated
  using (bucket_id = 'mg' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'mg' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "mg delete own" on storage.objects;
create policy "mg delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'mg' and (storage.foldername(name))[1] = (select auth.uid())::text);
