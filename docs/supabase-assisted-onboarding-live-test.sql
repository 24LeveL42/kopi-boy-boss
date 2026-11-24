-- ============================================================================
-- LIVE TEST for supabase-assisted-onboarding (v1). ALWAYS ROLLS BACK.
-- Run in the Supabase SQL editor AFTER the main script, as ONE script.
-- Success ends with
--   ERROR: TEST OK, rolled back: ...
-- and any failure ends with a different error. Nothing is ever kept: no
-- draft, no link, no auth user, profile, application, kitchen, menu,
-- subscription row, founding number or audit row. (Push requests queued by
-- pg_net and Realtime changes only go out after a commit.)
--
-- Fill in ONE value (Find/replace):
--   PUT-ADMIN-ID   your own admin profile id
-- It makes its own throw-away drafts, named "TEST Assisted Live Test A/B",
-- with owner mobiles 89999999 / 89999998, and refuses to run if either
-- number already has an open draft. The new owner is a throw-away auth
-- user (@example.invalid) created inside the transaction. No real merchant
-- or kitchen is read or changed.
--
-- What it proves:
--   1. HQ creates a draft and its menu; database-only columns are refused
--      (status, created_by), and hiding an item works and is audited.
--   2. Links: a bad hash is refused; re-issuing revokes the first link;
--      "sent" is logged; HQ lists links without ever seeing a hash and
--      can't read the token table or call the claim functions.
--   3. Another signed-in user sees no drafts and can't issue links; anon
--      can't read drafts at all.
--   4. Preview (service_role): revoked / unknown / good tokens; only
--      visible items; the mobile is masked.
--   5. Claim: refused for an account made for another shop; the good
--      claim creates the approved application, role cook, subscription
--      row, kitchen (terms stamped by the trigger, NOT live), address,
--      menu; the token is used once (a second tap gets 'used').
--   6. After the claim HQ still can't set or change acknowledged_terms_at
--      on the new kitchen (the unchanged a_kitchen_admin_guard), and the
--      claimed draft is frozen.
--   7. Expired, revoked-after-expiry and cancelled links; cancel is
--      audited with its reason.
--   8. Rate limit: 10 failed tries from one client key, then rate_limited.
--   9. Audit rows for create, send, revoke, claim; append-only.
-- ============================================================================

begin;

select set_config('kbt.admin', 'PUT-ADMIN-ID', true);

-- ---- Setup (as postgres) ---------------------------------------------------
do $$
declare
  v_hex text;
begin
  if current_setting('kbt.admin') like 'PUT-%' then
    raise exception 'REFUSED: fill in PUT-ADMIN-ID first';
  end if;
  if not exists (select 1 from public.profiles where id = current_setting('kbt.admin')::uuid and role = 'admin') then
    raise exception 'FAIL setup: PUT-ADMIN-ID is not an admin profile';
  end if;
  if exists (select 1 from public.assisted_shops where status = 'draft' and owner_mobile in ('89999999', '89999998')) then
    raise exception 'REFUSED: a real open draft uses a test mobile number (89999999 / 89999998)';
  end if;

  -- Raw tokens exist only inside this transaction; the table gets hashes.
  perform set_config('kbt.raw1', 'kb-live-test-1-' || gen_random_uuid(), true);
  perform set_config('kbt.raw2', 'kb-live-test-2-' || gen_random_uuid(), true);
  perform set_config('kbt.raw3', 'kb-live-test-3-' || gen_random_uuid(), true);
  perform set_config('kbt.hash1', encode(sha256(convert_to(current_setting('kbt.raw1'), 'UTF8')), 'hex'), true);
  perform set_config('kbt.hash2', encode(sha256(convert_to(current_setting('kbt.raw2'), 'UTF8')), 'hex'), true);
  perform set_config('kbt.hash3', encode(sha256(convert_to(current_setting('kbt.raw3'), 'UTF8')), 'hex'), true);
  perform set_config('kbt.client', encode(sha256(convert_to('kb-live-test-client-' || gen_random_uuid(), 'UTF8')), 'hex'), true);
  perform set_config('kbt.client_rl', encode(sha256(convert_to('kb-live-test-rl-' || gen_random_uuid(), 'UTF8')), 'hex'), true);
  perform set_config('kbt.owner', gen_random_uuid()::text, true);
  perform set_config('kbt.wrong_owner', gen_random_uuid()::text, true);

  v_hex := encode(sha256(convert_to('nobody-' || gen_random_uuid(), 'UTF8')), 'hex');
  perform set_config('kbt.unknown_hash', v_hex, true);
end;
$$;

-- ---- 1-2. Act as HQ ----------------------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_shop uuid;
  v_shop_b uuid;
  v_item uuid;
  v_tok record;
  v_n int;
begin
  -- 1. Draft A (a hawker, so a UEN is needed) and its menu
  insert into public.assisted_shops
    (business_name, category, cuisine_type, is_halal, description, owner_name, owner_mobile,
     business_uen, business_address, postal_code)
  values
    ('TEST Assisted Live Test A', 'hawker', 'chinese', false, 'live test', 'KB Live Test Owner', '89999999',
     '53123456x', 'Blk 1 Test Lane', '310123')
  returning id into v_shop;
  perform set_config('kbt.shop', v_shop::text, true);

  if (select business_uen from public.assisted_shops where id = v_shop) <> '53123456X' then
    raise exception 'FAIL 1: the UEN was not normalised';
  end if;
  if (select created_by from public.assisted_shops where id = v_shop) <> current_setting('kbt.admin')::uuid then
    raise exception 'FAIL 1: created_by is not the admin';
  end if;

  insert into public.assisted_shop_items (shop_id, name, price) values (v_shop, 'Live Test Noodles', 4.50);
  insert into public.assisted_shop_items (shop_id, name, price) values (v_shop, 'Live Test Hidden', 3.00)
  returning id into v_item;
  update public.assisted_shop_items set is_hidden = true where id = v_item;

  -- Database-only columns are refused
  begin
    update public.assisted_shops set status = 'claimed' where id = v_shop;
    raise exception 'FAIL 1: HQ set status';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.assisted_shops (business_name, category, cuisine_type, owner_name, owner_mobile, created_by)
    values ('TEST x', 'home-cook', 'chinese', 'x', '89999997', current_setting('kbt.admin')::uuid);
    raise exception 'FAIL 1: HQ set created_by';
  exception when insufficient_privilege then null;
  end;

  -- 2. Links
  begin
    perform public.admin_issue_assisted_claim_link(v_shop, 'not-a-hash');
    raise exception 'FAIL 2: a bad hash was accepted';
  exception when invalid_parameter_value then null;
  end;

  select * into v_tok from public.admin_issue_assisted_claim_link(v_shop, current_setting('kbt.hash1'));
  perform set_config('kbt.tok1', v_tok.token_id::text, true);
  if v_tok.expires_at < now() + interval '47 hours 59 minutes' or v_tok.expires_at > now() + interval '48 hours 1 minute' then
    raise exception 'FAIL 2: expiry is not 48 hours: %', v_tok.expires_at;
  end if;

  select * into v_tok from public.admin_issue_assisted_claim_link(v_shop, current_setting('kbt.hash2'));
  perform set_config('kbt.tok2', v_tok.token_id::text, true);
  perform public.admin_mark_assisted_claim_link_sent(v_tok.token_id);

  select count(*) into v_n from public.admin_list_assisted_claim_links(v_shop) l
  where (l.id = current_setting('kbt.tok1')::uuid and l.state = 'revoked')
     or (l.id = current_setting('kbt.tok2')::uuid and l.state = 'live' and l.sent_at is not null);
  if v_n <> 2 then
    raise exception 'FAIL 2: re-issue did not revoke the first link, or sent was not recorded';
  end if;

  begin
    perform 1 from public.assisted_claim_tokens limit 1;
    raise exception 'FAIL 2: HQ can read the token table';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.assisted_claim_preview(current_setting('kbt.hash2'), current_setting('kbt.client'));
    raise exception 'FAIL 2: HQ can call assisted_claim_preview';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.assisted_claim_complete(current_setting('kbt.hash2'), current_setting('kbt.client'),
      current_setting('kbt.admin')::uuid, 'x', '2026-10-v1');
    raise exception 'FAIL 2: HQ can call assisted_claim_complete';
  exception when insufficient_privilege then null;
  end;

  -- Draft B, for the expiry / revoke / cancel checks (step 7). Home Cook: no UEN.
  insert into public.assisted_shops
    (business_name, category, cuisine_type, owner_name, owner_mobile, business_address, postal_code)
  values ('TEST Assisted Live Test B', 'home-cook', 'western', 'KB Live Test Owner B', '89999998', 'Blk 2 Test Lane', '310124')
  returning id into v_shop_b;
  perform set_config('kbt.shop_b', v_shop_b::text, true);
  insert into public.assisted_shop_items (shop_id, name, price) values (v_shop_b, 'Live Test Cake', 2.00);
  select * into v_tok from public.admin_issue_assisted_claim_link(v_shop_b, current_setting('kbt.hash3'));
  perform set_config('kbt.tok3', v_tok.token_id::text, true);
end;
$$;

-- ---- 3. Another signed-in user, then anon ----------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.wrong_owner'), 'role', 'authenticated')::text, true);

do $$
begin
  if exists (select 1 from public.assisted_shops) then
    raise exception 'FAIL 3: a non-admin can see drafts';
  end if;
  begin
    perform public.admin_issue_assisted_claim_link(current_setting('kbt.shop')::uuid, current_setting('kbt.unknown_hash'));
    raise exception 'FAIL 3: a non-admin issued a link';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.assisted_shops (business_name, category, cuisine_type, owner_name, owner_mobile)
    values ('TEST y', 'home-cook', 'chinese', 'y', '89999996');
    raise exception 'FAIL 3: a non-admin created a draft';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;

do $$
begin
  begin
    perform 1 from public.assisted_shops limit 1;
    raise exception 'FAIL 3: anon can read drafts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.assisted_claim_preview(current_setting('kbt.hash2'), current_setting('kbt.client'));
    raise exception 'FAIL 3: anon can call assisted_claim_preview';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- ---- 4. Preview as the Partner server (service_role) -----------------------
reset role;
set local role service_role;

do $$
declare
  v jsonb;
begin
  v := public.assisted_claim_preview(current_setting('kbt.hash1'), current_setting('kbt.client'));
  if v ->> 'status' <> 'revoked' then raise exception 'FAIL 4: replaced link: %', v ->> 'status'; end if;

  v := public.assisted_claim_preview(current_setting('kbt.unknown_hash'), current_setting('kbt.client'));
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL 4: unknown link: %', v ->> 'status'; end if;

  v := public.assisted_claim_preview('garbage', current_setting('kbt.client'));
  if v ->> 'status' <> 'invalid' then raise exception 'FAIL 4: malformed link: %', v ->> 'status'; end if;

  v := public.assisted_claim_preview(current_setting('kbt.hash2'), current_setting('kbt.client'));
  if v ->> 'status' <> 'ok' then raise exception 'FAIL 4: good link: %', v ->> 'status'; end if;
  if v ->> 'shop_id' <> current_setting('kbt.shop') then raise exception 'FAIL 4: wrong shop_id'; end if;
  if jsonb_array_length(v -> 'items') <> 1 or v -> 'items' -> 0 ->> 'name' <> 'Live Test Noodles' then
    raise exception 'FAIL 4: preview items wrong (hidden item shown?): %', v -> 'items';
  end if;
  if v -> 'shop' ->> 'owner_mobile_masked' <> '*****999' then
    raise exception 'FAIL 4: mobile not masked: %', v -> 'shop' ->> 'owner_mobile_masked';
  end if;
  if v::text like '%' || current_setting('kbt.hash2') || '%' then
    raise exception 'FAIL 4: the preview returned the hash';
  end if;
end;
$$;

-- ---- 5. The owner's tap ------------------------------------------------------
-- The auth users the Partner server would create (as postgres here).
reset role;
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  (current_setting('kbt.owner')::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'kb-live-test-assisted-owner@example.invalid',
   jsonb_build_object('kb_assisted_shop_id', current_setting('kbt.shop')), '{}'::jsonb, now(), now()),
  (current_setting('kbt.wrong_owner')::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'kb-live-test-assisted-wrong@example.invalid',
   jsonb_build_object('kb_assisted_shop_id', current_setting('kbt.shop_b')), '{}'::jsonb, now(), now());

set local role service_role;

do $$
declare
  v jsonb;
  v_msg text;
begin
  -- An account made for another shop: refused, nothing saved
  begin
    v := public.assisted_claim_complete(current_setting('kbt.hash2'), current_setting('kbt.client'),
      current_setting('kbt.wrong_owner')::uuid, 'KB live test UA', '2026-10-v1');
    raise exception 'FAIL 5: claimed with an account made for another shop';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'assisted_claim:%' then raise exception 'FAIL 5: unexpected refusal: %', v_msg; end if;
  end;

  v := public.assisted_claim_complete(current_setting('kbt.hash1'), current_setting('kbt.client'),
    current_setting('kbt.owner')::uuid, 'KB live test UA', '2026-10-v1');
  if v ->> 'status' <> 'revoked' then raise exception 'FAIL 5: replaced link claimed: %', v ->> 'status'; end if;

  v := public.assisted_claim_complete(current_setting('kbt.hash2'), current_setting('kbt.client'),
    current_setting('kbt.owner')::uuid, E'KB live test UA\n', '2026-10-v1');
  if v ->> 'status' <> 'ok' then raise exception 'FAIL 5: the claim failed: %', v; end if;
  if v ->> 'kitchen_id' <> current_setting('kbt.owner') then raise exception 'FAIL 5: wrong kitchen_id'; end if;

  v := public.assisted_claim_complete(current_setting('kbt.hash2'), current_setting('kbt.client'),
    current_setting('kbt.owner')::uuid, 'KB live test UA', '2026-10-v1');
  if v ->> 'status' <> 'used' then raise exception 'FAIL 5: second tap: %', v ->> 'status'; end if;

  v := public.assisted_claim_preview(current_setting('kbt.hash2'), current_setting('kbt.client'));
  if v ->> 'status' <> 'used' then raise exception 'FAIL 5: preview after claim: %', v ->> 'status'; end if;
end;
$$;

-- Checks (as postgres)
reset role;

do $$
declare
  v_owner uuid := current_setting('kbt.owner')::uuid;
  v_shop public.assisted_shops;
  k record;
  v_n int;
begin
  select * into v_shop from public.assisted_shops where id = current_setting('kbt.shop')::uuid;

  select * into k from public.kitchens where id = v_owner;
  if k.id is null then raise exception 'FAIL 5: no kitchen'; end if;
  if k.is_live then raise exception 'FAIL 5: the kitchen went live before PayNow'; end if;
  if k.acknowledged_terms_at is null or k.acknowledged_terms_at <> now() then
    raise exception 'FAIL 5: terms not stamped by the trigger at claim time: %', k.acknowledged_terms_at;
  end if;
  if k.paynow_type is not null or k.paynow_value is not null then
    raise exception 'FAIL 5: PayNow was set by the claim';
  end if;
  if k.business_name <> 'TEST Assisted Live Test A' or k.category <> 'hawker' then
    raise exception 'FAIL 5: kitchen fields wrong';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'kitchens' and column_name = 'postal_sector')
     and (select postal_sector from public.kitchens where id = v_owner) is distinct from '31' then
    raise exception 'FAIL 5: postal_sector not derived from the address';
  end if;

  if not exists (select 1 from public.kitchen_addresses
                 where kitchen_id = v_owner and business_address = 'Blk 1 Test Lane' and postal_code = '310123') then
    raise exception 'FAIL 5: no kitchen address';
  end if;
  select count(*) into v_n from public.menu_items where kitchen_id = v_owner;
  if v_n <> 1 or not exists (select 1 from public.menu_items
                             where kitchen_id = v_owner and name = 'Live Test Noodles' and price = 4.50 and not is_hidden) then
    raise exception 'FAIL 5: menu not copied (visible items only): % rows', v_n;
  end if;

  if not exists (select 1 from public.profiles
                 where id = v_owner and role = 'cook' and full_name = 'KB Live Test Owner' and phone = '89999999') then
    raise exception 'FAIL 5: profile not set to cook with name and phone';
  end if;
  if not exists (select 1 from public.cook_applications
                 where user_id = v_owner and status = 'approved' and business_type = 'Hawker'
                   and business_uen = '53123456X' and created_at = v_shop.created_at
                   and reviewed_by = current_setting('kbt.admin')::uuid
                   and privacy_policy_version = '2026-10-v1' and privacy_acknowledged_at is not null) then
    raise exception 'FAIL 5: approved cook application missing or wrong';
  end if;
  if not exists (select 1 from public.merchant_subscriptions where merchant_id = v_owner) then
    raise exception 'FAIL 5: no subscription row';
  end if;

  if v_shop.status <> 'claimed' or v_shop.claimed_user_id <> v_owner
     or v_shop.acknowledged_at <> k.acknowledged_terms_at
     or v_shop.acknowledged_token_id <> current_setting('kbt.tok2')::uuid
     or v_shop.acknowledged_user_agent <> 'KB live test UA' then
    raise exception 'FAIL 5: draft not closed with time, token id and user agent: %', to_jsonb(v_shop);
  end if;
  if not exists (select 1 from public.assisted_claim_tokens
                 where id = current_setting('kbt.tok2')::uuid and used_at = now() and revoked_at is null) then
    raise exception 'FAIL 5: token not marked used';
  end if;
end;
$$;

-- ---- 6-7. HQ after the claim, and draft B --------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_msg text;
  v_n int;
begin
  -- 6. The unchanged guard still refuses HQ on the terms stamp
  begin
    update public.kitchens set acknowledged_terms_at = now() + interval '1 day'
    where id = current_setting('kbt.owner')::uuid;
    raise exception 'FAIL 6: HQ changed the terms acknowledgement';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'HQ cannot set or change the partner terms%' then
      raise exception 'FAIL 6: refused, but not by the HQ guard: %', v_msg;
    end if;
  end;

  -- The claimed draft is frozen (RLS hides it from update; the guard is the backstop)
  update public.assisted_shops set business_name = 'TEST changed' where id = current_setting('kbt.shop')::uuid;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 6: HQ edited a claimed draft'; end if;
  begin
    insert into public.assisted_shop_items (shop_id, name, price) values (current_setting('kbt.shop')::uuid, 'late', 1);
    raise exception 'FAIL 6: HQ added an item to a claimed draft';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_issue_assisted_claim_link(current_setting('kbt.shop')::uuid, current_setting('kbt.unknown_hash'));
    raise exception 'FAIL 6: a link was issued for a claimed shop';
  exception when invalid_parameter_value then null;
  end;
end;
$$;

-- 7. Expire draft B's link (as postgres), then preview, revoke, cancel
reset role;
update public.assisted_claim_tokens
set created_at = now() - interval '3 days', expires_at = now() - interval '1 day'
where id = current_setting('kbt.tok3')::uuid;

set local role service_role;
do $$
declare
  v jsonb;
begin
  v := public.assisted_claim_preview(current_setting('kbt.hash3'), current_setting('kbt.client'));
  if v ->> 'status' <> 'expired' then raise exception 'FAIL 7: expired link: %', v ->> 'status'; end if;
end;
$$;

reset role;
set local role authenticated;
do $$
begin
  begin
    perform public.admin_revoke_assisted_claim_link(current_setting('kbt.tok3')::uuid, '  ');
    raise exception 'FAIL 7: revoked without a reason';
  exception when invalid_parameter_value then null;
  end;
  perform public.admin_revoke_assisted_claim_link(current_setting('kbt.tok3')::uuid, 'live test revoke');
  begin
    perform public.admin_mark_assisted_claim_link_sent(current_setting('kbt.tok3')::uuid);
    raise exception 'FAIL 7: a revoked link was marked sent';
  exception when invalid_parameter_value then null;
  end;
  perform public.admin_cancel_assisted_shop(current_setting('kbt.shop_b')::uuid, 'live test cancel');
end;
$$;

reset role;
set local role service_role;
do $$
declare
  v jsonb;
begin
  v := public.assisted_claim_preview(current_setting('kbt.hash3'), current_setting('kbt.client'));
  if v ->> 'status' <> 'cancelled' then raise exception 'FAIL 7: link of a cancelled shop: %', v ->> 'status'; end if;

  -- 8. Rate limit: 10 failed tries from one client key, then rate_limited
  for i in 1..10 loop
    v := public.assisted_claim_preview(encode(sha256(convert_to('nope-' || i || gen_random_uuid(), 'UTF8')), 'hex'),
                                       current_setting('kbt.client_rl'));
    if v ->> 'status' <> 'invalid' then raise exception 'FAIL 8: try % was %', i, v ->> 'status'; end if;
  end loop;
  v := public.assisted_claim_preview(current_setting('kbt.hash2'), current_setting('kbt.client_rl'));
  if v ->> 'status' <> 'rate_limited' then raise exception 'FAIL 8: not rate limited: %', v ->> 'status'; end if;
  v := public.assisted_claim_complete(current_setting('kbt.hash2'), current_setting('kbt.client_rl'),
    current_setting('kbt.owner')::uuid, 'x', '2026-10-v1');
  if v ->> 'status' <> 'rate_limited' then raise exception 'FAIL 8: claim not rate limited: %', v ->> 'status'; end if;
end;
$$;

-- ---- 9. Audit (as postgres) ------------------------------------------------
reset role;

do $$
declare
  v_missing text;
  v_audit_id bigint;
begin
  select string_agg(a, ', ') into v_missing
  from unnest(array['shop_created', 'item_added', 'item_hidden', 'link_issued', 'link_revoked', 'link_sent', 'claimed']) as a
  where not exists (select 1 from public.assisted_onboarding_audit
                    where shop_id = current_setting('kbt.shop')::uuid and action = a);
  if v_missing is not null then raise exception 'FAIL 9: no audit row for draft A: %', v_missing; end if;

  if not exists (select 1 from public.assisted_onboarding_audit
                 where shop_id = current_setting('kbt.shop_b')::uuid and action = 'shop_cancelled'
                   and details ->> 'reason' = 'live test cancel') then
    raise exception 'FAIL 9: cancel not audited with its reason';
  end if;
  if not exists (select 1 from public.assisted_onboarding_audit
                 where shop_id = current_setting('kbt.shop_b')::uuid and action = 'link_revoked'
                   and details ->> 'reason' = 'live test revoke') then
    raise exception 'FAIL 9: revoke not audited with its reason';
  end if;
  if not exists (select 1 from public.assisted_onboarding_audit
                 where shop_id = current_setting('kbt.shop')::uuid and action = 'claimed'
                   and actor_kind = 'owner' and actor_id = current_setting('kbt.owner')::uuid
                   and token_id = current_setting('kbt.tok2')::uuid
                   and details ->> 'user_agent' = 'KB live test UA') then
    raise exception 'FAIL 9: claim audit row wrong';
  end if;

  if exists (select 1 from public.assisted_onboarding_audit
             where shop_id in (current_setting('kbt.shop')::uuid, current_setting('kbt.shop_b')::uuid)
               and (details::text like '%' || current_setting('kbt.hash1') || '%'
                 or details::text like '%' || current_setting('kbt.hash2') || '%'
                 or details::text like '%' || current_setting('kbt.hash3') || '%'
                 or details::text like '%kb-live-test-%'
                 or details::text like '%89999999%')) then
    raise exception 'FAIL 9: a token, hash or clear mobile number is in the audit log';
  end if;

  select id into v_audit_id from public.assisted_onboarding_audit
  where shop_id = current_setting('kbt.shop')::uuid order by id limit 1;
  begin
    update public.assisted_onboarding_audit set details = '{}' where id = v_audit_id;
    raise exception 'FAIL 9: an audit row was changed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.assisted_onboarding_audit where id = v_audit_id;
    raise exception 'FAIL 9: an audit row was deleted';
  exception when insufficient_privilege then null;
  end;

  raise exception 'TEST OK, rolled back: draft + menu by HQ, link issue/re-issue/sent/revoke, no hash visible, preview states, claim made cook + application + subscription + kitchen (terms stamped, not live) + address + menu, single use, HQ still refused on the terms stamp, expired/cancelled/rate limited, audit append-only. Nothing was saved.';
end;
$$;

rollback;
