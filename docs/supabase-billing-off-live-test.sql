-- ============================================================================
-- KOPI BOY — Billing OFF LIVE TEST. ALWAYS ROLLS BACK.
--
-- Run after docs/supabase-billing-off.sql. It creates two throw-away users
-- (@example.invalid, fixed test ids) whose applications are dated BEFORE the
-- old founding cutoff (so under the cancelled offer they would have got a
-- founding number), approves them the two ways a cook gets approved, checks
-- every result, and then raises "TEST OK, rolled back ..." so NOTHING is
-- kept. Push requests queued by pg_net and Realtime changes are only sent
-- after a commit, so nothing goes out. If any check fails it raises
-- "TEST FAILED: ..." instead, which also rolls everything back.
--
-- What it checks:
--   * billing_enabled and every reminder/restriction switch are off
--   * Boss approval (pending -> approved): role becomes cook, NO
--     subscription row, NO founding number, NO subscription_created event
--   * an application INSERTED already approved (the path
--     assisted_claim_complete uses): the same, no row, no founding number
--   * the highest founding number and the row counts don't move
--   * billing_create_subscription refuses with billing_off
--   * every existing subscription row reads 'off'
--   * the switches can't be turned on while billing is off (the CHECK)
--   * kb.billing_write is back off afterwards
-- The full assisted claim is checked by
-- docs/supabase-assisted-onboarding-live-test.sql (check 5 expects no
-- subscription row and no founding number).
--
-- Paste the whole DO block as ONE block. Last line should be:
--   ERROR: TEST OK, rolled back: billing off, approval and approved insert made cook with no subscription row or founding number, ... Nothing was saved.
-- ============================================================================
do $$
declare
  u_update uuid := 'a0000000-0000-4000-8000-00000000b0f1';
  u_insert uuid := 'a0000000-0000-4000-8000-00000000b0f2';
  v_s public.billing_settings;
  v_max_before int;
  v_subs_before bigint;
  v_events_before bigint;
  v_app uuid;
  v_n bigint;
  v_msg text;
begin
  if exists (select 1 from auth.users where id in (u_update, u_insert)) then
    raise exception 'TEST FAILED: the test user ids already exist. Nothing was saved.';
  end if;

  select * into v_s from public.billing_settings s where s.id;
  if v_s.billing_enabled is distinct from false or v_s.reminders_inapp_enabled or v_s.reminders_email_enabled or v_s.restrictions_enabled then
    raise exception 'TEST FAILED: a billing switch is on: %. Nothing was saved.', to_jsonb(v_s);
  end if;

  select coalesce(max(founding_number), 0), count(*) into v_max_before, v_subs_before from public.merchant_subscriptions;
  select count(*) into v_events_before from public.subscription_events;

  -- Two throw-away users; on_auth_user_created makes their profiles.
  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    (u_update, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kb-billing-off-approve@example.invalid', '{}'::jsonb, '{"full_name":"KB Billing Off Approve"}'::jsonb, now(), now()),
    (u_insert, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kb-billing-off-insert@example.invalid',  '{}'::jsonb, '{"full_name":"KB Billing Off Insert"}'::jsonb,  now(), now());
  select count(*) into v_n from public.profiles where id in (u_update, u_insert);
  if v_n <> 2 then
    raise exception 'TEST FAILED: expected 2 profiles from on_auth_user_created, found %. Nothing was saved.', v_n;
  end if;

  -- 1. Boss approval: pending, then approved.
  insert into public.cook_applications (user_id, business_name, business_type, status, created_at)
  values (u_update, 'KB Billing Off Test', 'Home Cook', 'pending', '2026-11-01 10:00:00+08')
  returning id into v_app;
  update public.cook_applications set status = 'approved', reviewed_at = now() where id = v_app;

  -- 2. Inserted already approved, as assisted_claim_complete does.
  insert into public.cook_applications (user_id, business_name, business_type, status, reviewed_at, created_at)
  values (u_insert, 'KB Billing Off Test 2', 'Home Cook', 'approved', now(), '2026-11-01 10:00:00+08');

  select count(*) into v_n from public.profiles where id in (u_update, u_insert) and role = 'cook';
  if v_n <> 2 then
    raise exception 'TEST FAILED: approval did not make both users cooks (% of 2). Nothing was saved.', v_n;
  end if;
  if exists (select 1 from public.merchant_subscriptions where merchant_id in (u_update, u_insert)) then
    raise exception 'TEST FAILED: an approval made a subscription row while billing is off. Nothing was saved.';
  end if;
  if exists (select 1 from public.subscription_events where merchant_id in (u_update, u_insert)) then
    raise exception 'TEST FAILED: an approval wrote a subscription event while billing is off. Nothing was saved.';
  end if;
  select count(*) into v_n from public.merchant_subscriptions;
  if v_n <> v_subs_before or (select coalesce(max(founding_number), 0) from public.merchant_subscriptions) <> v_max_before then
    raise exception 'TEST FAILED: subscription rows or the highest founding number changed. Nothing was saved.';
  end if;
  select count(*) into v_n from public.subscription_events;
  if v_n <> v_events_before then
    raise exception 'TEST FAILED: subscription_events changed (% before, % now). Nothing was saved.', v_events_before, v_n;
  end if;

  -- 3. The function refuses outright.
  v_msg := null;
  begin
    perform public.billing_create_subscription(v_app, 'trigger');
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'billing_off:%' then
    raise exception 'TEST FAILED: billing_create_subscription did not refuse (%). Nothing was saved.', coalesce(v_msg, 'no error');
  end if;

  -- 4. Every existing row reads 'off'.
  select count(*) into v_n from public.merchant_subscriptions s
  where public.subscription_status(s, public.sgt_today()) is distinct from 'off';
  if v_n <> 0 then
    raise exception 'TEST FAILED: % subscription row(s) do not read ''off''. Nothing was saved.', v_n;
  end if;

  -- 5. A reminder switch can't go on while billing is off.
  v_msg := null;
  begin
    perform set_config('kb.billing_write', 'on', true);
    update public.billing_settings set reminders_email_enabled = true where id;
  exception when check_violation then
    v_msg := sqlerrm;
  end;
  perform set_config('kb.billing_write', 'off', true);
  if v_msg is null or v_msg not like '%billing_settings_off_means_off%' then
    raise exception 'TEST FAILED: reminders could be switched on while billing is off (%). Nothing was saved.', coalesce(v_msg, 'no error');
  end if;

  if coalesce(current_setting('kb.billing_write', true), '') = 'on' then
    raise exception 'TEST FAILED: kb.billing_write was left on. Nothing was saved.';
  end if;

  raise exception 'TEST OK, rolled back: billing off, approval and approved insert made cook with no subscription row or founding number, % existing row(s) kept and read off, highest founding number still %, create refused, switches locked off. Nothing was saved.',
    v_subs_before, v_max_before;
end;
$$;
