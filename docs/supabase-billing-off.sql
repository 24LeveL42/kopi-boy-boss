-- ============================================================================
-- KOPI BOY — Billing OFF for the pilot (one master switch)
--
-- Business decision (Nov 2026): the S$29.95 subscription and the founding
-- merchant offer are cancelled. Kopi Boy is free for merchants during the
-- pilot. Pilot Partner Terms v1:
--   1. Free to join and use: no subscription, registration fee or setup fee.
--   2. Customers pay the merchant directly; the merchant pays the rider the
--      delivery fee at collection.
--   3. Any future commission: 15% of food sales after discounts, delivery
--      fee excluded, never higher.
--   4. At least 30 days' written notice before any charge starts; nothing
--      charged before the notice ends, never for earlier orders.
--   5. The merchant can leave at any time with no penalty.
--
-- WHAT IT DOES (nothing is dropped, no row is deleted or changed except the
-- switches in the one billing_settings row):
--   1. billing_settings.billing_enabled boolean NOT NULL DEFAULT false:
--      the ONE switch every billing function, trigger and page reads.
--      Adding it with default false turns billing off immediately.
--   2. The three reminder/restriction switches are set to false if any is
--      on (logged as a 'switch_changed' event), and a CHECK makes sure they
--      can't be turned on while billing_enabled is false.
--   3. billing_on_cook_application_approved(): returns at once when billing
--      is off, so approvals and assisted claims make NO subscription row and
--      NO founding number, and billing can no longer block an approval.
--      Both trigger names stay as they are (after_cook_application_subscription
--      and after_cook_application_subscription_insert); the assisted
--      onboarding script checks the second one exists.
--   4. billing_create_subscription(): refuses with "billing_off: ..." when
--      billing is off (this also stops the step-2 backfill).
--   5. subscription_status(): returns 'off' when billing is off, so nothing
--      can ever read as due, grace or overdue.
--   6. Existing merchant_subscriptions, payments and events rows are KEPT.
--      admin_remove_unpaid_subscription (Boss "Delete test partner") is not
--      changed and still removes an old unpaid row.
--
-- AFTER THIS FILE: do NOT re-run docs/supabase-subscriptions.sql or
-- docs/supabase-subscriptions-step2.sql. They would put back the old
-- function versions, so both now refuse to run once billing_enabled exists.
-- Turning billing back on is a separate, audited step, built together with
-- the 30-day written notice (Pilot Partner Terms 4). There is no undo block
-- here on purpose.
--
-- RUN ORDER: after subscriptions step 1 and step 2. Run it on the live
-- database BEFORE the Boss code that reads billing_enabled is deployed.
-- Then run docs/supabase-billing-off-live-test.sql (always rolls back).
--
-- Safe to re-run: the column, CHECK and functions are created or replaced
-- with the same definitions, and billing ends up off every time.
-- FAILS SAFELY: one transaction. Section 0 checks the prerequisites before
-- anything changes, and section 7 checks the result and rolls everything
-- back if anything is wrong.
--
-- PASTE: everything from "begin;" down to the line
--   select 'BILLING OFF INSTALLED' as result;
-- as ONE block. Last line should be: BILLING OFF INSTALLED
-- ============================================================================


begin;

-- ----------------------------------------------------------------------------
-- 0. STOP IF A PREREQUISITE IS MISSING (nothing has changed yet). Also note
-- the row counts, so section 7 can prove no row was removed.
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := array[]::text[];
  v_has_row boolean;
  v_table text;
  v_trigger text;
  v_count bigint;
begin
  foreach v_table in array array['billing_settings', 'merchant_subscriptions', 'subscription_payments', 'subscription_events'] loop
    if to_regclass('public.' || v_table) is null then
      v_missing := pg_catalog.array_append(v_missing, 'public.' || v_table || ' (subscriptions step 1)');
    end if;
  end loop;
  if to_regprocedure('public.billing_create_subscription(uuid, text, boolean, text)') is null then
    v_missing := pg_catalog.array_append(v_missing, 'public.billing_create_subscription (subscriptions step 2)');
  end if;
  if to_regprocedure('public.billing_on_cook_application_approved()') is null then
    v_missing := pg_catalog.array_append(v_missing, 'public.billing_on_cook_application_approved() (subscriptions step 2)');
  end if;
  if to_regprocedure('public.sgt_date(timestamptz)') is null then
    v_missing := pg_catalog.array_append(v_missing, 'public.sgt_date(timestamptz) (subscriptions step 1)');
  end if;
  if to_regprocedure('auth.uid()') is null then
    v_missing := pg_catalog.array_append(v_missing, 'auth.uid()');
  end if;
  if to_regclass('public.cook_applications') is not null then
    foreach v_trigger in array array['after_cook_application_subscription', 'after_cook_application_subscription_insert'] loop
      if not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.cook_applications'::regclass and not t.tgisinternal and t.tgname = v_trigger) then
        v_missing := pg_catalog.array_append(v_missing, 'trigger ' || v_trigger || ' (subscriptions step 2)');
      end if;
    end loop;
  else
    v_missing := pg_catalog.array_append(v_missing, 'public.cook_applications');
  end if;
  -- Dynamic, so a missing table is reported here instead of failing to plan.
  if to_regclass('public.billing_settings') is not null then
    execute 'select exists (select 1 from public.billing_settings where id)' into v_has_row;
    if not v_has_row then
      v_missing := pg_catalog.array_append(v_missing, 'the billing_settings row (subscriptions step 1)');
    end if;
  end if;
  if array_length(v_missing, 1) > 0 then
    raise exception 'billing off: missing %. Nothing was changed.', array_to_string(v_missing, ', ');
  end if;

  foreach v_table in array array['merchant_subscriptions', 'subscription_payments', 'subscription_events'] loop
    execute format('select count(*) from public.%I', v_table) into v_count;
    perform pg_catalog.set_config('kb_off.before_' || v_table, v_count::text, true);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. THE MASTER SWITCH. DDL only; the billing lock fires on row writes and
-- truncate, so it doesn't block this.
-- ----------------------------------------------------------------------------
alter table public.billing_settings add column if not exists billing_enabled boolean not null default false;
comment on column public.billing_settings.billing_enabled is
  'Master billing switch. false = pilot: no subscription rows, no founding numbers, status ''off'', no reminders or restrictions. Turning it on is a separate audited step with 30 days'' written notice.';


-- ----------------------------------------------------------------------------
-- 2. EVERYTHING OFF. Only the switches in the one settings row change, and
-- only when one of them is on. The change is logged.
-- ----------------------------------------------------------------------------
do $$
declare
  v_before public.billing_settings;
begin
  select * into v_before from public.billing_settings s where s.id;
  if v_before.billing_enabled or v_before.reminders_inapp_enabled
     or v_before.reminders_email_enabled or v_before.restrictions_enabled then
    perform pg_catalog.set_config('kb.billing_write', 'on', true);
    update public.billing_settings s
    set billing_enabled = false,
        reminders_inapp_enabled = false,
        reminders_email_enabled = false,
        restrictions_enabled = false,
        updated_by = auth.uid()
    where s.id;
    insert into public.subscription_events (merchant_id, actor, action, details)
    values (null, auth.uid(), 'switch_changed', pg_catalog.jsonb_build_object(
      'source', 'supabase-billing-off.sql',
      'reason', 'pilot: billing off',
      'before', pg_catalog.jsonb_build_object(
        'billing_enabled', v_before.billing_enabled,
        'reminders_inapp_enabled', v_before.reminders_inapp_enabled,
        'reminders_email_enabled', v_before.reminders_email_enabled,
        'restrictions_enabled', v_before.restrictions_enabled),
      'after', pg_catalog.jsonb_build_object(
        'billing_enabled', false, 'reminders_inapp_enabled', false,
        'reminders_email_enabled', false, 'restrictions_enabled', false)
    ));
    perform pg_catalog.set_config('kb.billing_write', 'off', true);
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. OFF MEANS OFF: no reminder or restriction switch while billing is off.
-- ----------------------------------------------------------------------------
alter table public.billing_settings drop constraint if exists billing_settings_off_means_off;
alter table public.billing_settings add constraint billing_settings_off_means_off check (
  billing_enabled or not (reminders_inapp_enabled or reminders_email_enabled or restrictions_enabled)
);


-- ----------------------------------------------------------------------------
-- 4. billing_create_subscription: as in step 2, plus the switch check first.
-- A missing settings row counts as off.
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
  -- Billing off (the pilot): no subscription row, no founding number.
  if not coalesce((select s.billing_enabled from public.billing_settings s where s.id), false) then
    raise exception 'billing_off: billing is switched off for the pilot, so no subscription row is made'
      using errcode = '55000';
  end if;

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

  select min(a.created_at) into v_applied
  from public.cook_applications a
  where a.user_id = v_user;

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

  perform pg_catalog.set_config('kb.billing_write', coalesce(nullif(v_prev_flag, ''), 'off'), true);

  return case
    when v_exempt then 'created_exempt'
    when v_number is not null then 'created_founding'
    else 'created'
  end;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. THE TRIGGER FUNCTION: returns at once when billing is off, so an
-- approval or an assisted claim goes through with no billing work at all.
-- When billing is on it behaves exactly as in step 2 (fail closed).
-- The two triggers are NOT dropped or re-created: they already call this
-- function by name.
-- ----------------------------------------------------------------------------
create or replace function public.billing_on_cook_application_approved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce((select s.billing_enabled from public.billing_settings s where s.id), false) then
    return null;
  end if;
  perform public.billing_create_subscription(new.id, 'trigger');
  return null;
exception when others then
  raise exception 'billing_setup_failed: % (the approval was not saved; fix this and approve again)', sqlerrm
    using errcode = sqlstate;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. subscription_status: 'off' before anything else while billing is off.
-- Otherwise exactly as in step 1.
-- ----------------------------------------------------------------------------
create or replace function public.subscription_status(p_sub public.merchant_subscriptions, p_today date)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_grace int;
  v_due date;
begin
  if p_sub.merchant_id is null or p_today is null then
    return null;
  end if;
  if not coalesce((select s.billing_enabled from public.billing_settings s where s.id), false) then
    return 'off';
  end if;
  if p_sub.exempt then
    return 'exempt';
  end if;
  if p_sub.waived_until is not null and p_sub.waived_until > p_today then
    return 'waived';
  end if;

  select s.grace_days into v_grace from public.billing_settings s where s.id;
  v_grace := coalesce(v_grace, 3);
  v_due := (p_sub.billing_anchor + pg_catalog.make_interval(months => p_sub.months_paid))::date;

  if p_today < v_due - 7 then
    return case when p_sub.months_paid = 0 then 'free' else 'active' end;
  elsif p_today < v_due then
    return 'due_soon';
  elsif p_today = v_due then
    return 'due_today';
  elsif p_today <= v_due + v_grace then
    return 'grace';
  end if;
  return 'overdue';
end;
$$;

-- Same privileges as before: no browser role runs any of the three.
revoke all on function public.billing_create_subscription(uuid, text, boolean, text) from public, anon, authenticated;
revoke all on function public.billing_on_cook_application_approved() from public, anon, authenticated;
revoke all on function public.subscription_status(public.merchant_subscriptions, date) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. VERIFY, or roll everything back.
-- ----------------------------------------------------------------------------
do $$
declare
  v_s public.billing_settings;
  v_msg text;
  v_n bigint;
  v_table text;
  v_trigger text;
begin
  -- The switch: NOT NULL, default false, and off.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'billing_settings' and column_name = 'billing_enabled'
                   and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false') then
    raise exception 'billing off check failed: billing_enabled is not boolean NOT NULL DEFAULT false. Nothing was changed.';
  end if;
  select * into v_s from public.billing_settings s where s.id;
  if v_s.billing_enabled or v_s.reminders_inapp_enabled or v_s.reminders_email_enabled or v_s.restrictions_enabled then
    raise exception 'billing off check failed: a switch is still on. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_constraint c
                 where c.conrelid = 'public.billing_settings'::regclass and c.conname = 'billing_settings_off_means_off') then
    raise exception 'billing off check failed: the off-means-off CHECK is missing. Nothing was changed.';
  end if;

  -- Both triggers still there, enabled, calling the (new) function.
  foreach v_trigger in array array['after_cook_application_subscription', 'after_cook_application_subscription_insert'] loop
    if not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                   where t.tgrelid = 'public.cook_applications'::regclass and t.tgname = v_trigger
                     and t.tgenabled <> 'D' and p.proname = 'billing_on_cook_application_approved') then
      raise exception 'billing off check failed: trigger % is missing or disabled. Nothing was changed.', v_trigger;
    end if;
  end loop;

  -- The three functions are the new versions, with an empty search_path.
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('billing_create_subscription', 'billing_on_cook_application_approved', 'subscription_status')
    and p.prosrc like '%billing_enabled%'
    and 'search_path=""' = any (p.proconfig);
  if v_n <> 3 then
    raise exception 'billing off check failed: % of 3 functions read billing_enabled with search_path = ''''. Nothing was changed.', v_n;
  end if;
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join pg_roles r
  where n.nspname = 'public'
    and p.proname in ('billing_create_subscription', 'billing_on_cook_application_approved', 'subscription_status')
    and r.rolname in ('anon', 'authenticated') and has_function_privilege(r.oid, p.oid, 'EXECUTE');
  if v_n <> 0 then
    raise exception 'billing off check failed: a browser role can run a billing function. Nothing was changed.';
  end if;

  -- It refuses to make a row (inner block: its own rollback point).
  v_msg := null;
  begin
    perform public.billing_create_subscription(gen_random_uuid(), 'trigger');
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'billing_off:%' then
    raise exception 'billing off check failed: billing_create_subscription did not refuse (%). Nothing was changed.', coalesce(v_msg, 'no error');
  end if;

  -- Every existing row now reads 'off'.
  select count(*) into v_n from public.merchant_subscriptions s
  where public.subscription_status(s, public.sgt_today()) is distinct from 'off';
  if v_n <> 0 then
    raise exception 'billing off check failed: % subscription row(s) do not read ''off''. Nothing was changed.', v_n;
  end if;

  -- No row removed (events may only grow, by the switch_changed entry).
  foreach v_table in array array['merchant_subscriptions', 'subscription_payments', 'subscription_events'] loop
    execute format('select count(*) from public.%I', v_table) into v_n;
    if (v_table = 'subscription_events' and v_n < current_setting('kb_off.before_' || v_table)::bigint)
       or (v_table <> 'subscription_events' and v_n <> current_setting('kb_off.before_' || v_table)::bigint) then
      raise exception 'billing off check failed: % row count changed (% before, % now). Nothing was changed.',
        v_table, current_setting('kb_off.before_' || v_table), v_n;
    end if;
  end loop;

  if coalesce(pg_catalog.current_setting('kb.billing_write', true), '') = 'on' then
    raise exception 'billing off check failed: kb.billing_write was left on. Nothing was changed.';
  end if;
end;
$$;

commit;

select 'BILLING OFF INSTALLED' as result;


-- ============================================================================
-- CHECKS AFTERWARDS (read only). Paste one at a time into the SQL editor.
-- CHECKS-BEGIN
--
-- 1. Every switch is off (last line should be: false, false, false, false):
-- select billing_enabled, reminders_inapp_enabled, reminders_email_enabled, restrictions_enabled from public.billing_settings;
--
-- 2. Both triggers are still there (last line should be: 2 rows, after_cook_application_subscription and after_cook_application_subscription_insert):
-- select t.tgname from pg_trigger t where t.tgrelid = 'public.cook_applications'::regclass and t.tgname like 'after_cook_application_subscription%' order by t.tgname;
--
-- 3. Existing rows are kept and all read 'off' (last line should be: not_off = 0):
-- select count(*) as kept, count(*) filter (where public.subscription_status(s, public.sgt_today()) is distinct from 'off') as not_off from public.merchant_subscriptions s;
--
-- CHECKS-END
-- ============================================================================
