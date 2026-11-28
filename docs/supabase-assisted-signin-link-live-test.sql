-- ============================================================================
-- LIVE TEST for docs/supabase-assisted-signin-link.sql (rev 2). ALWAYS ROLLS BACK.
-- Run in the Supabase SQL editor AFTER that file, as ONE script. Success
-- ends with
--   ERROR: TEST OK, rolled back: ...
-- and any failure ends with a different error. Nothing is ever kept: no
-- draft, link, auth user, profile, application, kitchen, token, attempt or
-- audit row.
--
-- Fill in ONE value (Find/replace):
--   PUT-ADMIN-ID   your own admin profile id
-- It makes its own throw-away shops "TEST Sign-in Live Test Shop" (owner
-- mobile 89999995) and "TEST Sign-in Live Test Draft" (89999994), claims the
-- first with a throw-away auth user (@example.invalid) the way the Partner
-- server does, and refuses to run if either mobile already has an open
-- draft. No real merchant, kitchen or account is read or changed. Its client
-- keys are random, so no real caller's rate limit is touched.
--
-- Callers are real sessions, the way PostgREST runs them: HQ = role
-- authenticated with your admin id as the JWT sub; the owner = role
-- authenticated with the owner's id; the Partner server = role service_role;
-- anon = role anon.
--
-- What it proves:
--   1. (1) refuses a draft, a cancelled shop, an unknown shop and a bad hash:
--      only claimed shops.
--   2. (1) on the claimed shop stores exactly the hash Boss sent, for the
--      shop's claimed_user_id, 2 hours.
--   3. Issuing again revokes the older unused link; the older one is 'revoked'.
--   4. (2) answers {"status":"ok","user_id":<owner>} for the live link, once
--      only: a second use is 'used'. Unknown, malformed and NULL tokens are
--      'invalid'. A bad client key raises.
--   5. An expired link is 'expired' and not marked used.
--   6. A link whose shop is cancelled is 'cancelled'.
--   7. Rate limit, per client key: after 10 failed attempts in 15 minutes the
--      next call is 'rate_limited', even with a good link, and that link is not
--      used; another client key is not affected; 60 attempts in total also
--      limit.
--   8. (1) is refused for the owner (a signed-in non-admin), anon and
--      service_role. (2) is refused for anon, the owner and an admin session.
--   9. The audit: issued x5, revoked x3 (links 1, 3 and 4: an expired link
--      and one refused as 'cancelled' stay open until the next issue), used
--      x2 (links 2 and 5), never a token or a hash; it
--      is append-only. No auth user was created or deleted by (1) or (2); the
--      owner's account and role are unchanged.
-- ============================================================================

begin;

select set_config('kbt.admin', 'PUT-ADMIN-ID', true);

-- ---- Setup (as postgres) ---------------------------------------------------
do $$
declare
  n int;
begin
  if current_setting('kbt.admin') like 'PUT-%' then
    raise exception 'REFUSED: fill in PUT-ADMIN-ID first';
  end if;
  if to_regprocedure('public.assisted_signin_consume(text, text)') is null
     or to_regprocedure('public.admin_issue_assisted_signin_link(uuid, text)') is null then
    raise exception 'REFUSED: run docs/supabase-assisted-signin-link.sql (rev 2) first';
  end if;
  if not exists (select 1 from public.profiles where id = current_setting('kbt.admin')::uuid and role = 'admin') then
    raise exception 'FAIL setup: PUT-ADMIN-ID is not an admin profile';
  end if;
  if exists (select 1 from public.assisted_shops where status = 'draft' and owner_mobile in ('89999995', '89999994')) then
    raise exception 'REFUSED: a real open draft uses the test mobile number 89999995 or 89999994';
  end if;

  perform set_config('kbt.claim_hash', encode(sha256(convert_to('kb-signin-live-test-claim-' || gen_random_uuid(), 'UTF8')), 'hex'), true);
  perform set_config('kbt.claim_client', encode(sha256(convert_to('kb-signin-live-test-claim-client-' || gen_random_uuid(), 'UTF8')), 'hex'), true);
  perform set_config('kbt.client', encode(sha256(convert_to('kb-signin-live-test-client-' || gen_random_uuid(), 'UTF8')), 'hex'), true);
  perform set_config('kbt.owner', gen_random_uuid()::text, true);
  -- Five sign-in tokens, made the way Boss makes them; only their hashes are sent.
  for n in 1..5 loop
    perform set_config('kbt.raw' || n, 'kb-signin-live-test-' || n || '-' || gen_random_uuid(), true);
    perform set_config('kbt.h' || n, encode(sha256(convert_to(current_setting('kbt.raw' || n), 'UTF8')), 'hex'), true);
  end loop;
end;
$$;

-- ---- 1. HQ: a Home Cook draft to claim, and a second draft -------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_shop uuid;
  v_draft uuid;
  v_msg text;
begin
  insert into public.assisted_shops
    (business_name, category, cuisine_type, is_halal, description, owner_name, owner_mobile,
     business_uen, business_address, postal_code)
  values
    ('TEST Sign-in Live Test Shop', 'home-cook', 'chinese', false, 'Sign-in live test', 'KB Sign-in Live Test Owner', '89999995',
     null, 'Blk 1 Test Lane', '310123')
  returning id into v_shop;
  perform set_config('kbt.shop', v_shop::text, true);
  insert into public.assisted_shop_items (shop_id, name, price) values (v_shop, 'Sign-in Live Test Noodles', 4.50);
  perform public.admin_issue_assisted_claim_link(v_shop, current_setting('kbt.claim_hash'));

  insert into public.assisted_shops
    (business_name, category, cuisine_type, is_halal, owner_name, owner_mobile, business_address, postal_code)
  values
    ('TEST Sign-in Live Test Draft', 'home-cook', 'chinese', false, 'KB Sign-in Live Test Draft Owner', '89999994',
     'Blk 2 Test Lane', '310124')
  returning id into v_draft;
  perform set_config('kbt.draft', v_draft::text, true);

  -- Only claimed shops: a draft (the shop to claim, before its claim, and the second one) is refused.
  foreach v_shop in array array[current_setting('kbt.shop')::uuid, v_draft] loop
    v_msg := null;
    begin
      perform public.admin_issue_assisted_signin_link(v_shop, current_setting('kbt.h1'));
    exception when others then v_msg := sqlerrm;
    end;
    if v_msg is null or v_msg not like 'A sign-in link is only for a shop the owner has already claimed%' then
      raise exception 'FAIL 1: a draft was not refused (%)', coalesce(v_msg, 'no error');
    end if;
  end loop;

  -- A cancelled shop is refused too.
  perform public.admin_cancel_assisted_shop(v_draft, 'sign-in live test');
  v_msg := null;
  begin
    perform public.admin_issue_assisted_signin_link(v_draft, current_setting('kbt.h1'));
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'A sign-in link is only for a shop the owner has already claimed%' then
    raise exception 'FAIL 1: a cancelled shop was not refused (%)', coalesce(v_msg, 'no error');
  end if;

  v_msg := null;
  begin
    perform public.admin_issue_assisted_signin_link(gen_random_uuid(), current_setting('kbt.h1'));
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Shop not found%' then
    raise exception 'FAIL 1: an unknown shop was not refused (%)', coalesce(v_msg, 'no error');
  end if;

  v_msg := null;
  begin
    perform public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, current_setting('kbt.raw1'));
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Invalid sign-in token%' then
    raise exception 'FAIL 1: a raw token (not a hash) was not refused (%)', coalesce(v_msg, 'no error');
  end if;
end;
$$;

-- ---- The owner's account and claim, as the Partner server makes them ----------
reset role;
select set_config('request.jwt.claims', '', true);
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (current_setting('kbt.owner')::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'kb-signin-live-test-owner@example.invalid',
        jsonb_build_object('kb_assisted_shop_id', current_setting('kbt.shop')), '{}'::jsonb, now(), now());

set local role service_role;
do $$
declare
  v jsonb;
begin
  v := public.assisted_claim_complete(current_setting('kbt.claim_hash'), current_setting('kbt.claim_client'),
    current_setting('kbt.owner')::uuid, 'KB sign-in live test UA', '2026-10-v1');
  if v ->> 'status' <> 'ok' then
    raise exception 'FAIL setup: the claim failed: %', v;
  end if;
end;
$$;

reset role;
select set_config('kbt.users_before', (select count(*) from auth.users)::text, true);
do $$
begin
  if (select status from public.assisted_shops where id = current_setting('kbt.shop')::uuid) <> 'claimed'
     or (select claimed_user_id from public.assisted_shops where id = current_setting('kbt.shop')::uuid)
          is distinct from current_setting('kbt.owner')::uuid then
    raise exception 'FAIL setup: the shop is not claimed by the test owner';
  end if;
end;
$$;

-- ---- 2-3. HQ: two sign-in links; the second revokes the first ------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  r1 record;
  r2 record;
begin
  select * into r1 from public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, current_setting('kbt.h1'));
  if r1.token_id is null
     or r1.expires_at < now() + interval '119 minutes' or r1.expires_at > now() + interval '121 minutes' then
    raise exception 'FAIL 2: no link, or it does not expire in 2 hours (%)', r1.expires_at;
  end if;
  perform set_config('kbt.t1_id', r1.token_id::text, true);

  select * into r2 from public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, current_setting('kbt.h2'));
  if r2.token_id is null or r2.token_id = r1.token_id then
    raise exception 'FAIL 3: the second link is not a new link';
  end if;
  perform set_config('kbt.t2_id', r2.token_id::text, true);
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
do $$
declare
  t public.assisted_signin_tokens;
begin
  select * into t from public.assisted_signin_tokens where id = current_setting('kbt.t2_id')::uuid;
  if t.token_hash <> current_setting('kbt.h2') then
    raise exception 'FAIL 2: the stored hash is not the one Boss sent';
  end if;
  if t.user_id <> current_setting('kbt.owner')::uuid or t.shop_id <> current_setting('kbt.shop')::uuid
     or t.created_by <> current_setting('kbt.admin')::uuid then
    raise exception 'FAIL 2: the link is not for the claimed owner, or not by the admin';
  end if;

  select * into t from public.assisted_signin_tokens where id = current_setting('kbt.t1_id')::uuid;
  if t.revoked_at is null or t.used_at is not null or t.revoke_reason <> 'replaced by a new link' then
    raise exception 'FAIL 3: the older link was not revoked';
  end if;
end;
$$;

-- ---- 3-4. The Partner server uses the links --------------------------------------
set local role service_role;

do $$
declare
  c text := current_setting('kbt.client');
  v jsonb;
  v_msg text;
begin
  v := public.assisted_signin_consume(current_setting('kbt.h1'), c);
  if v <> '{"status": "revoked"}'::jsonb then
    raise exception 'FAIL 3: the revoked older link answered %', v;
  end if;

  v := public.assisted_signin_consume(current_setting('kbt.h2'), c);
  if v <> jsonb_build_object('status', 'ok', 'user_id', current_setting('kbt.owner')::uuid) then
    raise exception 'FAIL 4: the live link answered %', v;
  end if;

  v := public.assisted_signin_consume(current_setting('kbt.h2'), c);
  if v <> '{"status": "used"}'::jsonb then
    raise exception 'FAIL 4: the link worked twice (%)', v;
  end if;

  if public.assisted_signin_consume(encode(sha256(convert_to('kb-not-a-token', 'UTF8')), 'hex'), c) <> '{"status": "invalid"}'::jsonb
     or public.assisted_signin_consume(current_setting('kbt.raw2'), c) <> '{"status": "invalid"}'::jsonb   -- the raw token, not its hash
     or public.assisted_signin_consume(null, c) <> '{"status": "invalid"}'::jsonb then
    raise exception 'FAIL 4: an unknown, malformed or NULL token was not invalid';
  end if;

  begin
    perform public.assisted_signin_consume(current_setting('kbt.h2'), 'not-a-key');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'assisted_signin: bad client key%' then
    raise exception 'FAIL 4: a bad client key did not raise (%)', coalesce(v_msg, 'no error');
  end if;
end;
$$;

-- ---- 5-6. An expired link, and a link whose shop is cancelled -------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select set_config('kbt.t3_id',
  (select token_id from public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, current_setting('kbt.h3')))::text, true);

reset role;
select set_config('request.jwt.claims', '', true);
update public.assisted_signin_tokens
set created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
where id = current_setting('kbt.t3_id')::uuid;

set local role service_role;
do $$
declare
  v jsonb;
begin
  -- A fresh client key: the earlier failures don't count here.
  perform set_config('kbt.client2', encode(sha256(convert_to('kb-signin-live-test-client2-' || gen_random_uuid(), 'UTF8')), 'hex'), true);
  v := public.assisted_signin_consume(current_setting('kbt.h3'), current_setting('kbt.client2'));
  if v <> '{"status": "expired"}'::jsonb then
    raise exception 'FAIL 5: an expired link answered %', v;
  end if;
end;
$$;

reset role;
do $$
begin
  if (select used_at from public.assisted_signin_tokens where id = current_setting('kbt.t3_id')::uuid) is not null then
    raise exception 'FAIL 5: an expired link was marked used';
  end if;
end;
$$;

select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select set_config('kbt.t4_id',
  (select token_id from public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, current_setting('kbt.h4')))::text, true);

-- Only for this test (rolled back): the shop marked cancelled. No function can do this to a claimed shop.
reset role;
select set_config('request.jwt.claims', '', true);
update public.assisted_shops set status = 'cancelled' where id = current_setting('kbt.shop')::uuid;

set local role service_role;
do $$
declare
  v jsonb;
begin
  v := public.assisted_signin_consume(current_setting('kbt.h4'), current_setting('kbt.client2'));
  if v <> '{"status": "cancelled"}'::jsonb then
    raise exception 'FAIL 6: a link for a cancelled shop answered %', v;
  end if;
end;
$$;

reset role;
update public.assisted_shops set status = 'claimed' where id = current_setting('kbt.shop')::uuid;

-- ---- 7. Rate limit ----------------------------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select set_config('kbt.t5_id',
  (select token_id from public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, current_setting('kbt.h5')))::text, true);

reset role;
select set_config('request.jwt.claims', '', true);
set local role service_role;
do $$
declare
  c text := encode(sha256(convert_to('kb-signin-live-test-client3-' || gen_random_uuid(), 'UTF8')), 'hex');
  v jsonb;
  n int;
begin
  perform set_config('kbt.client3', c, true);
  -- 10 failed attempts (unknown tokens) from one client key...
  for n in 1..10 loop
    v := public.assisted_signin_consume(encode(sha256(convert_to('kb-not-a-token-' || n, 'UTF8')), 'hex'), c);
    if v <> '{"status": "invalid"}'::jsonb then
      raise exception 'FAIL 7: failed attempt % answered %', n, v;
    end if;
  end loop;
  -- ...then even the good link is refused for that key.
  v := public.assisted_signin_consume(current_setting('kbt.h5'), c);
  if v <> '{"status": "rate_limited"}'::jsonb then
    raise exception 'FAIL 7: after 10 failed attempts the next call answered %', v;
  end if;
end;
$$;

reset role;
do $$
begin
  if (select used_at from public.assisted_signin_tokens where id = current_setting('kbt.t5_id')::uuid) is not null then
    raise exception 'FAIL 7: a rate-limited call marked the link used';
  end if;
  -- 60 attempts in total from another key (written here as postgres; all 'ok', so only the total counts).
  perform set_config('kbt.client4', encode(sha256(convert_to('kb-signin-live-test-client4-' || gen_random_uuid(), 'UTF8')), 'hex'), true);
  insert into public.assisted_signin_attempts (client_key, result)
  select current_setting('kbt.client4'), 'ok' from generate_series(1, 60);
end;
$$;

set local role service_role;
do $$
declare
  v jsonb;
begin
  v := public.assisted_signin_consume(current_setting('kbt.h5'), current_setting('kbt.client4'));
  if v <> '{"status": "rate_limited"}'::jsonb then
    raise exception 'FAIL 7: after 60 attempts the next call answered %', v;
  end if;
  -- Another client key is not affected: the same good link works.
  v := public.assisted_signin_consume(current_setting('kbt.h5'),
         encode(sha256(convert_to('kb-signin-live-test-client5-' || gen_random_uuid(), 'UTF8')), 'hex'));
  if v <> jsonb_build_object('status', 'ok', 'user_id', current_setting('kbt.owner')::uuid) then
    raise exception 'FAIL 7: another client key was limited too (%)', v;
  end if;
end;
$$;

-- ---- 8. Who may call what ------------------------------------------------------
-- The owner: a signed-in user who is not an admin.
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.owner'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_msg text;
begin
  begin
    perform public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, repeat('1', 64));
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Not allowed: admins only%' then
    raise exception 'FAIL 8: the owner (not an admin) could call (1) (%)', coalesce(v_msg, 'no error');
  end if;

  v_msg := null;
  begin
    perform public.assisted_signin_consume(repeat('0', 64), repeat('0', 64));
  exception when insufficient_privilege then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'permission denied%' then
    raise exception 'FAIL 8: the owner (authenticated) could call (2)';
  end if;
end;
$$;

-- An admin session is still only authenticated: (2) is refused.
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
do $$
declare
  v_msg text;
begin
  begin
    perform public.assisted_signin_consume(repeat('0', 64), repeat('0', 64));
  exception when insufficient_privilege then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'permission denied%' then
    raise exception 'FAIL 8: an admin session (authenticated) could call (2)';
  end if;
end;
$$;

-- anon.
reset role;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
set local role anon;
do $$
declare
  v_msg text;
begin
  begin
    perform public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, repeat('1', 64));
  exception when insufficient_privilege then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'permission denied%' then
    raise exception 'FAIL 8: anon could call (1)';
  end if;

  v_msg := null;
  begin
    perform public.assisted_signin_consume(repeat('0', 64), repeat('0', 64));
  exception when insufficient_privilege then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'permission denied%' then
    raise exception 'FAIL 8: anon could call (2)';
  end if;
end;
$$;

-- service_role can't issue links.
reset role;
select set_config('request.jwt.claims', '', true);
set local role service_role;
do $$
declare
  v_msg text;
begin
  begin
    perform public.admin_issue_assisted_signin_link(current_setting('kbt.shop')::uuid, repeat('1', 64));
  exception when insufficient_privilege then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'permission denied%' then
    raise exception 'FAIL 8: service_role could call (1)';
  end if;
end;
$$;

-- ---- 9. Audit, privileges, accounts (as postgres) ----------------------------------
reset role;
do $$
declare
  v_msg text;
  n int;
begin
  if has_function_privilege('anon', 'public.assisted_signin_consume(text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.assisted_signin_consume(text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.assisted_signin_consume(text, text)', 'execute')
     or has_function_privilege('anon', 'public.admin_issue_assisted_signin_link(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.assisted_signin_rate_limited(text)', 'execute')
     or has_table_privilege('service_role', 'public.assisted_signin_attempts', 'select, insert, update, delete') then
    raise exception 'FAIL 9: privileges are wrong';
  end if;

  if (select count(*) from public.assisted_signin_audit
      where shop_id = current_setting('kbt.shop')::uuid and action = 'signin_link_issued'
        and actor_kind = 'admin' and actor_id = current_setting('kbt.admin')::uuid
        and user_id = current_setting('kbt.owner')::uuid) <> 5 then
    raise exception 'FAIL 9: expected 5 issued rows in the audit';
  end if;
  -- Revoked: link 1 (by link 2), link 3 (expired, still open, by link 4) and link 4 (refused as
  -- 'cancelled', still open, by link 5). Link 2 was already used when link 3 was issued.
  select count(*) into n from public.assisted_signin_audit
  where shop_id = current_setting('kbt.shop')::uuid and action = 'signin_link_revoked';
  if n <> 3
     or not exists (select 1 from public.assisted_signin_audit where action = 'signin_link_revoked' and token_id = current_setting('kbt.t1_id')::uuid)
     or not exists (select 1 from public.assisted_signin_audit where action = 'signin_link_revoked' and token_id = current_setting('kbt.t3_id')::uuid)
     or not exists (select 1 from public.assisted_signin_audit where action = 'signin_link_revoked' and token_id = current_setting('kbt.t4_id')::uuid) then
    raise exception 'FAIL 9: expected 3 revoked rows (links 1, 3 and 4), got %', n;
  end if;
  if (select count(*) from public.assisted_signin_audit
      where shop_id = current_setting('kbt.shop')::uuid and action = 'signin_link_used' and actor_kind = 'owner'
        and actor_id = current_setting('kbt.owner')::uuid
        and token_id in (current_setting('kbt.t2_id')::uuid, current_setting('kbt.t5_id')::uuid)) <> 2
     or (select count(*) from public.assisted_signin_audit
         where shop_id = current_setting('kbt.shop')::uuid and action = 'signin_link_used') <> 2 then
    raise exception 'FAIL 9: expected exactly 2 used rows (links 2 and 5)';
  end if;
  if exists (select 1 from public.assisted_signin_audit a
             where a.shop_id = current_setting('kbt.shop')::uuid
               and (a.details::text ~ '[0-9a-f]{64}' or a.details::text like '%kb-signin-live-test-%')) then
    raise exception 'FAIL 9: a token or a hash is in the audit';
  end if;

  begin
    update public.assisted_signin_audit set details = '{}'::jsonb where shop_id = current_setting('kbt.shop')::uuid;
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'assisted_signin_audit is append-only%' then
    raise exception 'FAIL 9: the audit is not append-only (%)', coalesce(v_msg, 'no error');
  end if;

  if (select count(*) from auth.users)::text <> current_setting('kbt.users_before') then
    raise exception 'FAIL 9: the number of auth users changed';
  end if;
  if (select role from public.profiles where id = current_setting('kbt.owner')::uuid) <> 'cook'
     or (select status from public.assisted_shops where id = current_setting('kbt.shop')::uuid) <> 'claimed'
     or (select claimed_user_id from public.assisted_shops where id = current_setting('kbt.shop')::uuid)
          is distinct from current_setting('kbt.owner')::uuid then
    raise exception 'FAIL 9: the owner or the shop changed';
  end if;

  raise exception 'TEST OK, rolled back: sign-in links only for claimed shops (draft, cancelled, unknown shop and a non-hash refused), the hash Boss sent is stored for the claimed owner, 2 hours; a new link revokes the older one, which is then revoked; ok + user_id once, then used; unknown/malformed/NULL invalid; bad client key raises; expired is expired and not used; cancelled shop is cancelled; rate limited after 10 failed or 60 in total, per client key, without using the link; (1) refused for the owner, anon and service_role, (2) refused for anon, the owner and an admin session; audit issued x5 / revoked x3 / used x2 with no token or hash, append-only; no auth user created or deleted, owner and shop unchanged. Nothing was saved.';
end;
$$;

rollback;
