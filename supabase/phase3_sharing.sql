-- Memory-Graph, phase 3: share a place with chosen friends. Run after phase2_friends.sql. Safe to run again.
-- Rules: only the owner shares; only accepted friends can be chosen; friends can read the place and add their own memories;
-- the owner can remove anyone's memory, others only their own. Ending a friendship ends access immediately.

create table if not exists public.place_shares (
  place_id uuid not null references public.places (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (place_id, user_id)
);
create index if not exists place_shares_user on public.place_shares (user_id);
create index if not exists places_mind_path on public.places (mind_path);
create index if not exists memories_photo_path on public.memories (photo_path);
create index if not exists memories_audio_path on public.memories (audio_path);

-- ---------- helpers (security definer so policies can look across tables without recursion) ----------
create or replace function public.is_friend(a uuid, b uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.friendships
    where status = 'accepted' and least(requester, addressee) = least(a, b) and greatest(requester, addressee) = greatest(a, b));
$$;

create or replace function public.owns_place(pid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.places where id = pid and owner = auth.uid());
$$;

create or replace function public.can_read_place(pid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.places p where p.id = pid and (
    p.owner = auth.uid()
    or (public.is_friend(p.owner, auth.uid()) and exists (select 1 from public.place_shares s where s.place_id = p.id and s.user_id = auth.uid()))));
$$;

create or replace function public.can_read_object(obj text) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.places p where p.mind_path = obj and public.can_read_place(p.id))
      or exists (select 1 from public.memories m where (m.photo_path = obj or m.audio_path = obj) and public.can_read_place(m.place_id));
$$;

-- ---------- policies ----------
alter table public.place_shares enable row level security;
drop policy if exists "shares select" on public.place_shares;
create policy "shares select" on public.place_shares for select to authenticated
  using (user_id = (select auth.uid()) or public.owns_place(place_id));
-- no write policies: sharing changes only through share_place / leave_place

drop policy if exists "places select own" on public.places;
drop policy if exists "places select own or shared" on public.places;
create policy "places select own or shared" on public.places for select to authenticated
  using (owner = (select auth.uid()) or public.can_read_place(id));

drop policy if exists "memories select own" on public.memories;
drop policy if exists "memories select readable" on public.memories;
create policy "memories select readable" on public.memories for select to authenticated
  using (owner = (select auth.uid()) or public.can_read_place(place_id));

drop policy if exists "memories insert own" on public.memories;
drop policy if exists "memories insert into readable" on public.memories;
create policy "memories insert into readable" on public.memories for insert to authenticated
  with check (owner = (select auth.uid()) and public.can_read_place(place_id));

drop policy if exists "memories update own" on public.memories;
drop policy if exists "memories update own or place owner" on public.memories;
create policy "memories update own or place owner" on public.memories for update to authenticated
  using (owner = (select auth.uid()) or public.owns_place(place_id))
  with check (owner = (select auth.uid()) or public.owns_place(place_id));

drop policy if exists "profiles read friends" on public.profiles;
create policy "profiles read friends" on public.profiles for select to authenticated
  using (public.is_friend(id, (select auth.uid())));

drop policy if exists "mg select shared" on storage.objects;
create policy "mg select shared" on storage.objects for select to authenticated
  using (bucket_id = 'mg' and public.can_read_object(name));

-- ---------- functions ----------
create or replace function public.share_place(pid uuid, friend_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); f uuid; ids uuid[] := coalesce(friend_ids, '{}');
begin
  if me is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.places where id = pid and owner = me and deleted_at is null) then raise exception 'not your place'; end if;
  foreach f in array ids loop
    if not public.is_friend(me, f) then raise exception 'not a friend'; end if;
  end loop;
  delete from public.place_shares where place_id = pid and user_id <> all (ids);
  insert into public.place_shares (place_id, user_id) select pid, unnest(ids) on conflict do nothing;
  -- touch the place and its memories so every sharee's next sync picks them up
  update public.places set name = name where id = pid;
  update public.memories set text = text where place_id = pid;
end $$;

create or replace function public.place_shares_of(pid uuid) returns table (user_id uuid, display_name text)
language sql security definer stable set search_path = public as $$
  select s.user_id, p.display_name
  from public.place_shares s join public.profiles p on p.id = s.user_id
  where s.place_id = pid and public.owns_place(pid);
$$;

create or replace function public.leave_place(pid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from public.place_shares where place_id = pid and user_id = auth.uid();
end $$;

revoke all on function public.is_friend(uuid, uuid), public.owns_place(uuid), public.can_read_place(uuid), public.can_read_object(text),
  public.share_place(uuid, uuid[]), public.place_shares_of(uuid), public.leave_place(uuid) from public, anon;
grant execute on function public.is_friend(uuid, uuid), public.owns_place(uuid), public.can_read_place(uuid), public.can_read_object(text),
  public.share_place(uuid, uuid[]), public.place_shares_of(uuid), public.leave_place(uuid) to authenticated;
