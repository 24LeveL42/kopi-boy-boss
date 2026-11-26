-- ============================================================================
-- ASSISTED ONBOARDING: THE UEN AFTER CLAIMING. NOT INSTALLED. Review first.
-- Run ONCE in the Supabase SQL editor, as ONE script, after
-- docs/supabase-assisted-onboarding.sql, docs/supabase-assisted-menu-import.sql,
-- docs/supabase-billing-off.sql and docs/supabase-kitchen-admin-edit.sql.
-- Success ends with: UEN LATER INSTALLED. Then run
-- docs/supabase-assisted-uen-later-live-test.sql (it always rolls back).
--
-- WHAT IT DOES
-- HQ may set up a draft for a shop that isn't Home Cook (Hawker, Bakery,
-- Vegetarian, Drinks & Desserts) with no UEN and send the claim link. The
-- owner claims it, adds the UEN in Kitchen Setup, and the shop can't go live
-- until the UEN is in. Home Cook is unchanged: it never has a UEN.
--
--   1. check_cook_application_uen (BEFORE INSERT on cook_applications): a
--      null UEN on an application that isn't Home Cook is let through only
--      when ALL of these hold:
--        * kb_assist.uen_pending = 'on' (transaction-local; only the claim sets it),
--        * current_user is not anon or authenticated (a SECURITY DEFINER
--          function, never a request from the app),
--        * new.status = 'approved'.
--      Otherwise the same error as today. The format check and the Home
--      Cook branch are unchanged.
--   2. assisted_claim_complete: sets that flag just before its
--      cook_applications insert, only when the shop isn't Home Cook and has
--      no UEN, and clears it straight after. Also its step-2 comment now
--      says billing is off. Nothing else in the claim changes.
--   3. admin_issue_assisted_claim_link: no longer asks for a UEN. The
--      address and menu checks stay.
--   4. set_my_business_uen(p_uen) (new): the signed-in owner sets or corrects
--      their UEN while their kitchen is NOT live. It is saved on their latest
--      approved application, and the existing before_kitchen_business_uen
--      trigger copies it to kitchens.business_uen, as for every kitchen.
--   5. admin_set_kitchen_business_uen(kitchen, uen, business name, reason)
--      (new): HQ sets or corrects it at any time, live or not. Same shape as
--      admin_set_kitchen_paynow; logged in kitchen_admin_audit with the reason.
--   6. y_kitchen_live_needs_uen (new trigger, BEFORE INSERT OR UPDATE on
--      kitchens; its name sorts after every other BEFORE trigger, so it sees
--      the UEN before_kitchen_business_uen has just set): a kitchen can't
--      BECOME live without a UEN when its latest approved application isn't
--      Home Cook. Decided by the application, not kitchens.category (the
--      owner picks that). No approved application: no requirement. A kitchen
--      that is already live is never judged again, so no existing shop changes.
--
-- WHAT IT DOES NOT TOUCH. These are fingerprinted before and after; any
-- difference stops the script and nothing is saved:
--   guard_admin_kitchen_edit, stamp_kitchen_terms_acknowledgement,
--   guard_cook_application, set_kitchen_business_uen, sync_kitchen_business_uen,
--   approved_business_uen.
-- No table, column, constraint, policy or grant on an existing table changes.
--
-- FINGERPRINTS ignore line endings: md5(replace(pg_get_functiondef(oid), E'\r', '')),
-- so it makes no difference whether this was pasted with Windows line endings.
-- The "before" values are the live definitions as fetched on 2026-11-27.
--
-- SAFE TO RE-RUN: each function this file changes must be exactly as it was
-- (before) or exactly as this file leaves it (after). Anything else stops it.
--
-- ORDER: 1. this file, 2. Partner Kitchen Setup with the UEN step,
-- 3. Boss (UEN optional on the draft form). Until 2 is deployed, do NOT send
-- a real claim link for a shop with no UEN: today's Kitchen Setup asks for
-- live on every save, so that owner couldn't save PayNow until the UEN step exists.
-- Keep kopi-boy-partner docs/supabase-schema.sql section 26 in step with
-- item 1: re-running the old section 26 would undo it (then a claim with no
-- UEN fails and rolls back; nothing else breaks).
--
-- UNDO (one script; only while no shop has been claimed without a UEN,
-- because after the undo that kitchen could go live without one):
--   begin;
--   drop trigger if exists y_kitchen_live_needs_uen on public.kitchens;
--   drop function if exists public.kitchen_live_needs_uen();
--   drop function if exists public.set_my_business_uen(text);
--   drop function if exists public.admin_set_kitchen_business_uen(uuid, text, text, text);
--   -- then re-create the three previous texts: check_cook_application_uen
--   -- (Partner docs/supabase-schema.sql section 26), admin_issue_assisted_claim_link
--   -- and assisted_claim_complete (docs/supabase-assisted-onboarding.sql).
--   commit;
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. CHECKS BEFORE ANYTHING CHANGES
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := array[]::text[];
  v_name text;
  v_fp text;
  r record;
begin
  foreach v_name in array array['public.kitchens', 'public.cook_applications', 'public.assisted_shops',
                                'public.assisted_shop_items', 'public.kitchen_admin_audit'] loop
    if to_regclass(v_name) is null then
      v_missing := pg_catalog.array_append(v_missing, v_name);
    end if;
  end loop;
  if pg_catalog.cardinality(v_missing) > 0 then
    raise exception 'UEN later: missing %. Nothing was changed.', pg_catalog.array_to_string(v_missing, ', ');
  end if;

  foreach v_name in array array[
    'auth.uid()', 'public.user_has_role(text)', 'public.is_admin_editing_kitchen(uuid)',
    'public.guard_admin_kitchen_edit()', 'public.stamp_kitchen_terms_acknowledgement()',
    'public.guard_cook_application()', 'public.check_cook_application_uen()',
    'public.set_kitchen_business_uen()', 'public.sync_kitchen_business_uen()',
    'public.approved_business_uen(uuid)', 'public.audit_admin_kitchen_edit()',
    'public.assisted_claim_complete(text, text, uuid, text, text)',
    'public.admin_issue_assisted_claim_link(uuid, text)'
  ] loop
    if to_regprocedure(v_name) is null then
      v_missing := pg_catalog.array_append(v_missing, v_name);
    end if;
  end loop;

  for r in
    select * from (values
      ('kitchens', 'business_uen'), ('kitchens', 'is_live'), ('kitchens', 'business_name'),
      ('cook_applications', 'business_uen'), ('cook_applications', 'business_type'),
      ('cook_applications', 'status'), ('cook_applications', 'reviewed_at'), ('cook_applications', 'user_id')
    ) as c(tbl, col)
  loop
    if not exists (select 1 from information_schema.columns ic
                   where ic.table_schema = 'public' and ic.table_name = r.tbl and ic.column_name = r.col) then
      v_missing := pg_catalog.array_append(v_missing, r.tbl || '.' || r.col);
    end if;
  end loop;

  for r in
    select * from (values
      ('cook_applications', 'before_cook_application_guard', 'guard_cook_application'),
      ('cook_applications', 'before_cook_application_insert', 'check_cook_application_uen'),
      ('cook_applications', 'after_cook_application_review', 'sync_kitchen_business_uen'),
      ('kitchens', 'a_kitchen_admin_guard', 'guard_admin_kitchen_edit'),
      ('kitchens', 'before_kitchen_business_uen', 'set_kitchen_business_uen'),
      ('kitchens', 'before_kitchen_terms_acknowledgement', 'stamp_kitchen_terms_acknowledgement'),
      ('kitchens', 'z_kitchen_admin_audit', 'audit_admin_kitchen_edit')
    ) as t(tbl, tg, fn)
  loop
    if not exists (select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid = t.tgfoid
                   where t.tgrelid = ('public.' || r.tbl)::regclass and not t.tgisinternal
                     and t.tgname = r.tg and p.proname = r.fn) then
      v_missing := pg_catalog.array_append(v_missing, 'trigger ' || r.tg || ' on ' || r.tbl);
    end if;
  end loop;
  if pg_catalog.cardinality(v_missing) > 0 then
    raise exception 'UEN later: missing %. Nothing was changed.', pg_catalog.array_to_string(v_missing, ', ');
  end if;

  -- The new trigger must be the last BEFORE row trigger on kitchens.
  select pg_catalog.string_agg(t.tgname, ', ') into v_name
  from pg_catalog.pg_trigger t
  where t.tgrelid = 'public.kitchens'::regclass and not t.tgisinternal
    and (t.tgtype & 2) <> 0 and t.tgname > 'y_kitchen_live_needs_uen';
  if v_name is not null then
    raise exception 'Stopped: BEFORE trigger(s) % on kitchens would fire after y_kitchen_live_needs_uen. Nothing was changed.', v_name;
  end if;

  -- Fingerprints: (before) = the live definitions; (after) = what this file leaves.
  for r in
    select * from (values
      ('public.guard_admin_kitchen_edit()', 'd2f149c60f8ec06674856df78d4c76c4', 'd2f149c60f8ec06674856df78d4c76c4'),
      ('public.stamp_kitchen_terms_acknowledgement()', 'b00a9bff4b11a925899d848aa5ce3284', 'b00a9bff4b11a925899d848aa5ce3284'),
      ('public.guard_cook_application()', 'b834d80c3b0f0bb5020b8bb5fbd3d31b', 'b834d80c3b0f0bb5020b8bb5fbd3d31b'),
      ('public.set_kitchen_business_uen()', '074e803d7e5963bb22b435ffa04b48c8', '074e803d7e5963bb22b435ffa04b48c8'),
      ('public.sync_kitchen_business_uen()', '5b36458dff4ea8298fc2efb034ea0297', '5b36458dff4ea8298fc2efb034ea0297'),
      ('public.approved_business_uen(uuid)', '23210d0de6fb94b99b80cf441f0e8f76', '23210d0de6fb94b99b80cf441f0e8f76'),
      ('public.check_cook_application_uen()', '2ea28351f389cfad7d5a08387fd2dadf', 'a445a3c6a87c2d5ca126332f9518e1d4'),
      ('public.assisted_claim_complete(text, text, uuid, text, text)', 'b4e14450f18ef0af6a87447b0fd36901', '50b8a1a61596dfd1c85880c1a0fdd763'),
      ('public.admin_issue_assisted_claim_link(uuid, text)', 'd397bcaafced5e29922222261d72af2b', '4b08d6197dbc57214499fc14a14d1d5e')
    ) as f(sig, before_md5, after_md5)
  loop
    v_fp := pg_catalog.md5(pg_catalog.replace(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(r.sig)), E'\r', ''));
    if v_fp <> r.before_md5 and v_fp <> r.after_md5 then
      raise exception 'Stopped: % is not the version this file was written for (fingerprint %). Nothing was changed. Send its live definition for review.', r.sig, v_fp;
    end if;
  end loop;

  -- The new functions: absent, or exactly this file's version (a re-run).
  for r in
    select * from (values
      ('public.set_my_business_uen(text)', '9dfcffeb9e9a8985d4b551ae4076113a'),
      ('public.admin_set_kitchen_business_uen(uuid, text, text, text)', '0d53e625a66f441579e2da9b8197473d'),
      ('public.kitchen_live_needs_uen()', 'aef8fc1e57ad21c7f1e86dddc3865e50')
    ) as f(sig, after_md5)
  loop
    if pg_catalog.to_regprocedure(r.sig) is not null
       and pg_catalog.md5(pg_catalog.replace(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(r.sig)), E'\r', '')) <> r.after_md5 then
      raise exception 'Stopped: % already exists and is not this file''s version. Nothing was changed.', r.sig;
    end if;
  end loop;

  if coalesce(pg_catalog.current_setting('kb_assist.uen_pending', true), '') <> '' then
    raise exception 'Stopped: kb_assist.uen_pending is set in this session. Nothing was changed.';
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. THE UEN CHECK ON NEW APPLICATIONS: one exemption, for the claim only.
-- The live text (Partner docs/supabase-schema.sql section 26); only the
-- null-UEN branch changes.
-- ----------------------------------------------------------------------------
create or replace function public.check_cook_application_uen()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.business_uen := nullif(upper(btrim(coalesce(new.business_uen, ''))), '');

  if new.business_type is not distinct from 'Home Cook' then
    new.business_uen := null;
  elsif new.business_uen is null then
    -- Assisted onboarding only (docs/supabase-assisted-uen-later.sql): the
    -- claim may create an approved application before the owner has added
    -- the UEN. All three must hold; anything else needs a UEN, as before.
    if not (coalesce(current_setting('kb_assist.uen_pending', true), '') = 'on'
            and current_user not in ('anon', 'authenticated')
            and new.status = 'approved') then
      raise exception 'A Business Registration Number (UEN) is required for registered businesses.' using errcode = '23514';
    end if;
  elsif new.business_uen !~ '^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$' then
    raise exception 'That doesn''t look like a valid UEN (e.g. 53123456X or 201912345K).' using errcode = '23514';
  end if;

  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- 2. THE CLAIM: the flag around its cook_applications insert, and the
-- step-2 comment. The live text otherwise.
-- ----------------------------------------------------------------------------
create or replace function public.assisted_claim_complete(
  p_token_hash text,
  p_client_key text,
  p_user_id uuid,
  p_user_agent text,
  p_privacy_policy_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token public.assisted_claim_tokens;
  v_shop public.assisted_shops;
  v_state text;
  v_ua text := nullif(pg_catalog.left(pg_catalog.regexp_replace(coalesce(p_user_agent, ''), '[[:cntrl:]]', '', 'g'), 400), '');
  v_version text := nullif(pg_catalog.btrim(coalesce(p_privacy_policy_version, '')), '');
  v_role text;
  v_app_id uuid;
  v_app_created timestamptz;
  v_ack timestamptz;
  v_items int;
begin
  if p_client_key is null or p_client_key !~ '^[0-9a-f]{64}$' then
    raise exception 'assisted_claim: bad client key' using errcode = '22023';
  end if;
  if v_version is null or v_version !~ '^[0-9A-Za-z._-]{1,32}$' then
    raise exception 'assisted_claim: privacy policy version missing' using errcode = '22023';
  end if;
  if public.assisted_claim_rate_limited(p_client_key) then
    insert into public.assisted_claim_attempts (client_key, kind, result) values (p_client_key, 'claim', 'rate_limited');
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  -- Lock the token, then the shop: a double tap waits here and then sees 'used'.
  if p_token_hash ~ '^[0-9a-f]{64}$' then
    select * into v_token from public.assisted_claim_tokens t where t.token_hash = p_token_hash for update;
    if v_token.id is not null then
      select * into v_shop from public.assisted_shops s where s.id = v_token.shop_id for update;
    end if;
  end if;
  v_state := public.assisted_claim_token_state(v_token, v_shop.status);
  if v_state <> 'ok' then
    insert into public.assisted_claim_attempts (client_key, kind, result) values (p_client_key, 'claim', v_state);
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;

  -- The new account: made for this shop, still a plain customer, nothing else.
  if p_user_id is null or not exists (
    select 1 from auth.users u
    where u.id = p_user_id and (u.raw_app_meta_data ->> 'kb_assisted_shop_id') = v_shop.id::text
  ) then
    raise exception 'assisted_claim: the account was not made for this shop' using errcode = '42501';
  end if;
  select p.role into v_role from public.profiles p where p.id = p_user_id for update;
  if not found then
    raise exception 'assisted_claim: the account has no profile row' using errcode = 'P0002';
  end if;
  if v_role <> 'customer'
     or exists (select 1 from public.kitchens k where k.id = p_user_id)
     or exists (select 1 from public.cook_applications a where a.user_id = p_user_id) then
    raise exception 'assisted_claim: the account is already in use' using errcode = '42501';
  end if;

  -- 1. Profile: the owner's name and mobile (an existing phone is kept).
  update public.profiles p
  set full_name = v_shop.owner_name, phone = coalesce(p.phone, v_shop.owner_mobile)
  where p.id = p_user_id;

  -- 2. An approved cook application. Its existing triggers promote the role
  --    to 'cook'. The billing trigger makes no subscription row and no
  --    founding number while billing is off (the pilot); if billing is ever
  --    on it fails closed (an error there undoes the whole claim).
  --    created_at = when HQ set the shop up.
  --    A shop that isn't Home Cook may be claimed before its UEN is in: the
  --    flag lets this one insert through check_cook_application_uen.
  if v_shop.category <> 'home-cook' and v_shop.business_uen is null then
    perform pg_catalog.set_config('kb_assist.uen_pending', 'on', true);
  end if;
  insert into public.cook_applications (
    user_id, business_name, business_type, description, business_uen,
    business_address, postal_code, status, reviewed_by, reviewed_at,
    privacy_policy_version, created_at
  ) values (
    p_user_id, v_shop.business_name,
    case v_shop.category
      when 'home-cook' then 'Home Cook'
      when 'hawker' then 'Hawker'
      when 'bakery' then 'Bakery'
      when 'vegetarian' then 'Vegetarian'
      when 'drinks-desserts' then 'Drinks & Desserts'
    end,
    v_shop.description, v_shop.business_uen,
    v_shop.business_address, v_shop.postal_code, 'approved', v_shop.created_by, pg_catalog.now(),
    v_version, v_shop.created_at
  )
  returning id, created_at into v_app_id, v_app_created;
  perform pg_catalog.set_config('kb_assist.uen_pending', '', true);
  if v_app_created is distinct from v_shop.created_at then
    raise exception 'assisted_claim: the application date was changed by a trigger' using errcode = 'P0001';
  end if;
  if (select p.role from public.profiles p where p.id = p_user_id) is distinct from 'cook' then
    raise exception 'assisted_claim: the account was not promoted to cook' using errcode = 'P0001';
  end if;

  -- 3. The kitchen. acknowledged_terms_at: any value means "ticked"; the
  --    live terms trigger replaces it with now(). Not live until PayNow.
  insert into public.kitchens (id, business_name, category, cuisine_type, is_halal, description, hero_image, is_live, acknowledged_terms_at)
  values (p_user_id, v_shop.business_name, v_shop.category, v_shop.cuisine_type, v_shop.is_halal,
          v_shop.description, v_shop.hero_image, false, pg_catalog.now());
  select k.acknowledged_terms_at into v_ack from public.kitchens k where k.id = p_user_id;
  if v_ack is null then
    raise exception 'assisted_claim: the terms were not recorded' using errcode = 'P0001';
  end if;

  -- 4. Pickup address (private). Exact coordinates are added by Kitchen
  --    Setup's postal lookup on the owner's first save.
  insert into public.kitchen_addresses (kitchen_id, business_address, postal_code)
  values (p_user_id, v_shop.business_address, v_shop.postal_code);

  -- 5. Visible draft items become the menu.
  insert into public.menu_items (kitchen_id, name, price, photo_url, is_hidden)
  select p_user_id, i.name, i.price, i.photo_url, false
  from public.assisted_shop_items i
  where i.shop_id = v_shop.id and not i.is_hidden
  order by i.created_at, i.id;
  get diagnostics v_items = row_count;

  -- 6. Close the token and the draft.
  update public.assisted_claim_tokens t
  set used_at = pg_catalog.now(), used_user_agent = v_ua
  where t.id = v_token.id;

  update public.assisted_shops s
  set status = 'claimed', claimed_user_id = p_user_id, claimed_at = pg_catalog.now(),
      acknowledged_at = v_ack, acknowledged_token_id = v_token.id, acknowledged_user_agent = v_ua
  where s.id = v_shop.id;

  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, kitchen_id, action, details)
  values (p_user_id, 'owner', v_shop.id, v_shop.business_name, v_token.id, p_user_id, 'claimed',
          pg_catalog.jsonb_build_object(
            'acknowledged_terms_at', v_ack,
            'user_agent', v_ua,
            'privacy_policy_version', v_version,
            'cook_application_id', v_app_id,
            'menu_items', v_items));

  insert into public.assisted_claim_attempts (client_key, kind, result) values (p_client_key, 'claim', 'ok');

  return pg_catalog.jsonb_build_object('status', 'ok', 'kitchen_id', p_user_id, 'acknowledged_terms_at', v_ack);
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. THE CLAIM LINK: no UEN needed to send it. The live text otherwise.
-- ----------------------------------------------------------------------------
create or replace function public.admin_issue_assisted_claim_link(p_shop_id uuid, p_token_hash text)
returns table (token_id uuid, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.assisted_shops;
  v_old record;
  v_id uuid;
  v_expires timestamptz := pg_catalog.now() + pg_catalog.make_interval(hours => 48);
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid claim token.' using errcode = '22023';
  end if;

  select * into v_shop from public.assisted_shops s where s.id = p_shop_id for update;
  if not found then
    raise exception 'Shop not found.' using errcode = 'P0002';
  end if;
  if v_shop.status <> 'draft' then
    raise exception 'This shop has already been claimed or cancelled.' using errcode = '22023';
  end if;
  if v_shop.business_address is null or v_shop.postal_code is null then
    raise exception 'Add the pickup address and postal code before sending a claim link.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.assisted_shop_items i where i.shop_id = p_shop_id and not i.is_hidden) then
    raise exception 'Add at least one menu item before sending a claim link.' using errcode = '22023';
  end if;

  for v_old in
    update public.assisted_claim_tokens t
    set revoked_at = pg_catalog.now(), revoked_by = auth.uid(), revoke_reason = 'replaced by a new link'
    where t.shop_id = p_shop_id and t.used_at is null and t.revoked_at is null
    returning t.id
  loop
    insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, action, details)
    values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, v_old.id, 'link_revoked',
            pg_catalog.jsonb_build_object('reason', 'replaced by a new link'));
  end loop;

  insert into public.assisted_claim_tokens (shop_id, token_hash, created_by, expires_at)
  values (p_shop_id, p_token_hash, auth.uid(), v_expires)
  returning id into v_id;

  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, action, details)
  values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, v_id, 'link_issued',
          pg_catalog.jsonb_build_object('expires_at', v_expires));

  return query select v_id, v_expires;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. THE OWNER ADDS OR CORRECTS THE UEN (Kitchen Setup), only while not live.
-- SECURITY DEFINER because applicants have no UPDATE policy on
-- cook_applications. The insert trigger doesn't run on an update, so the
-- format is checked here, with the same rule as section 26. Its update runs
-- as the function owner, so a_kitchen_admin_guard lets it through, and the
-- terms trigger keeps the existing acknowledgement (it is never sent).
-- ----------------------------------------------------------------------------
create or replace function public.set_my_business_uen(p_uen text)
returns text  -- the UEN as saved
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_uen text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_uen, ''))), '');
  v_app_id uuid;
  v_type text;
  v_live boolean;
  v_saved text;
begin
  if v_uid is null then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;

  -- The application the kitchen's UEN comes from: same order as approved_business_uen().
  select a.id, a.business_type into v_app_id, v_type
  from public.cook_applications a
  where a.user_id = v_uid and a.status = 'approved'
  order by a.reviewed_at desc nulls last, a.created_at desc
  limit 1
  for update;
  if v_app_id is null then
    raise exception 'Only an approved Kopi Boy partner can add a business UEN.' using errcode = '42501';
  end if;
  if v_type is not distinct from 'Home Cook' then
    raise exception 'A Home Cook kitchen doesn''t need a business UEN.' using errcode = '22023';
  end if;

  select k.is_live into v_live from public.kitchens k where k.id = v_uid for update;
  if not found then
    raise exception 'Set up your kitchen first.' using errcode = 'P0002';
  end if;
  if v_live then
    raise exception 'Your shop is live, so only Kopi Boy HQ can change your UEN. Message HQ with the correct UEN.' using errcode = '42501';
  end if;

  if v_uen is null then
    raise exception 'Please enter your Business Registration Number (UEN).' using errcode = '22023';
  end if;
  if v_uen !~ '^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$' then
    raise exception 'That doesn''t look like a valid UEN (e.g. 53123456X or 201912345K).' using errcode = '22023';
  end if;

  update public.cook_applications a set business_uen = v_uen where a.id = v_app_id;
  -- before_kitchen_business_uen recomputes it from the application.
  update public.kitchens k set business_uen = null where k.id = v_uid;

  select k.business_uen into v_saved from public.kitchens k where k.id = v_uid;
  if v_saved is distinct from v_uen then
    raise exception 'set_my_business_uen: the kitchen UEN did not update' using errcode = 'P0001';
  end if;
  return v_uen;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. HQ SETS OR CORRECTS THE UEN, live or not. Like admin_set_kitchen_paynow:
-- admins only, the typed business name and a reason. auth.uid() is still
-- the admin, so z_kitchen_admin_audit logs the kitchens change with the reason.
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_kitchen_business_uen(
  p_kitchen_id uuid,
  p_uen text,
  p_confirm_business_name text,
  p_reason text
)
returns text  -- the UEN as saved
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uen text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_uen, ''))), '');
  v_name text;
  v_app_id uuid;
  v_type text;
  v_saved text;
begin
  if not public.is_admin_editing_kitchen(p_kitchen_id) then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception 'Give a reason for changing the business UEN.' using errcode = '22023';
  end if;
  if v_uen is null or v_uen !~ '^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$' then
    raise exception 'That doesn''t look like a valid UEN (e.g. 53123456X or 201912345K).' using errcode = '22023';
  end if;

  select k.business_name into v_name from public.kitchens k where k.id = p_kitchen_id for update;
  if v_name is null then
    raise exception 'Kitchen not found.' using errcode = 'P0002';
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_confirm_business_name, ''))) <> pg_catalog.lower(pg_catalog.btrim(v_name)) then
    raise exception 'Type the kitchen''s business name exactly to confirm.' using errcode = '22023';
  end if;

  select a.id, a.business_type into v_app_id, v_type
  from public.cook_applications a
  where a.user_id = p_kitchen_id and a.status = 'approved'
  order by a.reviewed_at desc nulls last, a.created_at desc
  limit 1
  for update;
  if v_app_id is null then
    raise exception 'This kitchen has no approved application to hold a UEN.' using errcode = '22023';
  end if;
  if v_type is not distinct from 'Home Cook' then
    raise exception 'A Home Cook kitchen doesn''t carry a business UEN.' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('kb.admin_edit_reason', pg_catalog.btrim(p_reason), true);
  update public.cook_applications a set business_uen = v_uen where a.id = v_app_id;
  update public.kitchens k set business_uen = null where k.id = p_kitchen_id;
  perform pg_catalog.set_config('kb.admin_edit_reason', '', true);

  select k.business_uen into v_saved from public.kitchens k where k.id = p_kitchen_id;
  if v_saved is distinct from v_uen then
    raise exception 'admin_set_kitchen_business_uen: the kitchen UEN did not update' using errcode = 'P0001';
  end if;
  return v_uen;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. NO GOING LIVE WITHOUT A UEN, for a shop that needs one.
-- ----------------------------------------------------------------------------
create or replace function public.kitchen_live_needs_uen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  if not coalesce(new.is_live, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.is_live, false) then
    return new;  -- already live: never judged again
  end if;
  if tg_op = 'INSERT' and exists (select 1 from public.kitchens k where k.id = new.id and k.is_live) then
    return new;  -- an upsert onto a kitchen that is already live
  end if;
  if new.business_uen is not null then
    return new;
  end if;

  select a.business_type into v_type
  from public.cook_applications a
  where a.user_id = new.id and a.status = 'approved'
  order by a.reviewed_at desc nulls last, a.created_at desc
  limit 1;
  if not found or v_type is not distinct from 'Home Cook' then
    return new;  -- no approved application, or a Home Cook: no UEN needed
  end if;

  raise exception 'Add your business UEN (Business Registration Number) in Kitchen Setup before your shop goes live.'
    using errcode = '23514';
end;
$$;

drop trigger if exists y_kitchen_live_needs_uen on public.kitchens;
create trigger y_kitchen_live_needs_uen
  before insert or update on public.kitchens
  for each row execute function public.kitchen_live_needs_uen();


-- ----------------------------------------------------------------------------
-- 7. PRIVILEGES. The claim and the claim link keep theirs (create or
-- replace leaves them as they were; section 8 checks).
-- ----------------------------------------------------------------------------
revoke all on function public.set_my_business_uen(text) from public, anon, authenticated, service_role;
grant execute on function public.set_my_business_uen(text) to authenticated;
revoke all on function public.admin_set_kitchen_business_uen(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_kitchen_business_uen(uuid, text, text, text) to authenticated;
revoke all on function public.kitchen_live_needs_uen() from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 8. CHECKS AFTER. Otherwise everything rolls back.
-- ----------------------------------------------------------------------------
do $$
declare
  v_fp text;
  v_name text;
  v_msg text;
  r record;
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
      ('public.admin_issue_assisted_claim_link(uuid, text)', '4b08d6197dbc57214499fc14a14d1d5e'),
      ('public.set_my_business_uen(text)', '9dfcffeb9e9a8985d4b551ae4076113a'),
      ('public.admin_set_kitchen_business_uen(uuid, text, text, text)', '0d53e625a66f441579e2da9b8197473d'),
      ('public.kitchen_live_needs_uen()', 'aef8fc1e57ad21c7f1e86dddc3865e50')
    ) as f(sig, want)
  loop
    v_fp := pg_catalog.md5(pg_catalog.replace(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(r.sig)), E'\r', ''));
    if v_fp <> r.want then
      raise exception 'Stopped: % is not as expected after the change (fingerprint %)', r.sig, v_fp;
    end if;
  end loop;

  if not exists (select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid = t.tgfoid
                 where t.tgrelid = 'public.kitchens'::regclass and t.tgname = 'y_kitchen_live_needs_uen'
                   and p.proname = 'kitchen_live_needs_uen' and t.tgenabled = 'O') then
    raise exception 'Stopped: y_kitchen_live_needs_uen is not installed and enabled';
  end if;
  select pg_catalog.string_agg(t.tgname, ', ') into v_name
  from pg_catalog.pg_trigger t
  where t.tgrelid = 'public.kitchens'::regclass and not t.tgisinternal
    and (t.tgtype & 2) <> 0 and t.tgname > 'y_kitchen_live_needs_uen';
  if v_name is not null then
    raise exception 'Stopped: BEFORE trigger(s) % on kitchens fire after y_kitchen_live_needs_uen', v_name;
  end if;

  if exists (select 1 from pg_catalog.pg_proc p
             where p.pronamespace = 'public'::regnamespace
               and p.proname in ('set_my_business_uen', 'admin_set_kitchen_business_uen', 'kitchen_live_needs_uen',
                                 'assisted_claim_complete', 'admin_issue_assisted_claim_link')
               and not p.prosecdef) then
    raise exception 'Stopped: a function that must be SECURITY DEFINER is not';
  end if;

  if not has_function_privilege('authenticated', 'public.set_my_business_uen(text)', 'execute')
     or has_function_privilege('anon', 'public.set_my_business_uen(text)', 'execute')
     or has_function_privilege('service_role', 'public.set_my_business_uen(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.admin_set_kitchen_business_uen(uuid, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.admin_set_kitchen_business_uen(uuid, text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.kitchen_live_needs_uen()', 'execute')
     or has_function_privilege('anon', 'public.kitchen_live_needs_uen()', 'execute')
     or not has_function_privilege('service_role', 'public.assisted_claim_complete(text, text, uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.assisted_claim_complete(text, text, uuid, text, text)', 'execute')
     or has_function_privilege('anon', 'public.assisted_claim_complete(text, text, uuid, text, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.admin_issue_assisted_claim_link(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.admin_issue_assisted_claim_link(uuid, text)', 'execute') then
    raise exception 'Stopped: function privileges are wrong';
  end if;

  -- With no signed-in user both new functions refuse (inner blocks: their own rollback points).
  v_msg := null;
  begin
    perform public.set_my_business_uen('53123456A');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Please sign in again%' then
    raise exception 'Stopped: set_my_business_uen did not refuse without a signed-in owner (%)', coalesce(v_msg, 'no error');
  end if;
  v_msg := null;
  begin
    perform public.admin_set_kitchen_business_uen(gen_random_uuid(), '53123456A', 'x', 'x');
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Not allowed%' then
    raise exception 'Stopped: admin_set_kitchen_business_uen did not refuse a non-admin (%)', coalesce(v_msg, 'no error');
  end if;

  if coalesce(pg_catalog.current_setting('kb_assist.uen_pending', true), '') <> '' then
    raise exception 'Stopped: kb_assist.uen_pending was left on';
  end if;
end;
$$;

commit;

select 'UEN LATER INSTALLED' as result;
