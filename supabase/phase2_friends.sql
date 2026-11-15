-- Memory-Graph, phase 2: friends. Run after schema.sql. Safe to run again.
-- Friendship rows can only be changed through the functions below (security definer),
-- so nobody can add themselves to someone else's friend list.

-- ---------- profile: a public name and a short friend code ----------
alter table public.profiles add column if not exists friend_code text;
update public.profiles set friend_code = substr(md5(random()::text || id::text), 1, 8) where friend_code is null;
alter table public.profiles alter column friend_code set default substr(md5(random()::text || clock_timestamp()::text), 1, 8);
alter table public.profiles alter column friend_code set not null;
create unique index if not exists profiles_friend_code_key on public.profiles (friend_code);

-- phase 1 used the part of the email before the @ as a name: friends would see it, so reset it
update public.profiles p set display_name = 'Người dùng'
from auth.users u where u.id = p.id and p.display_name = split_part(u.email, '@', 1);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name) values (new.id, 'Người dùng') on conflict (id) do nothing;
  return new;
end $$;

alter table public.profiles drop constraint if exists profiles_name_len;
alter table public.profiles add constraint profiles_name_len check (display_name is null or char_length(display_name) between 1 and 40);

-- ---------- friendships ----------
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references auth.users (id) on delete cascade,   -- for 'blocked': the person who blocked
  addressee uuid not null references auth.users (id) on delete cascade,
  status text not null check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee on public.friendships (addressee);

drop trigger if exists friendships_touch on public.friendships;
create trigger friendships_touch before update on public.friendships
  for each row execute function public.touch_updated_at();

alter table public.friendships enable row level security;
drop policy if exists "friendships select own" on public.friendships;
create policy "friendships select own" on public.friendships for select to authenticated
  using (requester = (select auth.uid()) or addressee = (select auth.uid()));
-- no insert/update/delete policies on purpose: only the functions below can write

-- ---------- functions ----------
create or replace function public.lookup_friend_code(code text) returns text
language plpgsql security definer set search_path = public stable as $$
declare n text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select display_name into n from public.profiles where friend_code = lower(trim(code)) and id <> auth.uid();
  return n;
end $$;

create or replace function public.friend_request_by_code(code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); t uuid; tname text; ex public.friendships;
begin
  if me is null then raise exception 'not signed in'; end if;
  select id, display_name into t, tname from public.profiles where friend_code = lower(trim(code));
  if t is null or t = me then raise exception 'invalid code'; end if;
  select * into ex from public.friendships
    where least(requester, addressee) = least(me, t) and greatest(requester, addressee) = greatest(me, t);
  if found then
    if ex.status = 'blocked' then raise exception 'unavailable'; end if;
    if ex.status = 'accepted' then return jsonb_build_object('result', 'already', 'name', tname); end if;
    if ex.addressee = me then   -- they asked me first: asking back means yes
      update public.friendships set status = 'accepted' where id = ex.id;
      return jsonb_build_object('result', 'accepted', 'name', tname);
    end if;
    return jsonb_build_object('result', 'pending', 'name', tname);
  end if;
  insert into public.friendships (requester, addressee, status) values (me, t, 'pending');
  return jsonb_build_object('result', 'sent', 'name', tname);
end $$;

create or replace function public.list_friendships() returns table (id uuid, other uuid, display_name text, status text, direction text)
language sql security definer set search_path = public stable as $$
  select f.id,
         o.id,
         o.display_name,
         f.status,
         case when f.requester = auth.uid() then 'out' else 'in' end
  from public.friendships f
  join public.profiles o on o.id = case when f.requester = auth.uid() then f.addressee else f.requester end
  where (f.requester = auth.uid() or f.addressee = auth.uid())
    and not (f.status = 'blocked' and f.addressee = auth.uid())   -- the blocked person sees nothing
  order by f.updated_at desc;
$$;

create or replace function public.respond_friend_request(fid uuid, accept boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if accept then
    update public.friendships set status = 'accepted' where id = fid and addressee = auth.uid() and status = 'pending';
  else
    delete from public.friendships where id = fid and addressee = auth.uid() and status = 'pending';
  end if;
end $$;

-- remove a friend, cancel my own request, or unblock someone I blocked
create or replace function public.remove_friendship(fid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from public.friendships
  where id = fid and (requester = auth.uid() or addressee = auth.uid())
    and not (status = 'blocked' and addressee = auth.uid());
end $$;

create or replace function public.block_user(other uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or other is null or other = me then raise exception 'invalid'; end if;
  delete from public.friendships
    where least(requester, addressee) = least(me, other) and greatest(requester, addressee) = greatest(me, other);
  insert into public.friendships (requester, addressee, status) values (me, other, 'blocked');
end $$;

revoke all on function public.lookup_friend_code(text), public.friend_request_by_code(text), public.list_friendships(),
  public.respond_friend_request(uuid, boolean), public.remove_friendship(uuid), public.block_user(uuid) from public, anon;
grant execute on function public.lookup_friend_code(text), public.friend_request_by_code(text), public.list_friendships(),
  public.respond_friend_request(uuid, boolean), public.remove_friendship(uuid), public.block_user(uuid) to authenticated;
