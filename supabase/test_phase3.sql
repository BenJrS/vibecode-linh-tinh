-- Test for phase3_sharing.sql. Creates throwaway users, exercises every rule, then ROLLS BACK by raising an exception.
do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); u4 uuid := gen_random_uuid();
  p uuid := gen_random_uuid(); m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid(); m3 uuid := gen_random_uuid();
  n int; out text[] := '{}';
  as_user constant text := 'select set_config(''request.jwt.claim.sub'', %L, true), set_config(''request.jwt.claims'', %L, true)';
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 's1@example.test'), (u2, 'authenticated', 'authenticated', 's2@example.test'),
    (u3, 'authenticated', 'authenticated', 's3@example.test'), (u4, 'authenticated', 'authenticated', 's4@example.test');
  insert into public.friendships (requester, addressee, status) values (u1, u2, 'accepted'), (u1, u4, 'accepted');
  insert into public.places (id, owner, name, mind_path) values (p, u1, 'Quán', 'u1/' || p || '/mind.bin');
  insert into public.memories (id, place_id, owner, x, y, text, photo_path) values (m1, p, u1, 0, 0, 'của u1', 'u1/' || p || '/m1.jpg');

  -- owner shares
  execute format(as_user, u1, json_build_object('sub', u1)::text);
  perform public.share_place(p, array[u2]);
  out := out || ('1 owner shared with friend u2')::text;
  begin perform public.share_place(p, array[u3]); out := out || '2 share with non-friend: ALLOWED'::text; exception when others then out := out || ('2 share with non-friend refused: ' || sqlerrm)::text; end;
  select count(*) into n from public.place_shares_of(p);
  out := out || ('3 owner sees share list (want 1): ' || n)::text;

  -- sharee u2
  execute format(as_user, u2, json_build_object('sub', u2)::text);
  execute 'set local role authenticated';
  select count(*) into n from public.places;        out := out || ('4 u2 sees place (want 1): ' || n)::text;
  select count(*) into n from public.memories;      out := out || ('5 u2 sees memories (want 1): ' || n)::text;
  select count(*) into n from public.profiles where id = u1; out := out || ('6 u2 sees owner profile (want 1): ' || n)::text;
  insert into public.memories (id, place_id, owner, x, y, text, photo_path) values (m2, p, u2, 1, 1, 'của u2', 'u2/' || p || '/m2.jpg');
  out := out || '7 u2 added own memory'::text;
  begin insert into public.memories (id, place_id, owner, x, y, text) values (gen_random_uuid(), p, u1, 0, 0, 'forged as u1'); out := out || '8 u2 forged memory as u1: ALLOWED'::text; exception when others then out := out || '8 u2 forged memory as u1 refused'::text; end;
  update public.memories set text = 'hacked' where id = m1; get diagnostics n = row_count; out := out || ('9 u2 edits u1 memory rows (want 0): ' || n)::text;
  out := out || ('10 u2 can read owner file: ' || public.can_read_object('u1/' || p || '/m1.jpg') || ', mind: ' || public.can_read_object('u1/' || p || '/mind.bin'))::text;
  begin perform public.share_place(p, array[u3]); out := out || '11 sharee reshares: ALLOWED'::text; exception when others then out := out || ('11 sharee reshare refused: ' || sqlerrm)::text; end;
  select count(*) into n from public.place_shares_of(p); out := out || ('12 sharee sees share list (want 0): ' || n)::text;
  execute 'reset role';

  -- owner sees and moderates
  execute format(as_user, u1, json_build_object('sub', u1)::text);
  execute 'set local role authenticated';
  select count(*) into n from public.memories; out := out || ('13 owner sees both memories (want 2): ' || n)::text;
  update public.memories set deleted_at = now() where id = m2; get diagnostics n = row_count; out := out || ('14 owner removes sharee memory rows (want 1): ' || n)::text;
  execute 'reset role';

  -- strangers
  execute format(as_user, u3, json_build_object('sub', u3)::text);
  execute 'set local role authenticated';
  select count(*) into n from public.places;   out := out || ('15 stranger sees places (want 0): ' || n)::text;
  select count(*) into n from public.memories; out := out || ('16 stranger sees memories (want 0): ' || n)::text;
  select count(*) into n from public.profiles where id = u1; out := out || ('17 stranger sees owner profile (want 0): ' || n)::text;
  begin insert into public.memories (id, place_id, owner, x, y, text) values (m3, p, u3, 0, 0, 'x'); out := out || '18 stranger adds memory: ALLOWED'::text; exception when others then out := out || '18 stranger add refused'::text; end;
  out := out || ('19 stranger reads file: ' || public.can_read_object('u1/' || p || '/m1.jpg'))::text;
  execute 'reset role';

  -- friend who was not chosen
  execute format(as_user, u4, json_build_object('sub', u4)::text);
  execute 'set local role authenticated';
  select count(*) into n from public.places; out := out || ('20 unchosen friend sees places (want 0): ' || n)::text;
  execute 'reset role';

  -- unfriending ends access
  delete from public.friendships where requester = u1 and addressee = u2;
  execute format(as_user, u2, json_build_object('sub', u2)::text);
  execute 'set local role authenticated';
  select count(*) into n from public.places; out := out || ('21 after unfriend u2 sees places (want 0): ' || n)::text;
  select count(*) into n from public.memories; out := out || ('22 after unfriend u2 sees memories (want 0): ' || n)::text;
  execute 'reset role';

  -- leaving
  insert into public.friendships (requester, addressee, status) values (u1, u2, 'accepted');
  execute format(as_user, u2, json_build_object('sub', u2)::text);
  perform public.leave_place(p);
  execute 'set local role authenticated';
  select count(*) into n from public.places; out := out || ('23 after leaving u2 sees places (want 0): ' || n)::text;
  execute 'reset role';

  raise exception E'TEST RESULT\n%', array_to_string(out, E'\n');
end $$;
