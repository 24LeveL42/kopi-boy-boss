-- ============================================================================
-- KOPI BOY — Delete a TEST merchant (owner-run, SQL editor).
--
-- Since subscriptions step 2, every approved cook has a merchant_subscriptions
-- row, and that row is referenced ON DELETE RESTRICT: deleting the profile or
-- the Auth user directly fails until the subscription row is gone. This
-- script does it in the right order, in ONE transaction:
--   subscription row (refused if ANY payment exists, voided ones included)
--   -> menu_items -> kitchens -> cook_applications -> profiles
--   -> optionally the Supabase Auth user (v_delete_auth_user)
-- Anything else that still points at the user (and has no cascade) makes the
-- whole script fail with that error, and nothing changes.
-- Deleting a kitchen cascades its orders; the message shows how many.
--
-- EVENTS ARE KEPT. subscription_events is append-only (the billing lock
-- refuses UPDATE and DELETE on it, even with the flag on) and has no foreign
-- key, so the merchant's old events stay as history and block nothing. The
-- script adds a 'subscription_deleted' event (actor empty, source
-- 'owner_script') so the history says why the row went.
-- Founding numbers: if this merchant had the highest number, the next
-- approval gets that number again (accepted, Q-G).
--
-- In Boss, use Partners > Delete test partner instead: it does the same
-- through admin_remove_unpaid_subscription.
--
-- The email is NOT stored in this file: replace the placeholder.
-- Two blocks, paste ONE AT A TIME.
-- ============================================================================


-- ============================================================================
-- BLOCK 1 — DELETE. Safe by default: with v_commit = false it does
-- everything, then rolls back and says what it would have deleted.
-- Last line should be (v_commit = false):
--   ERROR: TEST OK, rolled back: would delete subscription 1 (founding # -, exempt true), menu_items ..., profiles 1 ... Nothing was changed.
-- Last line should be (v_commit = true):
--   DELETE SCRIPT FINISHED
-- ============================================================================
do $$
declare
  v_commit boolean := false;                        -- true = really delete
  v_email text := '<paste test merchant email here>';
  v_delete_auth_user boolean := false;              -- true = also delete the Supabase Auth login
  v_reason text := 'owner script: delete test merchant';

  v_uid uuid;
  v_role text;
  v_sub public.merchant_subscriptions;
  v_has_sub boolean := false;
  v_payments int := 0;
  v_prev_flag text;
  n_menu int := 0;
  n_kitchen int := 0;
  n_apps int := 0;
  n_profile int := 0;
  n_auth int := 0;
  n_orders int := 0;
  v_summary text;
begin
  if v_email is null or btrim(v_email) = '' or v_email like '<%' then
    raise exception 'DELETE REFUSED: put the test merchant''s email in v_email. Nothing was changed.';
  end if;

  select u.id into v_uid from auth.users u where lower(u.email) = lower(btrim(v_email));
  if v_uid is null then
    raise exception 'DELETE REFUSED: no account has the email %. Nothing was changed.', v_email;
  end if;

  select p.role into v_role from public.profiles p where p.id = v_uid;
  if v_role = 'admin' then
    raise exception 'DELETE REFUSED: % is an admin account. Nothing was changed.', v_email;
  end if;
  if v_role is distinct from 'cook' and not exists (select 1 from public.cook_applications a where a.user_id = v_uid) then
    raise exception 'DELETE REFUSED: % is not a merchant (role %, no cook application). Nothing was changed.', v_email, coalesce(v_role, 'none');
  end if;

  -- The subscription row first (locked, so no payment can slip in).
  select * into v_sub from public.merchant_subscriptions s where s.merchant_id = v_uid for update;
  v_has_sub := found;
  if v_has_sub then
    select count(*)::int into v_payments from public.subscription_payments p where p.merchant_id = v_uid;
    if v_payments > 0 then
      raise exception 'DELETE REFUSED: this merchant has % payment record(s); billing history must be kept. Nothing was changed.', v_payments;
    end if;
    v_prev_flag := current_setting('kb.billing_write', true);
    perform set_config('kb.billing_write', 'on', true);
    delete from public.merchant_subscriptions s where s.merchant_id = v_uid;
    insert into public.subscription_events (merchant_id, actor, action, details)
    values (v_uid, null, 'subscription_deleted', jsonb_build_object(
      'source', 'owner_script',
      'reason', v_reason,
      'founding_number', v_sub.founding_number,
      'exempt', v_sub.exempt,
      'billing_anchor', v_sub.billing_anchor,
      'months_paid', v_sub.months_paid,
      'applied_at', v_sub.applied_at,
      'approved_at', v_sub.approved_at
    ));
    perform set_config('kb.billing_write', coalesce(nullif(v_prev_flag, ''), 'off'), true);
  end if;

  if to_regclass('public.orders') is not null then
    execute 'select count(*)::int from public.orders where kitchen_id = $1' into n_orders using v_uid;
  end if;

  delete from public.menu_items where kitchen_id = v_uid;
  get diagnostics n_menu = row_count;
  delete from public.kitchens where id = v_uid;
  get diagnostics n_kitchen = row_count;
  delete from public.cook_applications where user_id = v_uid;
  get diagnostics n_apps = row_count;
  delete from public.profiles where id = v_uid;
  get diagnostics n_profile = row_count;
  if n_profile <> 1 then
    raise exception 'DELETE FAILED: the profile row was not deleted (% rows). Nothing was changed.', n_profile;
  end if;
  if v_delete_auth_user then
    delete from auth.users where id = v_uid;
    get diagnostics n_auth = row_count;
  end if;

  v_summary := format(
    'subscription %s (founding # %s, exempt %s), menu_items %s, kitchens %s (orders with it: %s), cook_applications %s, profiles %s, auth user %s',
    case when v_has_sub then '1' else '0' end,
    coalesce(v_sub.founding_number::text, '-'),
    coalesce(v_sub.exempt::text, '-'),
    n_menu, n_kitchen, n_orders, n_apps, n_profile,
    case when v_delete_auth_user then n_auth::text else 'kept' end
  );

  if not v_commit then
    raise exception 'TEST OK, rolled back: would delete %. Set v_commit := true to delete. Nothing was changed.', v_summary;
  end if;
  raise notice 'DELETED: %', v_summary;
end;
$$;

select 'DELETE SCRIPT FINISHED' as result;
-- END BLOCK 1


-- ============================================================================
-- BLOCK 2 — VERIFY (read only). Replace the placeholder email.
-- Last line should be (after a real delete, login kept): auth_user_left = 1,
-- profile_left = 0, subscription_left = 0, applications_left = 0,
-- kitchen_left = 0, deleted_events >= 1.
-- If you also deleted the login, every column is 0 (the email no longer
-- finds the account; the event is still there under the old id).
-- ============================================================================
with target as (
  select u.id from auth.users u where lower(u.email) = lower(btrim('<paste test merchant email here>'))
)
select
  (select count(*) from target) as auth_user_left,
  (select count(*) from public.profiles p where p.id in (select id from target)) as profile_left,
  (select count(*) from public.merchant_subscriptions s where s.merchant_id in (select id from target)) as subscription_left,
  (select count(*) from public.cook_applications a where a.user_id in (select id from target)) as applications_left,
  (select count(*) from public.kitchens k where k.id in (select id from target)) as kitchen_left,
  (select count(*) from public.subscription_events e where e.merchant_id in (select id from target) and e.action = 'subscription_deleted') as deleted_events;
-- END BLOCK 2
