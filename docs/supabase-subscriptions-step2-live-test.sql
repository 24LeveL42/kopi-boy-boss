-- ============================================================================
-- KOPI BOY — Merchant subscriptions, step 2 LIVE TEST. ALWAYS ROLLS BACK.
--
-- Run after docs/supabase-subscriptions-step2.sql (and the backfill). It
-- creates three throw-away users (@example.invalid, fixed test ids), takes
-- them through the real approval path, checks every result, and then raises
-- "TEST OK, rolled back ..." so NOTHING is kept: no users, profiles,
-- applications, subscription rows, events, founding numbers or
-- notifications. Push requests queued by pg_net and Realtime changes are only
-- sent after a commit, so nothing goes out. If any check fails it raises
-- "TEST FAILED: ..." instead, which also rolls everything back.
--
-- What it checks:
--   * applied 21 Dec 2026 23:59:59 SGT -> founding, number = current max + 1,
--     anchor per the rules (22 Mar 2027 when run before then)
--   * applied 22 Dec 2026 00:00:00 SGT -> not founding, no number, anchor =
--     later of today and launch day, + 1 month (22 Jan 2027 when run before
--     launch)
--   * one 'subscription_created' event each; the kb.billing_write flag is
--     back off afterwards
--   * approved -> rejected -> approved, and a second approved application,
--     change nothing
--   * a rider approval creates nothing
--   * the Boss delete function, as a real admin (the first admin profile):
--     refused for a non-admin, refused when a payment exists, removes an
--     unpaid row and writes 'subscription_deleted'
--
-- Prefer a staging/branch project first if you have one. Paste the whole
-- DO block as ONE block. Leave v_commit = false: this test never commits.
-- Last line should be:
--   ERROR: TEST OK, rolled back: founding #<n> anchor <date>, not founding anchor <date>, ... Nothing was saved.
-- ============================================================================
do $$
declare
  v_commit boolean := false;  -- this test never commits; leave it false
  u_founding uuid := 'a0000000-0000-4000-8000-00000000f001';
  u_regular  uuid := 'a0000000-0000-4000-8000-00000000f002';
  u_rider    uuid := 'a0000000-0000-4000-8000-00000000f003';
  v_launch date;
  v_free_until date;
  v_today date := public.sgt_today();
  v_max int;
  v_app_f uuid;
  v_app_r uuid;
  v_app uuid;
  v_ts timestamptz;
  v_sub public.merchant_subscriptions;
  v_n int;
  v_expect_f date;
  v_expect_r date;
  v_admin uuid;
  v_removed boolean;
  v_refused text;
  v_delete_note text;
begin
  if v_commit then
    raise exception 'The live test never commits. Leave v_commit = false.';
  end if;
  if exists (select 1 from auth.users where id in (u_founding, u_regular, u_rider)) then
    raise exception 'TEST FAILED: the test user ids already exist. Nothing was saved.';
  end if;

  select s.launch_date, s.founding_free_until into v_launch, v_free_until from public.billing_settings s where s.id;
  select coalesce(max(founding_number), 0) into v_max from public.merchant_subscriptions;

  -- Three throw-away users; on_auth_user_created makes their profiles.
  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    (u_founding, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kb-live-test-founding@example.invalid', '{}'::jsonb, '{"full_name":"KB Live Test Founding"}'::jsonb, now(), now()),
    (u_regular,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kb-live-test-regular@example.invalid',  '{}'::jsonb, '{"full_name":"KB Live Test Regular"}'::jsonb,  now(), now()),
    (u_rider,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kb-live-test-rider@example.invalid',    '{}'::jsonb, '{"full_name":"KB Live Test Rider"}'::jsonb,    now(), now());
  select count(*) into v_n from public.profiles where id in (u_founding, u_regular, u_rider);
  if v_n <> 3 then
    raise exception 'TEST FAILED: expected 3 profiles from on_auth_user_created, found %. Nothing was saved.', v_n;
  end if;

  -- Applications on either side of the Singapore cutoff (created as pending,
  -- like the Partner app does). If a guard changes created_at, set it back.
  foreach v_ts in array array['2026-12-21 23:59:59+08'::timestamptz, '2026-12-22 00:00:00+08'::timestamptz] loop
    insert into public.cook_applications (user_id, business_name, business_type, status, created_at)
    values (case when v_ts < '2026-12-22 00:00:00+08' then u_founding else u_regular end,
            'KB Live Test Kitchen', 'Home Cook', 'pending', v_ts)
    returning id into v_app;
    update public.cook_applications set created_at = v_ts where id = v_app and created_at is distinct from v_ts;
    if (select created_at from public.cook_applications where id = v_app) is distinct from v_ts then
      raise exception 'TEST FAILED: could not set the test application''s created_at (a guard changed it). Nothing was saved.';
    end if;
    if v_ts < '2026-12-22 00:00:00+08' then v_app_f := v_app; else v_app_r := v_app; end if;
  end loop;

  -- Approve both, the way Boss does.
  update public.cook_applications set status = 'approved', reviewed_at = now() where id in (v_app_f, v_app_r);

  v_expect_f := case when v_today > v_free_until
                     then greatest(v_free_until, (v_today + make_interval(months => 1))::date)
                     else v_free_until end;
  v_expect_r := (greatest(v_today, v_launch) + make_interval(months => 1))::date;

  select * into v_sub from public.merchant_subscriptions where merchant_id = u_founding;
  if not found or v_sub.founding_number is distinct from v_max + 1 or v_sub.billing_anchor <> v_expect_f
     or v_sub.exempt or v_sub.months_paid <> 0 or v_sub.applied_at <> '2026-12-21 23:59:59+08' then
    raise exception 'TEST FAILED: founding row wrong: % (expected number %, anchor %). Nothing was saved.', to_jsonb(v_sub), v_max + 1, v_expect_f;
  end if;
  select * into v_sub from public.merchant_subscriptions where merchant_id = u_regular;
  if not found or v_sub.founding_number is not null or v_sub.billing_anchor <> v_expect_r or v_sub.exempt then
    raise exception 'TEST FAILED: non-founding row wrong: % (expected no number, anchor %). Nothing was saved.', to_jsonb(v_sub), v_expect_r;
  end if;
  select count(*) into v_n from public.subscription_events
  where merchant_id in (u_founding, u_regular) and action = 'subscription_created' and details ->> 'source' = 'trigger';
  if v_n <> 2 then
    raise exception 'TEST FAILED: expected 2 subscription_created events, found %. Nothing was saved.', v_n;
  end if;
  if coalesce(current_setting('kb.billing_write', true), '') = 'on' then
    raise exception 'TEST FAILED: kb.billing_write was left on after the approval. Nothing was saved.';
  end if;

  -- Re-approve, and a second approved application: nothing changes.
  update public.cook_applications set status = 'rejected' where id = v_app_f;
  update public.cook_applications set status = 'approved', reviewed_at = now() where id = v_app_f;
  insert into public.cook_applications (user_id, business_name, business_type, status)
  values (u_founding, 'KB Live Test Kitchen 2', 'Home Cook', 'pending') returning id into v_app;
  update public.cook_applications set status = 'approved', reviewed_at = now() where id = v_app;
  select count(*) into v_n from public.subscription_events where merchant_id = u_founding;
  if v_n <> 1 or (select founding_number from public.merchant_subscriptions where merchant_id = u_founding) is distinct from v_max + 1 then
    raise exception 'TEST FAILED: re-approval changed something (% events). Nothing was saved.', v_n;
  end if;

  -- A rider approval creates nothing.
  insert into public.rider_applications (user_id, status) values (u_rider, 'pending') returning id into v_app;
  update public.rider_applications set status = 'approved', reviewed_at = now() where id = v_app;
  if exists (select 1 from public.merchant_subscriptions where merchant_id = u_rider) then
    raise exception 'TEST FAILED: a rider approval created a subscription row. Nothing was saved.';
  end if;

  -- The Boss delete function, signed in as a real admin.
  select p.id into v_admin from public.profiles p where p.role = 'admin' order by p.id limit 1;
  if v_admin is null then
    v_delete_note := 'delete check skipped (no admin profile)';
  else
    -- a non-admin is refused
    perform set_config('request.jwt.claim.sub', u_rider::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', u_rider, 'role', 'authenticated')::text, true);
    v_refused := null;
    begin
      perform public.admin_remove_unpaid_subscription(u_regular, 'live test');
    exception when others then
      v_refused := sqlerrm;
    end;
    if v_refused is null or v_refused not like 'Only admins%' then
      raise exception 'TEST FAILED: a non-admin was not refused (%). Nothing was saved.', coalesce(v_refused, 'no error');
    end if;

    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

    -- refused when a payment exists
    perform set_config('kb.billing_write', 'on', true);
    insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference, recorded_by)
    values (u_founding, 2995, v_today, 'KB-LIVE-TEST-' || gen_random_uuid(), v_admin);
    perform set_config('kb.billing_write', 'off', true);
    v_refused := null;
    begin
      perform public.admin_remove_unpaid_subscription(u_founding, 'live test');
    exception when others then
      v_refused := sqlerrm;
    end;
    if v_refused is null or v_refused not like 'billing_has_payments%' then
      raise exception 'TEST FAILED: delete with a payment was not refused (%). Nothing was saved.', coalesce(v_refused, 'no error');
    end if;

    -- removes an unpaid row and logs it
    v_removed := public.admin_remove_unpaid_subscription(u_regular, 'live test');
    if v_removed is distinct from true or exists (select 1 from public.merchant_subscriptions where merchant_id = u_regular)
       or not exists (select 1 from public.subscription_events where merchant_id = u_regular and action = 'subscription_deleted' and actor = v_admin) then
      raise exception 'TEST FAILED: the unpaid subscription was not removed and logged. Nothing was saved.';
    end if;
    v_delete_note := 'delete function ok';

    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  end if;

  raise exception 'TEST OK, rolled back: founding #% anchor %, not founding anchor %, re-approve no-op, rider no-op, %. Nothing was saved.',
    v_max + 1, v_expect_f, v_expect_r, v_delete_note;
end;
$$;
