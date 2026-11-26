-- ============================================================================
-- KOPI BOY — Merchant subscriptions, step 2: the subscription row for every
-- approved cook, and the founding numbers.
--
-- SUPERSEDED (pilot, Nov 2026): the subscription and founding offer are
-- cancelled. docs/supabase-billing-off.sql keeps both triggers but makes
-- them create NO row and NO founding number while
-- billing_settings.billing_enabled is false. Once that is installed this
-- file refuses to re-run (it would put back the old functions).
--
-- Plan: Desktop founding-trigger-plan.txt (approved), with the owner's
-- answers Q-A to Q-G. Needs step 1 (docs/supabase-subscriptions.sql,
-- including the applied_at column) and the Partner schema
-- (cook_applications, profiles, user_has_role).
--
-- WHAT IT ADDS
--   * public.billing_create_subscription(application, source, exempt, reason)
--     The ONE place a subscription row is made (trigger and backfill both
--     use it). Idempotent: if the user already has a row it returns
--     'exists' and changes nothing.
--   * Two triggers on cook_applications (the existing ones are untouched):
--       after_cook_application_subscription         status changes TO 'approved'
--       after_cook_application_subscription_insert  a row INSERTED already approved
--     (Non-admin inserts are forced to 'pending' by the live
--     guard_cook_application trigger, so the insert path only ever sees
--     HQ / SQL editor inserts. It exists so that path can't skip billing.)
--     Never on approved -> approved. approved -> rejected -> approved, or a
--     second application for the same user, finds the row and does nothing.
--     Riders and pickers: their tables have no such trigger, never a row.
--   * public.admin_remove_unpaid_subscription(merchant, reason): lets the
--     Boss "Delete test partner" flow remove the subscription row first
--     (profiles is referenced ON DELETE RESTRICT). Admins only. Refused when
--     the merchant has ANY payment record, voided ones included.
--   * Two new subscription_events actions: 'subscription_created',
--     'subscription_deleted'.
--
-- OWNER RULES BUILT IN
--   * No cap. Founding = sgt_date(EARLIEST cook application created_at of
--     the user, any status) < billing_settings.launch_date (Q-C). That date
--     is stored as applied_at.
--   * Founding number = max(founding_number) + 1 (not a sequence), taken
--     under pg_advisory_xact_lock(hashtext('kb_founding_assign')), so two
--     approvals at the same moment queue up and can't get the same number.
--     The unique index from step 1 is the backstop. Deleting the highest
--     numbered merchant lets the next approval reuse that number; deleting
--     a middle one leaves a gap. Accepted (Q-G).
--   * Exempt (test) accounts never get a number. At approval, an applicant
--     whose profile role is 'admin' is exempt. Others are marked exempt by
--     the backfill list (or later admin actions).
--   * billing_anchor (the first due date), months_paid 0:
--       exempt                                   founding_free_until (Q-B; never billed)
--       founding, approved on/before free_until  founding_free_until (22 Mar 2027)
--       founding, approved AFTER free_until      later of free_until and approval
--                                                date + 1 month (Q-A)
--       not founding                             later of approval date and
--                                                launch_date, + 1 month (plan 2.8)
--     "approval date" = the Singapore date of reviewed_at. If reviewed_at is
--     empty, now() is used and the event says so (Q-E).
--   * Fail closed (Q-D): if making the row fails for any reason, the trigger
--     raises "billing_setup_failed: ..." and the whole approval rolls back.
--     There is no silent skip. Boss shows the message, the application stays
--     pending, no welcome email goes out. Emergency: the EMERGENCY block
--     below drops the two triggers; re-run the backfill afterwards.
--
-- CONCURRENCY NOTE: the existence check and max() run AFTER the advisory
-- lock is granted. These functions are VOLATILE and Supabase runs READ
-- COMMITTED, so each of those statements sees what the previous approval
-- committed.
--
-- RUN ORDER: after step 1. Then the backfill
-- (docs/supabase-subscriptions-step2-backfill.sql), then the live test
-- (docs/supabase-subscriptions-step2-live-test.sql). Deploy the Boss
-- delete-flow change (src/lib/delete-partner.ts) at the same time.
-- Safe to re-run: functions and triggers are replaced with the same
-- definitions, the action list is re-created with the same values, no data
-- is touched.
-- FAILS SAFELY: one transaction; the prerequisite check stops it first.
--
-- PASTE: everything from "begin;" down to the line
--   select 'STEP 2 INSTALLED' as result;
-- as ONE block. Last line should be: STEP 2 INSTALLED
-- ============================================================================


begin;

-- ----------------------------------------------------------------------------
-- 0. STOP IF A PREREQUISITE IS MISSING (nothing has changed yet).
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := array[]::text[];
  v_has_row boolean;
  v_need text[][] := array[
    array['cook_applications', 'id'], array['cook_applications', 'user_id'],
    array['cook_applications', 'status'], array['cook_applications', 'reviewed_at'],
    array['cook_applications', 'created_at'], array['profiles', 'id'], array['profiles', 'role'],
    array['merchant_subscriptions', 'applied_at'], array['merchant_subscriptions', 'founding_number'],
    array['billing_settings', 'founding_free_until'], array['subscription_events', 'action']
  ];
  i int;
begin
  for i in 1 .. array_length(v_need, 1) loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = v_need[i][1] and column_name = v_need[i][2]) then
      v_missing := pg_catalog.array_append(v_missing, 'public.' || v_need[i][1] || '.' || v_need[i][2]);
    end if;
  end loop;
  if to_regprocedure('public.user_has_role(text)') is null then
    v_missing := pg_catalog.array_append(v_missing, 'public.user_has_role(text)');
  end if;
  if to_regprocedure('public.sgt_date(timestamptz)') is null then
    v_missing := pg_catalog.array_append(v_missing, 'public.sgt_date(timestamptz) (step 1)');
  end if;
  if to_regprocedure('auth.uid()') is null then
    v_missing := pg_catalog.array_append(v_missing, 'auth.uid()');
  end if;
  -- Dynamic, so a missing table is reported here instead of failing to plan.
  if to_regclass('public.billing_settings') is not null then
    execute 'select exists (select 1 from public.billing_settings where id)' into v_has_row;
    if not v_has_row then
      v_missing := pg_catalog.array_append(v_missing, 'the billing_settings row (step 1)');
    end if;
  end if;
  if array_length(v_missing, 1) > 0 then
    raise exception 'subscriptions step 2: missing %. Nothing was changed.', array_to_string(v_missing, ', ');
  end if;
  -- Billing off (docs/supabase-billing-off.sql) replaced these functions;
  -- re-running this file would put the old ones back.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'billing_settings' and column_name = 'billing_enabled') then
    raise exception 'subscriptions step 2: billing off is installed (billing_settings.billing_enabled exists); re-running this file would undo it. Nothing was changed.';
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. TWO NEW EVENT ACTIONS (the step-1 list plus subscription_created and
-- subscription_deleted). DDL only; the billing lock is not involved.
-- ----------------------------------------------------------------------------
alter table public.subscription_events drop constraint if exists subscription_events_action_check;
alter table public.subscription_events add constraint subscription_events_action_check check (action in (
  'founding_assigned', 'payment_recorded', 'payment_voided', 'extended', 'waived',
  'exempted', 'restricted', 'restored', 'switch_changed', 'founding_changed',
  'subscription_created', 'subscription_deleted'
));


-- ----------------------------------------------------------------------------
-- 2. billing_create_subscription: the one place a subscription row is made.
-- Returns 'exists' | 'created_founding' | 'created' | 'created_exempt'.
-- Raises (plain message) when the application isn't an approved cook
-- application, the settings row or the profile is missing, or the insert
-- fails. The trigger adds the "billing_setup_failed:" prefix.
-- ----------------------------------------------------------------------------
create or replace function public.billing_create_subscription(
  p_application_id uuid,
  p_source text,
  p_exempt boolean default false,
  p_exempt_reason text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_status text;
  v_reviewed_at timestamptz;
  v_launch date;
  v_free_until date;
  v_role text;
  v_applied timestamptz;
  v_approved timestamptz;
  v_approved_source text;
  v_approved_day date;
  v_exempt boolean;
  v_exempt_reason text;
  v_eligible boolean;
  v_number int;
  v_anchor date;
  v_prev_flag text;
begin
  if p_source is null or p_source not in ('trigger', 'backfill') then
    raise exception 'unknown source %', coalesce(p_source, 'null') using errcode = '22023';
  end if;

  select a.user_id, a.status, a.reviewed_at
    into v_user, v_status, v_reviewed_at
  from public.cook_applications a
  where a.id = p_application_id;
  if not found then
    raise exception 'cook application % not found', p_application_id using errcode = 'P0002';
  end if;
  if v_status is distinct from 'approved' then
    raise exception 'cook application % is %, not approved', p_application_id, coalesce(v_status, 'null')
      using errcode = '22023';
  end if;

  -- Everything below runs one approval at a time (released at commit/rollback).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kb_founding_assign'));

  if exists (select 1 from public.merchant_subscriptions s where s.merchant_id = v_user) then
    return 'exists';
  end if;

  select s.launch_date, s.founding_free_until
    into v_launch, v_free_until
  from public.billing_settings s
  where s.id;
  if not found then
    raise exception 'the billing_settings row is missing' using errcode = 'P0002';
  end if;

  select p.role into v_role from public.profiles p where p.id = v_user;
  if not found then
    raise exception 'user % has no profile row', v_user using errcode = 'P0002';
  end if;

  v_exempt := coalesce(p_exempt, false) or v_role = 'admin';
  v_exempt_reason := case
    when coalesce(p_exempt, false) then coalesce(nullif(pg_catalog.btrim(p_exempt_reason), ''), 'exempt')
    when v_role = 'admin' then 'admin account'
  end;

  -- Q-C: the user's EARLIEST cook application, whatever its status.
  select min(a.created_at) into v_applied
  from public.cook_applications a
  where a.user_id = v_user;

  -- Q-E: no reviewed_at -> now(), and the event records that.
  if v_reviewed_at is null then
    v_approved := pg_catalog.now();
    v_approved_source := 'now (reviewed_at was empty)';
  else
    v_approved := v_reviewed_at;
    v_approved_source := 'reviewed_at';
  end if;
  v_approved_day := public.sgt_date(v_approved);
  v_eligible := public.sgt_date(v_applied) < v_launch;

  if v_eligible and not v_exempt then
    select coalesce(max(s.founding_number), 0) + 1 into v_number
    from public.merchant_subscriptions s;
  end if;

  v_anchor := case
    when v_exempt then v_free_until
    when v_number is not null and v_approved_day > v_free_until
      then greatest(v_free_until, (v_approved_day + pg_catalog.make_interval(months => 1))::date)
    when v_number is not null then v_free_until
    else (greatest(v_approved_day, v_launch) + pg_catalog.make_interval(months => 1))::date
  end;

  v_prev_flag := pg_catalog.current_setting('kb.billing_write', true);
  perform pg_catalog.set_config('kb.billing_write', 'on', true);

  insert into public.merchant_subscriptions
    (merchant_id, approved_at, applied_at, founding_number, billing_anchor, months_paid, exempt)
  values
    (v_user, v_approved, v_applied, v_number, v_anchor, 0, v_exempt);

  insert into public.subscription_events (merchant_id, actor, action, details)
  values (v_user, auth.uid(), 'subscription_created', pg_catalog.jsonb_build_object(
    'application_id', p_application_id,
    'source', p_source,
    'applied_at', v_applied,
    'approved_at', v_approved,
    'approved_at_source', v_approved_source,
    'founding_eligible', v_eligible,
    'founding_number', v_number,
    'exempt', v_exempt,
    'exempt_reason', v_exempt_reason,
    'billing_anchor', v_anchor
  ));

  -- Put the flag back, so it doesn't stay on for the rest of the caller's transaction.
  perform pg_catalog.set_config('kb.billing_write', coalesce(nullif(v_prev_flag, ''), 'off'), true);

  return case
    when v_exempt then 'created_exempt'
    when v_number is not null then 'created_founding'
    else 'created'
  end;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. THE TRIGGERS. Fail closed: any error becomes "billing_setup_failed: ..."
-- and the approval statement rolls back (role promotion and notification
-- included).
-- ----------------------------------------------------------------------------
create or replace function public.billing_on_cook_application_approved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.billing_create_subscription(new.id, 'trigger');
  return null;
exception when others then
  raise exception 'billing_setup_failed: % (the approval was not saved; fix this and approve again)', sqlerrm
    using errcode = sqlstate;
end;
$$;

drop trigger if exists after_cook_application_subscription on public.cook_applications;
create trigger after_cook_application_subscription
  after update of status on public.cook_applications
  for each row
  when (old.status is distinct from 'approved' and new.status = 'approved')
  execute function public.billing_on_cook_application_approved();

drop trigger if exists after_cook_application_subscription_insert on public.cook_applications;
create trigger after_cook_application_subscription_insert
  after insert on public.cook_applications
  for each row
  when (new.status = 'approved')
  execute function public.billing_on_cook_application_approved();


-- ----------------------------------------------------------------------------
-- 4. admin_remove_unpaid_subscription: for the Boss delete flow.
-- Returns true when a row was removed, false when there was none.
-- ----------------------------------------------------------------------------
create or replace function public.admin_remove_unpaid_subscription(p_merchant_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.merchant_subscriptions;
  v_payments int;
  v_prev_flag text;
begin
  if not coalesce(public.user_has_role('admin'), false) then
    raise exception 'Only admins can remove a subscription.' using errcode = '42501';
  end if;
  if p_merchant_id is null then
    raise exception 'A merchant id is required.' using errcode = '22023';
  end if;
  if nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required.' using errcode = '22023';
  end if;

  -- Locking the row also waits for any payment being recorded right now.
  select * into v_sub
  from public.merchant_subscriptions s
  where s.merchant_id = p_merchant_id
  for update;
  if not found then
    return false;
  end if;

  select count(*)::int into v_payments
  from public.subscription_payments p
  where p.merchant_id = p_merchant_id;
  if v_payments > 0 then
    raise exception 'billing_has_payments: this merchant has % payment record(s), so the billing history must be kept and the merchant can''t be deleted.', v_payments
      using errcode = '23503';
  end if;

  v_prev_flag := pg_catalog.current_setting('kb.billing_write', true);
  perform pg_catalog.set_config('kb.billing_write', 'on', true);

  delete from public.merchant_subscriptions s where s.merchant_id = p_merchant_id;

  insert into public.subscription_events (merchant_id, actor, action, details)
  values (p_merchant_id, auth.uid(), 'subscription_deleted', pg_catalog.jsonb_build_object(
    'source', 'admin',
    'reason', pg_catalog.btrim(p_reason),
    'founding_number', v_sub.founding_number,
    'exempt', v_sub.exempt,
    'billing_anchor', v_sub.billing_anchor,
    'months_paid', v_sub.months_paid,
    'applied_at', v_sub.applied_at,
    'approved_at', v_sub.approved_at
  ));

  perform pg_catalog.set_config('kb.billing_write', coalesce(nullif(v_prev_flag, ''), 'off'), true);
  return true;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. FUNCTION PRIVILEGES. Supabase grants EXECUTE on new functions to anon
-- and authenticated by default. Only the delete function is for the browser
-- (Boss, signed in as an admin; the function checks the role itself).
-- ----------------------------------------------------------------------------
revoke all on function public.billing_create_subscription(uuid, text, boolean, text) from public, anon, authenticated;
revoke all on function public.billing_on_cook_application_approved() from public, anon, authenticated;
revoke all on function public.admin_remove_unpaid_subscription(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_remove_unpaid_subscription(uuid, text) to authenticated;

commit;

select 'STEP 2 INSTALLED' as result;


-- ============================================================================
-- CHECKS AFTERWARDS (read only). Paste one at a time into the SQL editor.
-- CHECKS-BEGIN
--
-- 1. The two triggers (last line should be: 2 rows, after_cook_application_subscription and after_cook_application_subscription_insert):
-- select t.tgname, pg_get_triggerdef(t.oid) as definition from pg_trigger t where t.tgrelid = 'public.cook_applications'::regclass and t.tgname like 'after_cook_application_subscription%' order by t.tgname;
--
-- 2. The three functions are SECURITY DEFINER with an empty search_path (last line should be: 3 rows, all prosecdef = true, proconfig = {search_path=""}):
-- select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('billing_create_subscription', 'billing_on_cook_application_approved', 'admin_remove_unpaid_subscription') order by p.proname;
--
-- 3. Browser roles can run only the delete function (last line should be: 1 row, admin_remove_unpaid_subscription / authenticated):
-- select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join pg_roles r where n.nspname = 'public' and p.proname in ('billing_create_subscription', 'billing_on_cook_application_approved', 'admin_remove_unpaid_subscription') and r.rolname in ('anon', 'authenticated') and has_function_privilege(r.oid, p.oid, 'EXECUTE') order by 1, 2;
--
-- 4. The event list has the two new actions (last line should be: true):
-- select pg_get_constraintdef(c.oid) like '%subscription_created%subscription_deleted%' as has_new_actions from pg_constraint c where c.conname = 'subscription_events_action_check';
--
-- 5. Approved cooks with NO subscription row (last line should be: 0 rows after the backfill; before it, KS Bakery):
-- select a.user_id, max(a.business_name) as business_name from public.cook_applications a where a.status = 'approved' and not exists (select 1 from public.merchant_subscriptions s where s.merchant_id = a.user_id) group by a.user_id order by 2;
--
-- 6. Founding numbers (last line should be: duplicates = 0):
-- select count(founding_number) as numbered, max(founding_number) as highest, count(founding_number) - count(distinct founding_number) as duplicates from public.merchant_subscriptions;
--
-- CHECKS-END
-- ============================================================================


-- ============================================================================
-- EMERGENCY: approvals are blocked by a billing error and can't wait for a
-- fix. Drops ONLY the two triggers: approvals work again, approved cooks then
-- show up in check 5, and re-running the step-2 file + the backfill puts
-- everything back. Remove the leading "-- " and run as one block.
-- Last line should be: TRIGGERS DROPPED
-- EMERGENCY-BEGIN
-- drop trigger if exists after_cook_application_subscription on public.cook_applications;
-- drop trigger if exists after_cook_application_subscription_insert on public.cook_applications;
-- select 'TRIGGERS DROPPED' as result;
-- EMERGENCY-END
-- ============================================================================


-- ============================================================================
-- UNDO (only before any subscription row exists: it refuses otherwise).
-- Removes the triggers and functions and puts back the step-1 event list.
-- Remove the leading "-- " and run as one block.
-- Last line should be: STEP 2 UNDONE
-- UNDO-BEGIN
-- begin;
-- do $$
-- begin
--   if exists (select 1 from public.merchant_subscriptions) or exists (select 1 from public.subscription_events where action in ('subscription_created', 'subscription_deleted')) then
--     raise exception 'UNDO REFUSED: subscription rows or step-2 events exist. Use the EMERGENCY block instead. Nothing was changed.';
--   end if;
-- end;
-- $$;
-- drop trigger if exists after_cook_application_subscription on public.cook_applications;
-- drop trigger if exists after_cook_application_subscription_insert on public.cook_applications;
-- drop function if exists public.billing_on_cook_application_approved();
-- drop function if exists public.billing_create_subscription(uuid, text, boolean, text);
-- drop function if exists public.admin_remove_unpaid_subscription(uuid, text);
-- alter table public.subscription_events drop constraint if exists subscription_events_action_check;
-- alter table public.subscription_events add constraint subscription_events_action_check check (action in ('founding_assigned', 'payment_recorded', 'payment_voided', 'extended', 'waived', 'exempted', 'restricted', 'restored', 'switch_changed', 'founding_changed'));
-- commit;
-- select 'STEP 2 UNDONE' as result;
-- UNDO-END
-- ============================================================================
