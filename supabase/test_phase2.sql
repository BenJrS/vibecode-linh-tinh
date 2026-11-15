-- Test for phase2_friends.sql. Creates three throwaway users, exercises every rule, then ROLLS BACK
-- by raising an exception: nothing is kept. The result is printed in the error message.
do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  c1 text; c2 text; fid uuid; r jsonb; n int; out text[] := '{}';
  as_user constant text := 'select set_config(''request.jwt.claim.sub'', %L, true), set_config(''request.jwt.claims'', %L, true)';
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 't1@example.test'),
    (u2, 'authenticated', 'authenticated', 't2@example.test'),
    (u3, 'authenticated', 'authenticated', 't3@example.test');
  select friend_code into c1 from public.profiles where id = u1;
  select friend_code into c2 from public.profiles where id = u2;
  out := out || ('codes: ' || (length(c1) = 8 and c1 <> c2)::text);
  out := out || ('default name hides email: ' || ((select display_name from public.profiles where id = u1) = 'Người dùng')::text);

  execute format(as_user, u1, json_build_object('sub', u1)::text);
  r := public.friend_request_by_code(c2);  out := out || ('1 u1 asks u2: ' || (r->>'result'));
  r := public.friend_request_by_code(c2);  out := out || ('2 u1 asks again: ' || (r->>'result'));
  begin perform public.friend_request_by_code(c1); out := out || 'self: NOT BLOCKED'::text; exception when others then out := out || ('3 ask self refused: ' || sqlerrm); end;

  execute format(as_user, u2, json_build_object('sub', u2)::text);
  select count(*) into n from public.list_friendships() where status = 'pending' and direction = 'in';
  out := out || ('4 u2 sees incoming: ' || n);

  execute format(as_user, u3, json_build_object('sub', u3)::text);
  execute 'set local role authenticated';
  select count(*) into n from public.friendships;
  out := out || ('5 u3 reads others rows (want 0): ' || n);
  begin insert into public.friendships (requester, addressee, status) values (u3, u1, 'accepted'); out := out || '6 forged insert: ALLOWED'::text; exception when others then out := out || '6 forged insert refused'::text; end;
  begin update public.friendships set status = 'accepted'; get diagnostics n = row_count; out := out || ('7 forged update rows (want 0): ' || n); exception when others then out := out || '7 forged update refused'::text; end;
  begin perform public.lookup_friend_code(c1); out := out || '8 lookup as authenticated ok'::text; exception when others then out := out || ('8 lookup failed: ' || sqlerrm); end;
  execute 'reset role';

  execute format(as_user, u2, json_build_object('sub', u2)::text);
  select id into fid from public.list_friendships() where direction = 'in' limit 1;
  perform public.respond_friend_request(fid, true);
  select count(*) into n from public.list_friendships() where status = 'accepted';
  out := out || ('9 u2 accepted, friends: ' || n);
  r := public.friend_request_by_code(c1);  out := out || ('10 u2 asks u1 again: ' || (r->>'result'));

  execute format(as_user, u1, json_build_object('sub', u1)::text);
  perform public.block_user(u2);
  execute format(as_user, u2, json_build_object('sub', u2)::text);
  select count(*) into n from public.list_friendships();
  out := out || ('11 u2 sees after being blocked (want 0): ' || n);
  begin perform public.friend_request_by_code(c1); out := out || '12 blocked asks: ALLOWED'::text; exception when others then out := out || ('12 blocked asks refused: ' || sqlerrm); end;

  execute format(as_user, u1, json_build_object('sub', u1)::text);
  select id into fid from public.list_friendships() where status = 'blocked';
  perform public.remove_friendship(fid);
  select count(*) into n from public.list_friendships();
  out := out || ('13 u1 unblocked, rows: ' || n);

  execute format(as_user, u3, json_build_object('sub', u3)::text);
  r := public.friend_request_by_code(c1);
  execute format(as_user, u1, json_build_object('sub', u1)::text);
  select id into fid from public.list_friendships() where direction = 'in';
  execute format(as_user, u2, json_build_object('sub', u2)::text);
  perform public.remove_friendship(fid);   -- u2 is not a party: must do nothing
  execute format(as_user, u1, json_build_object('sub', u1)::text);
  select count(*) into n from public.list_friendships();
  out := out || ('14 stranger cannot remove my row (want 1): ' || n);
  perform public.respond_friend_request(fid, false);
  select count(*) into n from public.list_friendships();
  out := out || ('15 declined, rows (want 0): ' || n);

  raise exception E'TEST RESULT\n%', array_to_string(out, E'\n');
end $$;
