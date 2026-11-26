-- ============================================================================
-- LIVE TEST for supabase-assisted-uen-later. ALWAYS ROLLS BACK.
-- Run in the Supabase SQL editor AFTER docs/supabase-assisted-uen-later.sql,
-- as ONE script. Success ends with
--   ERROR: TEST OK, rolled back: ...
-- and any failure ends with a different error. Nothing is ever kept: no
-- draft, link, auth user, profile, application, kitchen or audit row.
--
-- Fill in ONE value (Find/replace):
--   PUT-ADMIN-ID   your own admin profile id
-- It makes its own throw-away draft "TEST UEN Live Test Shop" (owner mobile
-- 89999996) and throw-away auth users (@example.invalid), and refuses to run
-- if that mobile already has an open draft. No real merchant or kitchen is
-- read or changed.
--
-- Every owner step runs as a REAL owner session: role authenticated with the
-- owner's id as the JWT sub, the way PostgREST runs the Partner app. Not
-- admin, not postgres; step 6 checks that first.
--
-- What it proves:
--   1. HQ can send the claim link for a Hawker draft with no UEN.
--   2-4. The claim works with no UEN: approved 'Hawker' application with no
--      UEN, role cook, kitchen not live and with no UEN; the flag is off afterwards.
--   5. A normal applicant's Hawker application with no UEN is still refused,
--      also with the flag set in their own session; with a UEN it goes in.
--   6. Owner session: going live with no UEN is refused, also after
--      switching the category to Home Cook; PayNow still saves (never stuck);
--      a bad or empty UEN is refused; a good UEN is saved (application and
--      kitchen), a corrected one too; writing kitchens.business_uen directly
--      changes nothing; going live then works; once live, the owner can't
--      change the UEN, and can't call the HQ function.
--   7. The owner's terms acknowledgement and privacy fields never changed.
--   8. HQ: wrong name, no reason, bad UEN refused; a correction on the live
--      shop works and is in kitchen_admin_audit with its reason; HQ still
--      can't write business_uen directly (a_kitchen_admin_guard).
--   8b. An admin's own session (authenticated, admin), with the flag on and
--      an approved row, still can't insert a Hawker application with no UEN:
--      the current_user condition on its own.
--   9. anon can't call either function.
--   10-11. Shops that exist today keep working: a live Hawker kitchen with no
--      UEN (as approved before UENs were asked) still saves, by update and by
--      upsert, and stays live; a new kitchen that needs a UEN can't be
--      inserted live; a Home Cook or a kitchen with no approved application
--      can go live with no UEN.
--   12. The six untouched functions still match their pre-change
--      fingerprints, the three changed ones match the new ones, and the flag
--      is off.
-- ============================================================================

begin;

select set_config('kbt.admin', 'PUT-ADMIN-ID', true);

-- ---- Setup (as postgres) ---------------------------------------------------
do $$
begin
  if current_setting('kbt.admin') like 'PUT-%' then
    raise exception 'REFUSED: fill in PUT-ADMIN-ID first';
  end if;
  if not exists (select 1 from public.profiles where id = current_setting('kbt.admin')::uuid and role = 'admin') then
    raise exception 'FAIL setup: PUT-ADMIN-ID is not an admin profile';
  end if;
  if to_regprocedure('public.set_my_business_uen(text)') is null then
    raise exception 'REFUSED: run docs/supabase-assisted-uen-later.sql first';
  end if;
  if exists (select 1 from public.assisted_shops where status = 'draft' and owner_mobile = '89999996') then
    raise exception 'REFUSED: a real open draft uses the test mobile number 89999996';
  end if;

  perform set_config('kbt.raw', 'kb-uen-live-test-' || gen_random_uuid(), true);
  perform set_config('kbt.hash', encode(sha256(convert_to(current_setting('kbt.raw'), 'UTF8')), 'hex'), true);
  perform set_config('kbt.client', encode(sha256(convert_to('kb-uen-live-test-client-' || gen_random_uuid(), 'UTF8')), 'hex'), true);
  perform set_config('kbt.owner', gen_random_uuid()::text, true);      -- claims the no-UEN Hawker
  perform set_config('kbt.applicant', gen_random_uuid()::text, true);  -- a normal sign-up
  perform set_config('kbt.legacy', gen_random_uuid()::text, true);     -- live Hawker approved before UENs
  perform set_config('kbt.fresh', gen_random_uuid()::text, true);      -- approved Hawker, no UEN, no kitchen yet
  perform set_config('kbt.homecook', gen_random_uuid()::text, true);   -- approved Home Cook
  perform set_config('kbt.noapp', gen_random_uuid()::text, true);      -- no approved application
end;
$$;

-- ---- 1. HQ: a Hawker draft with no UEN, and its claim link -------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_shop uuid;
  v_tok record;
begin
  insert into public.assisted_shops
    (business_name, category, cuisine_type, is_halal, description, owner_name, owner_mobile,
     business_uen, business_address, postal_code)
  values
    ('TEST UEN Live Test Shop', 'hawker', 'chinese', false, 'UEN live test', 'KB UEN Live Test Owner', '89999996',
     null, 'Blk 1 Test Lane', '310123')
  returning id into v_shop;
  perform set_config('kbt.shop', v_shop::text, true);
  insert into public.assisted_shop_items (shop_id, name, price) values (v_shop, 'UEN Live Test Noodles', 4.50);

  select * into v_tok from public.admin_issue_assisted_claim_link(v_shop, current_setting('kbt.hash'));
  if v_tok.token_id is null then
    raise exception 'FAIL 1: no claim link for a Hawker draft with no UEN';
  end if;
end;
$$;

-- ---- 2. The auth users the Partner server would create (as postgres here) ---
reset role;
select set_config('request.jwt.claims', '', true);
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select u.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email, u.meta, '{}'::jsonb, now(), now()
from (values
  (current_setting('kbt.owner'), 'kb-uen-live-test-owner@example.invalid', jsonb_build_object('kb_assisted_shop_id', current_setting('kbt.shop'))),
  (current_setting('kbt.applicant'), 'kb-uen-live-test-applicant@example.invalid', '{}'::jsonb),
  (current_setting('kbt.legacy'), 'kb-uen-live-test-legacy@example.invalid', '{}'::jsonb),
  (current_setting('kbt.fresh'), 'kb-uen-live-test-fresh@example.invalid', '{}'::jsonb),
  (current_setting('kbt.homecook'), 'kb-uen-live-test-homecook@example.invalid', '{}'::jsonb),
  (current_setting('kbt.noapp'), 'kb-uen-live-test-noapp@example.invalid', '{}'::jsonb)
) as u(id, email, meta);

-- ---- 3. The owner's claim (service_role, as the Partner server) --------------
set local role service_role;

do $$
declare
  v jsonb;
begin
  v := public.assisted_claim_complete(current_setting('kbt.hash'), current_setting('kbt.client'),
    current_setting('kbt.owner')::uuid, 'KB UEN live test UA', '2026-10-v1');
  if v ->> 'status' <> 'ok' then
    raise exception 'FAIL 3: the claim with no UEN failed: %', v;
  end if;
end;
$$;

-- ---- 4. What the claim made (as postgres) -----------------------------------
reset role;

do $$
declare
  v_ack timestamptz;
begin
  if not exists (select 1 from public.cook_applications a
                 where a.user_id = current_setting('kbt.owner')::uuid and a.status = 'approved'
                   and a.business_type = 'Hawker' and a.business_uen is null
                   and a.privacy_policy_version = '2026-10-v1') then
    raise exception 'FAIL 4: no approved Hawker application with no UEN';
  end if;
  if (select role from public.profiles where id = current_setting('kbt.owner')::uuid) <> 'cook' then
    raise exception 'FAIL 4: the owner was not made a cook';
  end if;
  select k.acknowledged_terms_at into v_ack from public.kitchens k
  where k.id = current_setting('kbt.owner')::uuid and not k.is_live and k.business_uen is null and k.category = 'hawker';
  if v_ack is null then
    raise exception 'FAIL 4: the kitchen is missing, live, has a UEN or has no terms date';
  end if;
  perform set_config('kbt.ack', v_ack::text, true);
  if coalesce(current_setting('kb_assist.uen_pending', true), '') <> '' then
    raise exception 'FAIL 4: kb_assist.uen_pending was left on after the claim';
  end if;
  if (select status from public.assisted_shops where id = current_setting('kbt.shop')::uuid) <> 'claimed' then
    raise exception 'FAIL 4: the draft is not claimed';
  end if;
end;
$$;

-- ---- 5. A normal applicant still needs a UEN --------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.applicant'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_msg text;
begin
  v_msg := null;
  begin
    insert into public.cook_applications (user_id, business_name, business_type, business_uen,
      business_address, postal_code, paynow_mobile, privacy_policy_version)
    values (current_setting('kbt.applicant')::uuid, 'TEST UEN Live Test Applicant', 'Hawker', null,
      'Blk 2 Test Lane', '310124', '89999995', '2026-10-v1');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'A Business Registration Number (UEN) is required%' then
    raise exception 'FAIL 5: a Hawker application with no UEN was not refused (%)', coalesce(v_msg, 'it went in');
  end if;

  -- The flag set in the applicant's own session changes nothing.
  perform set_config('kb_assist.uen_pending', 'on', true);
  v_msg := null;
  begin
    insert into public.cook_applications (user_id, business_name, business_type, business_uen,
      business_address, postal_code, paynow_mobile, privacy_policy_version, status)
    values (current_setting('kbt.applicant')::uuid, 'TEST UEN Live Test Applicant', 'Hawker', null,
      'Blk 2 Test Lane', '310124', '89999995', '2026-10-v1', 'approved');
  exception when others then v_msg := sqlerrm;
  end;
  perform set_config('kb_assist.uen_pending', '', true);
  if v_msg is null or v_msg not like 'A Business Registration Number (UEN) is required%' then
    raise exception 'FAIL 5: the flag let an applicant in with no UEN (%)', coalesce(v_msg, 'it went in');
  end if;

  -- With a UEN the same application goes in, as pending.
  insert into public.cook_applications (user_id, business_name, business_type, business_uen,
    business_address, postal_code, paynow_mobile, privacy_policy_version)
  values (current_setting('kbt.applicant')::uuid, 'TEST UEN Live Test Applicant', 'Hawker', ' 53123456x ',
    'Blk 2 Test Lane', '310124', '89999995', '2026-10-v1');
  if not exists (select 1 from public.cook_applications where user_id = current_setting('kbt.applicant')::uuid
                 and status = 'pending' and business_uen = '53123456X') then
    raise exception 'FAIL 5: the application with a UEN is missing or not pending';
  end if;

  -- Not approved: can't add a UEN; not admin: can't use HQ's function.
  v_msg := null;
  begin
    perform public.set_my_business_uen('53123456X');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Only an approved Kopi Boy partner%' then
    raise exception 'FAIL 5: an applicant could add a UEN (%)', coalesce(v_msg, 'no error');
  end if;
  v_msg := null;
  begin
    perform public.admin_set_kitchen_business_uen(current_setting('kbt.owner')::uuid, '53123456X', 'TEST UEN Live Test Shop', 'x');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Not allowed%' then
    raise exception 'FAIL 5: a non-admin used admin_set_kitchen_business_uen (%)', coalesce(v_msg, 'no error');
  end if;
end;
$$;

-- ---- 6. The owner, in a real owner session ----------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.owner'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_owner uuid := current_setting('kbt.owner')::uuid;
  v_msg text;
  v text;
begin
  if current_user <> 'authenticated' or auth.uid() is distinct from v_owner or public.user_has_role('admin') then
    raise exception 'FAIL 6: not a plain owner session (user %, uid %)', current_user, auth.uid();
  end if;

  -- No UEN: can't go live.
  v_msg := null;
  begin
    update public.kitchens set is_live = true where id = v_owner;
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Add your business UEN%' then
    raise exception 'FAIL 6: went live with no UEN (%)', coalesce(v_msg, 'no error');
  end if;

  -- Switching the kitchen to Home Cook doesn't get round it.
  update public.kitchens set category = 'home-cook' where id = v_owner;
  v_msg := null;
  begin
    update public.kitchens set is_live = true where id = v_owner;
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Add your business UEN%' then
    raise exception 'FAIL 6: went live with no UEN after switching to Home Cook (%)', coalesce(v_msg, 'no error');
  end if;
  update public.kitchens set category = 'hawker' where id = v_owner;

  -- Never stuck: PayNow and the rest still save while not live.
  update public.kitchens set paynow_type = 'mobile', paynow_value = '89999996', description = 'UEN live test saved'
  where id = v_owner;
  if (select is_live from public.kitchens where id = v_owner) then
    raise exception 'FAIL 6: the kitchen went live without a UEN';
  end if;
  if (select description from public.kitchens where id = v_owner) <> 'UEN live test saved' then
    raise exception 'FAIL 6: the owner''s save without live did not go through';
  end if;

  -- Bad and empty UENs are refused.
  v_msg := null;
  begin
    perform public.set_my_business_uen('12345');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'That doesn''t look like a valid UEN%' then
    raise exception 'FAIL 6: a bad UEN was not refused (%)', coalesce(v_msg, 'no error');
  end if;
  v_msg := null;
  begin
    perform public.set_my_business_uen('   ');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Please enter your Business Registration Number%' then
    raise exception 'FAIL 6: an empty UEN was not refused (%)', coalesce(v_msg, 'no error');
  end if;

  -- A good UEN is saved on the application and shows on the kitchen.
  v := public.set_my_business_uen(' 53123456x ');
  if v <> '53123456X' then raise exception 'FAIL 6: set_my_business_uen returned %', v; end if;
  if (select business_uen from public.kitchens where id = v_owner) is distinct from '53123456X' then
    raise exception 'FAIL 6: the kitchen UEN is not 53123456X';
  end if;
  if (select business_uen from public.cook_applications where user_id = v_owner and status = 'approved') is distinct from '53123456X' then
    raise exception 'FAIL 6: the application UEN is not 53123456X';
  end if;

  -- A wrong UEN can be corrected before going live.
  v := public.set_my_business_uen('201912345k');
  if v <> '201912345K' or (select business_uen from public.kitchens where id = v_owner) is distinct from '201912345K' then
    raise exception 'FAIL 6: the corrected UEN was not saved';
  end if;

  -- Writing kitchens.business_uen directly changes nothing (it comes from the application).
  update public.kitchens set business_uen = 'T08LL0001A' where id = v_owner;
  if (select business_uen from public.kitchens where id = v_owner) is distinct from '201912345K' then
    raise exception 'FAIL 6: a direct write changed kitchens.business_uen';
  end if;

  -- With the UEN in, going live works.
  update public.kitchens set is_live = true where id = v_owner;
  if not (select is_live from public.kitchens where id = v_owner) then
    raise exception 'FAIL 6: could not go live with a UEN';
  end if;

  -- Live: only HQ can change it.
  v_msg := null;
  begin
    perform public.set_my_business_uen('53123456X');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Your shop is live%' then
    raise exception 'FAIL 6: the owner changed the UEN of a live shop (%)', coalesce(v_msg, 'no error');
  end if;
  if (select business_uen from public.kitchens where id = v_owner) is distinct from '201912345K' then
    raise exception 'FAIL 6: the live shop''s UEN changed';
  end if;
  v_msg := null;
  begin
    perform public.admin_set_kitchen_business_uen(v_owner, '53123456X', 'TEST UEN Live Test Shop', 'x');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Not allowed%' then
    raise exception 'FAIL 6: the owner used admin_set_kitchen_business_uen (%)', coalesce(v_msg, 'no error');
  end if;
end;
$$;

-- ---- 7. Terms and privacy never changed (as postgres) ------------------------
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select acknowledged_terms_at from public.kitchens where id = current_setting('kbt.owner')::uuid)
     is distinct from current_setting('kbt.ack')::timestamptz then
    raise exception 'FAIL 7: the terms acknowledgement changed';
  end if;
  if not exists (select 1 from public.cook_applications
                 where user_id = current_setting('kbt.owner')::uuid and status = 'approved'
                   and privacy_policy_version = '2026-10-v1' and privacy_acknowledged_at is not null) then
    raise exception 'FAIL 7: the application''s privacy fields changed';
  end if;
end;
$$;

-- ---- 8. HQ corrects the UEN of the live shop ---------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_owner uuid := current_setting('kbt.owner')::uuid;
  v_msg text;
  v text;
begin
  v_msg := null;
  begin
    perform public.admin_set_kitchen_business_uen(v_owner, '53123456X', 'Some Other Shop', 'live test');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Type the kitchen''s business name%' then
    raise exception 'FAIL 8: a wrong business name was accepted (%)', coalesce(v_msg, 'no error');
  end if;
  v_msg := null;
  begin
    perform public.admin_set_kitchen_business_uen(v_owner, '53123456X', 'TEST UEN Live Test Shop', ' ');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Give a reason%' then
    raise exception 'FAIL 8: no reason was accepted (%)', coalesce(v_msg, 'no error');
  end if;
  v_msg := null;
  begin
    perform public.admin_set_kitchen_business_uen(v_owner, '1234', 'TEST UEN Live Test Shop', 'live test');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'That doesn''t look like a valid UEN%' then
    raise exception 'FAIL 8: a bad UEN was accepted (%)', coalesce(v_msg, 'no error');
  end if;

  v := public.admin_set_kitchen_business_uen(v_owner, ' 53123456x ', 'test uen live test shop', 'UEN live test correction');
  if v <> '53123456X' then raise exception 'FAIL 8: admin_set_kitchen_business_uen returned %', v; end if;
  if (select business_uen from public.kitchens where id = v_owner) is distinct from '53123456X'
     or not (select is_live from public.kitchens where id = v_owner) then
    raise exception 'FAIL 8: the HQ correction did not land, or the shop went off live';
  end if;
  if not exists (select 1 from public.kitchen_admin_audit
                 where kitchen_id = v_owner and admin_id = current_setting('kbt.admin')::uuid
                   and changes ? 'business_uen' and reason = 'UEN live test correction') then
    raise exception 'FAIL 8: the HQ correction is not in kitchen_admin_audit with its reason';
  end if;

  begin
    update public.kitchens set business_uen = '201912345K' where id = v_owner;
    raise exception 'FAIL 8: HQ wrote business_uen directly';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- ---- 8b. An admin's own session doesn't get the claim's exemption -------------
-- Still HQ's session (role authenticated, an admin). The flag is on and the row
-- is approved (guard_cook_application leaves an admin's status alone), and it
-- is the admin's own row (so the insert policy passes): only the current_user
-- condition is left to refuse it.
do $$
declare
  v_msg text;
begin
  if current_user <> 'authenticated' or not public.user_has_role('admin') then
    raise exception 'FAIL 8b: not an admin session (user %)', current_user;
  end if;
  perform set_config('kb_assist.uen_pending', 'on', true);
  v_msg := null;
  begin
    insert into public.cook_applications (user_id, business_name, business_type, business_uen,
      business_address, postal_code, status, reviewed_by, reviewed_at, privacy_policy_version)
    values (auth.uid(), 'TEST UEN Live Test Admin Row', 'Hawker', null,
      'Blk 6 Test Lane', '310128', 'approved', auth.uid(), now(), '2026-10-v1');
  exception when others then v_msg := sqlerrm;
  end;
  perform set_config('kb_assist.uen_pending', '', true);
  if v_msg is null or v_msg not like 'A Business Registration Number (UEN) is required%' then
    raise exception 'FAIL 8b: an admin session inserted an approved Hawker application with no UEN (%)', coalesce(v_msg, 'it went in');
  end if;
end;
$$;

-- ---- 9. anon can call neither function ---------------------------------------
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
set local role anon;

do $$
begin
  begin
    perform public.set_my_business_uen('53123456X');
    raise exception 'FAIL 9: anon called set_my_business_uen';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_set_kitchen_business_uen(current_setting('kbt.owner')::uuid, '53123456X', 'x', 'x');
    raise exception 'FAIL 9: anon called admin_set_kitchen_business_uen';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- ---- 10. Shops as they exist today (as postgres) ------------------------------
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  v_legacy uuid := current_setting('kbt.legacy')::uuid;
  v_fresh uuid := current_setting('kbt.fresh')::uuid;
  v_msg text;
begin
  -- Approved Hawkers whose application ends up with no UEN, as before UENs were asked.
  insert into public.cook_applications (user_id, business_name, business_type, business_uen, business_address,
    postal_code, status, reviewed_by, reviewed_at, privacy_policy_version)
  values
    (v_legacy, 'TEST UEN Live Test Legacy', 'Hawker', '53123456X', 'Blk 3 Test Lane', '310125', 'approved',
     current_setting('kbt.admin')::uuid, now(), '2026-10-v1'),
    (v_fresh, 'TEST UEN Live Test Fresh', 'Hawker', '53123456X', 'Blk 4 Test Lane', '310126', 'approved',
     current_setting('kbt.admin')::uuid, now(), '2026-10-v1'),
    (current_setting('kbt.homecook')::uuid, 'TEST UEN Live Test Home Cook', 'Home Cook', null, 'Blk 5 Test Lane',
     '310127', 'approved', current_setting('kbt.admin')::uuid, now(), '2026-10-v1');

  -- The legacy shop went live back when it had one; then its UEN is gone.
  insert into public.kitchens (id, business_name, category, cuisine_type, is_halal, is_live, acknowledged_terms_at)
  values (v_legacy, 'TEST UEN Live Test Legacy', 'hawker', 'chinese', false, false, now());
  update public.kitchens set is_live = true where id = v_legacy;
  update public.cook_applications set business_uen = null where user_id in (v_legacy, v_fresh);
  update public.kitchens set business_uen = null where id = v_legacy;
  if not exists (select 1 from public.kitchens where id = v_legacy and is_live and business_uen is null) then
    raise exception 'FAIL 10: could not set up a live Hawker kitchen with no UEN';
  end if;

  -- An upsert onto the live legacy kitchen still works (the INSERT path sees it is live).
  insert into public.kitchens (id, business_name, category, cuisine_type, is_halal, is_live, acknowledged_terms_at, description)
  values (v_legacy, 'TEST UEN Live Test Legacy', 'hawker', 'chinese', false, true, now(), 'upserted')
  on conflict (id) do update set description = excluded.description, is_live = excluded.is_live;
  if not exists (select 1 from public.kitchens where id = v_legacy and is_live and description = 'upserted') then
    raise exception 'FAIL 10: the upsert onto a live kitchen with no UEN failed';
  end if;

  -- A new kitchen that needs a UEN can't be inserted live without one.
  v_msg := null;
  begin
    insert into public.kitchens (id, business_name, category, cuisine_type, is_halal, is_live, acknowledged_terms_at)
    values (v_fresh, 'TEST UEN Live Test Fresh', 'hawker', 'chinese', false, true, now());
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Add your business UEN%' then
    raise exception 'FAIL 10: a new kitchen went live with no UEN (%)', coalesce(v_msg, 'no error');
  end if;

  -- A Home Cook, and a kitchen with no approved application: no UEN needed.
  insert into public.kitchens (id, business_name, category, cuisine_type, is_halal, is_live, acknowledged_terms_at)
  values (current_setting('kbt.homecook')::uuid, 'TEST UEN Live Test Home Cook', 'hawker', 'chinese', false, true, now()),
         (current_setting('kbt.noapp')::uuid, 'TEST UEN Live Test No Application', 'hawker', 'chinese', false, true, now());
  if (select count(*) from public.kitchens
      where id in (current_setting('kbt.homecook')::uuid, current_setting('kbt.noapp')::uuid) and is_live) <> 2 then
    raise exception 'FAIL 10: a Home Cook or a kitchen with no approved application could not go live';
  end if;
end;
$$;

-- ---- 11. The legacy owner saves Kitchen Setup as today (is_live true every save)
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.legacy'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_legacy uuid := current_setting('kbt.legacy')::uuid;
begin
  update public.kitchens
  set description = 'still saving', paynow_type = 'mobile', paynow_value = '89999994',
      acknowledged_terms_at = now(), is_live = true
  where id = v_legacy;
  if not (select is_live from public.kitchens where id = v_legacy)
     or (select description from public.kitchens where id = v_legacy) <> 'still saving' then
    raise exception 'FAIL 11: a live Hawker kitchen with no UEN could not save';
  end if;
end;
$$;

-- ---- 12. Fingerprints and the flag (as postgres) ------------------------------
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  r record;
  v_fp text;
begin
  for r in
    select * from (values
      ('public.guard_admin_kitchen_edit()', 'd2f149c60f8ec06674856df78d4c76c4'),
      ('public.stamp_kitchen_terms_acknowledgement()', 'b00a9bff4b11a925899d848aa5ce3284'),
      ('public.guard_cook_application()', 'b834d80c3b0f0bb5020b8bb5fbd3d31b'),
      ('public.set_kitchen_business_uen()', '074e803d7e5963bb22b435ffa04b48c8'),
      ('public.sync_kitchen_business_uen()', '5b36458dff4ea8298fc2efb034ea0297'),
      ('public.approved_business_uen(uuid)', '23210d0de6fb94b99b80cf441f0e8f76'),
      ('public.check_cook_application_uen()', 'a445a3c6a87c2d5ca126332f9518e1d4'),
      ('public.assisted_claim_complete(text, text, uuid, text, text)', '50b8a1a61596dfd1c85880c1a0fdd763'),
      ('public.admin_issue_assisted_claim_link(uuid, text)', '4b08d6197dbc57214499fc14a14d1d5e')
    ) as f(sig, want)
  loop
    v_fp := md5(replace(pg_get_functiondef(to_regprocedure(r.sig)), E'\r', ''));
    if v_fp <> r.want then
      raise exception 'FAIL 12: % has fingerprint %, expected %', r.sig, v_fp, r.want;
    end if;
  end loop;
  if coalesce(current_setting('kb_assist.uen_pending', true), '') <> '' then
    raise exception 'FAIL 12: kb_assist.uen_pending is on';
  end if;

  raise exception 'TEST OK, rolled back: claim link and claim for a Hawker with no UEN (approved application, cook, not live), normal applicants still need a UEN (flag or not), owner session: no live without a UEN (Home Cook switch too), PayNow still saves, bad/empty UEN refused, UEN saved and corrected, live after, owner locked out once live, HQ correction audited with reason, HQ still refused direct writes, an admin session refused the no-UEN insert even with the flag, anon refused, existing live shops still save (update and upsert), Home Cook and no-application kitchens unaffected, terms and privacy untouched, fingerprints as pinned, flag off. Nothing was saved.';
end;
$$;

rollback;
