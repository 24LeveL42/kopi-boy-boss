-- ============================================================================
-- KOPI BOY — Merchant subscriptions, step 1: the SQL foundation
--
-- Plan: subscription-plan.txt sections 2 and 7 (approved). This file creates
-- the billing tables, two date helpers, the status function, RLS, minimal
-- grants and the kb.billing_write lock. It changes NOTHING that exists:
-- no kitchens, profiles or cook_applications change, no trigger on any
-- existing table, and every switch is OFF.
--
-- NOT in this file (later steps): the founding merchants trigger on
-- cook_applications, the admin_* and get_my_subscription() functions, the
-- daily job, the kitchens.is_blocked rewrite and the email outbox functions.
--
-- Owner decisions built in:
--   * Price S$29.95 (price_cents 2995) and the payee KOPIE BOY,
--     UEN 53535194A, live in billing_settings: apps read them, never
--     hard-code them. No GST wording anywhere.
--   * Founding merchants: NO cap. Every merchant whose application was
--     submitted before launch_date (22 Dec 2026, Singapore date) is a
--     founding merchant, however many there are. First due date 22 Mar 2027
--     (founding_free_until), grace 23–25 Mar (grace_days 3), overdue from
--     26 Mar.
--   * A late payment counts from the old due date: due dates are always
--     billing_anchor + months_paid months, so paying late never moves the
--     anchor, and one payment may cover several months (1–12).
--   * A merchant with payment records can't be deleted: payments reference
--     merchant_subscriptions ON DELETE RESTRICT, which references profiles
--     ON DELETE RESTRICT. A merchant with no payments can be deleted once
--     its subscription row is removed first (the delete flow, later step).
--   * Test accounts are excluded from the founding merchants via exempt = true
--     (set by the founding backfill, later step).
--
-- WHO CAN DO WHAT
--   * Merchants (authenticated): SELECT their own subscription row and their
--     own payments. Nothing else, and no writes anywhere.
--   * Admins: SELECT every row of every billing table. No direct writes
--     either: changes will only go through SECURITY DEFINER admin functions
--     (later step), which check user_has_role('admin').
--   * anon: nothing at all.
--   * The kb.billing_write lock: every insert, update, delete or truncate
--     on a billing table raises "billing_write_locked" unless the
--     transaction set kb.billing_write = 'on' (set_config(..., true), i.e.
--     transaction-local). Only the future billing functions set it. This
--     is defence in depth on top of the grants: browser roles have no
--     write grant at all, so they are refused before the trigger is ever
--     reached, even if they set the flag themselves.
--   * Append-only: subscription_events rows never change or disappear;
--     subscription_payments are never deleted, and only their void fields
--     can be set (once). This holds even with the flag on.
--
-- RUN ORDER: after the Partner schema (profiles, user_has_role). Safe to
-- re-run: tables, indexes and the settings row are created only when
-- missing; functions, triggers and policies are replaced with the same
-- definitions; switches and data already there are never reset.
--
-- FAILS SAFELY: one transaction. Step 0b checks the prerequisites first and
-- stops with "subscriptions: missing ..." before anything changes.
-- ============================================================================


begin;

-- ----------------------------------------------------------------------------
-- 0b. STOP IF A PREREQUISITE IS MISSING (nothing has changed yet).
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := array[]::text[];
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'id') then
    v_missing := pg_catalog.array_append(v_missing, 'public.profiles.id');
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'role') then
    v_missing := pg_catalog.array_append(v_missing, 'public.profiles.role');
  end if;
  if to_regprocedure('public.user_has_role(text)') is null then
    v_missing := pg_catalog.array_append(v_missing, 'public.user_has_role(text)');
  end if;
  if to_regprocedure('auth.uid()') is null then
    v_missing := pg_catalog.array_append(v_missing, 'auth.uid()');
  end if;
  if array_length(v_missing, 1) > 0 then
    raise exception 'subscriptions: missing %. Nothing was changed.', array_to_string(v_missing, ', ');
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. DATE HELPERS
-- sgt_today() is the only place "today" comes from. Every other function
-- takes the date as a parameter (a fake clock for tests and the dry run).
-- sgt_date() turns a moment into its Singapore calendar date: 15:59:59 UTC is
-- still the same SGT day, 16:00 UTC is the next one.
-- ----------------------------------------------------------------------------
create or replace function public.sgt_date(p_at timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select (p_at at time zone 'Asia/Singapore')::date;
$$;

create or replace function public.sgt_today()
returns date
language sql
stable
set search_path = ''
as $$
  select public.sgt_date(pg_catalog.now());
$$;


-- ----------------------------------------------------------------------------
-- 2. THE LOCK AND THE updated_at TOUCH (trigger functions)
-- ----------------------------------------------------------------------------
create or replace function public.billing_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Append-only rules hold even with the flag on.
  if tg_table_name = 'subscription_events' and tg_op <> 'INSERT' then
    raise exception 'billing_append_only: subscription_events rows are never changed or deleted'
      using errcode = '42501';
  end if;
  if tg_table_name = 'subscription_payments' then
    if tg_op in ('DELETE', 'TRUNCATE') then
      raise exception 'billing_append_only: payments are voided, never deleted'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' then
      if old.voided_at is not null then
        raise exception 'billing_append_only: a voided payment never changes'
          using errcode = '42501';
      end if;
      if (pg_catalog.to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason'])
         is distinct from (pg_catalog.to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
        raise exception 'billing_append_only: only the void fields of a payment can be set'
          using errcode = '42501';
      end if;
    end if;
  end if;

  if coalesce(pg_catalog.current_setting('kb.billing_write', true), '') <> 'on' then
    raise exception 'billing_write_locked: % on % is only allowed through the billing functions', tg_op, tg_table_name
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;  -- NULL for the statement-level TRUNCATE trigger, which is fine
end;
$$;

create or replace function public.billing_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. billing_settings (exactly one row). Switches OFF by default.
-- ----------------------------------------------------------------------------
create table if not exists public.billing_settings (
  id boolean primary key default true check (id),
  reminders_inapp_enabled boolean not null default false,
  reminders_email_enabled boolean not null default false,
  restrictions_enabled boolean not null default false,
  launch_date date not null default '2026-12-22',
  founding_free_until date not null default '2027-03-22',  -- = founding first due date
  grace_days int not null default 3 check (grace_days between 0 and 14),
  price_cents int not null default 2995 check (price_cents > 0),
  payee_name text not null default 'KOPIE BOY' check (pg_catalog.btrim(payee_name) <> ''),
  payee_uen text not null default '53535194A' check (pg_catalog.btrim(payee_uen) <> ''),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (founding_free_until >= launch_date)
);


-- ----------------------------------------------------------------------------
-- 4. merchant_subscriptions (one row per approved cook)
-- due_date = billing_anchor + months_paid months, always from the anchor, so
-- 31 Jan -> 28 Feb -> 31 Mar (and 29 Feb in 2028) with no drift.
-- ----------------------------------------------------------------------------
create table if not exists public.merchant_subscriptions (
  merchant_id uuid primary key references public.profiles(id) on delete restrict,
  approved_at timestamptz not null,
  -- When the merchant applied; the founding rule compares
  -- sgt_date(applied_at) < launch_date. Nullable for now (the backfill and
  -- the trigger fill it in a later step).
  applied_at timestamptz,
  founding_number int check (founding_number >= 1),
  is_founding boolean generated always as (founding_number is not null) stored,
  billing_anchor date not null,
  months_paid int not null default 0 check (months_paid >= 0),
  due_date date generated always as ((billing_anchor + make_interval(months => months_paid))::date) stored,
  waived_until date,
  exempt boolean not null default false,
  billing_restricted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists merchant_subscriptions_founding_number_key
  on public.merchant_subscriptions (founding_number)
  where founding_number is not null;

comment on column public.merchant_subscriptions.applied_at is
  'When the merchant applied; the founding rule compares sgt_date(applied_at) < launch_date';

-- FOUNDING MERCHANTS: the trigger rules (later step, not in this file)
--   * Eligibility: sgt_date(application created_at) < launch_date. No cap:
--     every application submitted before launch qualifies.
--   * The founding number is assigned at approval (next number = max + 1),
--     under pg_advisory_xact_lock so two simultaneous approvals can never
--     get the same number. The unique index above is the backstop.
--   * Exempt (test) accounts never get a founding number.


-- ----------------------------------------------------------------------------
-- 5. subscription_payments (append-only; voided, never deleted)
-- ----------------------------------------------------------------------------
create table if not exists public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchant_subscriptions(merchant_id) on delete restrict,
  amount_cents int not null check (amount_cents > 0),
  paid_on date not null,
  method text not null default 'paynow' check (method in ('paynow', 'other')),
  reference text not null check (pg_catalog.btrim(reference) <> ''),
  months int not null default 1 check (months between 1 and 12),
  covers_from date,
  covers_to date,
  recorded_by uuid,
  recorded_at timestamptz not null default now(),
  note text,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  check (covers_to is null or covers_from is null or covers_to >= covers_from),
  check ((voided_at is null and voided_by is null and void_reason is null)
         or (voided_at is not null and pg_catalog.btrim(coalesce(void_reason, '')) <> ''))
);

-- A double click or a pasted duplicate reference can't extend twice.
-- Case and surrounding spaces don't make a reference "different".
create unique index if not exists subscription_payments_active_reference_key
  on public.subscription_payments (pg_catalog.lower(pg_catalog.btrim(reference)))
  where voided_at is null;

create index if not exists subscription_payments_merchant_idx
  on public.subscription_payments (merchant_id, paid_on desc);


-- ----------------------------------------------------------------------------
-- 6. subscription_reminders (the send log AND the email outbox)
-- merchant_id has no foreign key on purpose: it's a log, and a merchant with
-- no payments must stay deletable without rewriting history.
-- ----------------------------------------------------------------------------
create table if not exists public.subscription_reminders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  due_date date not null,
  kind text not null check (kind in ('due_in_7', 'due_in_1', 'due_today', 'grace_last_day', 'restricted', 'restored')),
  channel text not null check (channel in ('inapp', 'email')),
  status text not null check (status in ('dry_run', 'queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0 check (attempts >= 0),
  last_error text,
  provider_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- Each reminder for each due date at most once per channel, however often the
-- job runs. Dry-run rows don't count.
create unique index if not exists subscription_reminders_once_key
  on public.subscription_reminders (merchant_id, due_date, kind, channel)
  where status <> 'dry_run';

create index if not exists subscription_reminders_status_idx
  on public.subscription_reminders (status, created_at);


-- ----------------------------------------------------------------------------
-- 7. subscription_events (audit trail; append-only). actor NULL = system job.
-- ----------------------------------------------------------------------------
create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid,
  actor uuid,
  action text not null check (action in (
    'founding_assigned', 'payment_recorded', 'payment_voided', 'extended', 'waived',
    'exempted', 'restricted', 'restored', 'switch_changed', 'founding_changed'
  )),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists subscription_events_merchant_idx
  on public.subscription_events (merchant_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 8. billing_job_runs (one row per daily run; Boss "last run" panel)
-- ----------------------------------------------------------------------------
create table if not exists public.billing_job_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  as_of date not null,
  mode text not null check (mode in ('live', 'dry_run')),
  counts jsonb not null default '{}'::jsonb,
  error text
);

create index if not exists billing_job_runs_ran_at_idx
  on public.billing_job_runs (ran_at desc);


-- ----------------------------------------------------------------------------
-- 9. TRIGGERS: the lock on all six tables, updated_at on two.
-- Same-timing triggers fire in name order: billing_write_lock runs before
-- touch_updated_at, so a refused write never gets that far.
-- ----------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'billing_settings', 'merchant_subscriptions', 'subscription_payments',
    'subscription_reminders', 'subscription_events', 'billing_job_runs'
  ] loop
    execute format('drop trigger if exists billing_write_lock on public.%I', v_table);
    execute format(
      'create trigger billing_write_lock before insert or update or delete on public.%I
         for each row execute function public.billing_write_guard()', v_table);
    execute format('drop trigger if exists billing_write_lock_truncate on public.%I', v_table);
    execute format(
      'create trigger billing_write_lock_truncate before truncate on public.%I
         for each statement execute function public.billing_write_guard()', v_table);
  end loop;
end;
$$;

drop trigger if exists touch_updated_at on public.billing_settings;
create trigger touch_updated_at
  before update on public.billing_settings
  for each row execute function public.billing_touch_updated_at();

drop trigger if exists touch_updated_at on public.merchant_subscriptions;
create trigger touch_updated_at
  before update on public.merchant_subscriptions
  for each row execute function public.billing_touch_updated_at();


-- ----------------------------------------------------------------------------
-- 10. THE SETTINGS ROW. Created once; a re-run never resets a switch.
-- ----------------------------------------------------------------------------
select pg_catalog.set_config('kb.billing_write', 'on', true);
insert into public.billing_settings (id) values (true) on conflict (id) do nothing;
select pg_catalog.set_config('kb.billing_write', 'off', true);


-- ----------------------------------------------------------------------------
-- 11. subscription_status(row, p_today): the ONE place the status is derived.
--   exempt     exempt = true
--   waived     waived_until > p_today
--   free       nothing paid yet and more than 7 days before the due date
--   active     paid, and more than 7 days before the due date
--   due_soon   due_date - 7 <= p_today < due_date
--   due_today  p_today = due_date
--   grace      due_date < p_today <= due_date + grace_days
--   overdue    p_today > due_date + grace_days (restrictable)
-- The "restricted" flag is separate: billing_restricted_at is not null.
-- Worked example, due 22 Mar 2027, grace 3: 21 Mar due_soon, 22 Mar
-- due_today, 23–25 Mar grace (25 Mar is the last grace day), 26 Mar overdue.
-- Runs as the caller (SECURITY INVOKER): only the owner and the future
-- SECURITY DEFINER billing functions call it, so no role is granted EXECUTE.
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


-- ----------------------------------------------------------------------------
-- 12. FUNCTION PRIVILEGES. Supabase grants EXECUTE on new functions to anon
-- and authenticated by default; nothing here is for the browser.
-- ----------------------------------------------------------------------------
revoke all on function public.sgt_date(timestamptz) from public, anon, authenticated;
revoke all on function public.sgt_today() from public, anon, authenticated;
revoke all on function public.billing_write_guard() from public, anon, authenticated;
revoke all on function public.billing_touch_updated_at() from public, anon, authenticated;
revoke all on function public.subscription_status(public.merchant_subscriptions, date) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 13. TABLE PRIVILEGES AND RLS. Start from zero (Supabase auto-grants every
-- new table to anon and authenticated), then give back SELECT to signed-in
-- users only; RLS decides which rows.
-- ----------------------------------------------------------------------------
revoke all on public.billing_settings from public, anon, authenticated;
revoke all on public.merchant_subscriptions from public, anon, authenticated;
revoke all on public.subscription_payments from public, anon, authenticated;
revoke all on public.subscription_reminders from public, anon, authenticated;
revoke all on public.subscription_events from public, anon, authenticated;
revoke all on public.billing_job_runs from public, anon, authenticated;

grant select on public.billing_settings to authenticated;
grant select on public.merchant_subscriptions to authenticated;
grant select on public.subscription_payments to authenticated;
grant select on public.subscription_reminders to authenticated;
grant select on public.subscription_events to authenticated;
grant select on public.billing_job_runs to authenticated;

alter table public.billing_settings enable row level security;
alter table public.merchant_subscriptions enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.subscription_reminders enable row level security;
alter table public.subscription_events enable row level security;
alter table public.billing_job_runs enable row level security;

-- Merchants: their own subscription and their own payments.
drop policy if exists "Merchants read their own subscription" on public.merchant_subscriptions;
create policy "Merchants read their own subscription"
  on public.merchant_subscriptions for select to authenticated
  using (auth.uid() = merchant_id);

drop policy if exists "Merchants read their own payments" on public.subscription_payments;
create policy "Merchants read their own payments"
  on public.subscription_payments for select to authenticated
  using (auth.uid() = merchant_id);

-- Admins: every row of every billing table (read only).
drop policy if exists "Admins read billing settings" on public.billing_settings;
create policy "Admins read billing settings"
  on public.billing_settings for select to authenticated
  using (public.user_has_role('admin'));

drop policy if exists "Admins read every subscription" on public.merchant_subscriptions;
create policy "Admins read every subscription"
  on public.merchant_subscriptions for select to authenticated
  using (public.user_has_role('admin'));

drop policy if exists "Admins read every payment" on public.subscription_payments;
create policy "Admins read every payment"
  on public.subscription_payments for select to authenticated
  using (public.user_has_role('admin'));

drop policy if exists "Admins read every reminder" on public.subscription_reminders;
create policy "Admins read every reminder"
  on public.subscription_reminders for select to authenticated
  using (public.user_has_role('admin'));

drop policy if exists "Admins read every subscription event" on public.subscription_events;
create policy "Admins read every subscription event"
  on public.subscription_events for select to authenticated
  using (public.user_has_role('admin'));

drop policy if exists "Admins read billing job runs" on public.billing_job_runs;
create policy "Admins read billing job runs"
  on public.billing_job_runs for select to authenticated
  using (public.user_has_role('admin'));

commit;


-- ============================================================================
-- CHECKS AFTERWARDS (read only). Paste one at a time into the SQL editor.
--
-- 1. All three switches are off, price and payee as agreed (expect false,
--    false, false, 2995, KOPIE BOY, 53535194A, 3, 2027-03-22):
-- select reminders_inapp_enabled, reminders_email_enabled, restrictions_enabled, price_cents, payee_name, payee_uen, grace_days, founding_free_until from public.billing_settings;
--
-- 2. Browser roles: SELECT for authenticated on the six tables, nothing else, nothing for anon (expect 6 rows, all authenticated / SELECT):
-- select table_name, grantee, privilege_type from information_schema.table_privileges where table_schema = 'public' and table_name in ('billing_settings', 'merchant_subscriptions', 'subscription_payments', 'subscription_reminders', 'subscription_events', 'billing_job_runs') and grantee in ('anon', 'authenticated') order by table_name, grantee, privilege_type;
--
-- 3. RLS is on for all six (expect 6 rows, all true):
-- select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('billing_settings', 'merchant_subscriptions', 'subscription_payments', 'subscription_reminders', 'subscription_events', 'billing_job_runs') order by c.relname;
--
-- 4. No browser role can run any of the new functions (expect no rows):
-- select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('sgt_date', 'sgt_today', 'billing_write_guard', 'billing_touch_updated_at', 'subscription_status') and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
--
-- 5. The lock is on all six tables (expect 6 rows):
-- select event_object_table from information_schema.triggers where trigger_schema = 'public' and trigger_name = 'billing_write_lock' and event_manipulation = 'INSERT' order by event_object_table;
--
-- 6. Today in Singapore:
-- select public.sgt_today();
-- ============================================================================


-- ============================================================================
-- UNDO (only before any real billing data exists: it deletes the tables and
-- everything in them). Remove the leading "-- " and run as one block.
-- The status function depends on the merchant_subscriptions row type, so it
-- goes first.
-- UNDO-BEGIN
-- begin;
-- drop function if exists public.subscription_status(public.merchant_subscriptions, date);
-- drop table if exists public.subscription_payments, public.subscription_reminders, public.subscription_events, public.billing_job_runs, public.merchant_subscriptions, public.billing_settings;
-- drop function if exists public.billing_write_guard(), public.billing_touch_updated_at(), public.sgt_today(), public.sgt_date(timestamptz);
-- commit;
-- UNDO-END
-- ============================================================================


-- ============================================================================
-- LIVE DATABASE: ALTERS FOR TABLES ALREADY CREATED BY AN EARLIER VERSION OF
-- THIS FILE. "create table if not exists" does not change an existing table,
-- so run this once on a database where the tables already exist. Each
-- statement is safe to repeat. The billing lock trigger fires on row writes
-- and truncate only, so these ALTERs are not blocked by it.
-- Remove the leading "-- " and run as one block.
-- ALTER-BEGIN
-- begin;
-- alter table public.billing_settings drop column if exists founding_limit;
-- alter table public.merchant_subscriptions drop constraint if exists merchant_subscriptions_founding_number_check;
-- alter table public.merchant_subscriptions add constraint merchant_subscriptions_founding_number_check check (founding_number >= 1);
-- alter table public.merchant_subscriptions add column if not exists applied_at timestamptz;
-- comment on column public.merchant_subscriptions.applied_at is 'When the merchant applied; the founding rule compares sgt_date(applied_at) < launch_date';
-- commit;
-- ALTER-END
-- ============================================================================
