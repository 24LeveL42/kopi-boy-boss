-- ============================================================================
-- DO NOT RUN during the pilot. Billing is off (docs/supabase-billing-off.sql)
-- and billing_create_subscription refuses with billing_off, so the apply
-- block stops at the first row. Kept as history.
--
-- KOPI BOY — Merchant subscriptions, step 2 BACKFILL: a subscription row for
-- every cook approved BEFORE the step-2 trigger existed.
--
-- Run AFTER docs/supabase-subscriptions-step2.sql (so no approval in between
-- can be missed). Re-runnable: a cook who already has a row is skipped, and a
-- second run creates nothing.
--
-- It uses public.billing_create_subscription, the same function as the
-- trigger, so a backfilled row is built exactly like a new one (lock,
-- numbering, anchor, event with source 'backfill'):
--   * applied_at  = the user's EARLIEST cook application created_at (Q-C)
--   * approved_at = reviewed_at of the latest approved application; if that
--     is empty, now() (Q-E; the preview shows it first)
--   * exempt      = listed in v_exempt_emails, or profile role 'admin';
--     exempt rows never get a founding number, anchor = founding_free_until
--   * everyone else: founding number in order of reviewed_at, created_at, id
--     (only if they applied before launch), anchor as in the step-2 file.
--
-- Today the expected result is ONE row: KS Bakery, a test account, exempt,
-- no number. The test account email is NOT stored in this file: paste it
-- where it says <paste test account email here>, in BLOCK 1 and BLOCK 2.
--
-- Three blocks. Paste them ONE AT A TIME, each from "BLOCK n" to "END BLOCK n".
-- ============================================================================


-- ============================================================================
-- BLOCK 1 — PREVIEW (read only, changes nothing).
-- Replace the placeholder email first.
-- Last line should be: one row per approved cook still without a
-- subscription. Today: 1 row, KS Bakery, exempt = true, exempt_reason
-- 'test account (backfill list)', proposed_founding_number empty.
-- Check approved_at_note: "reviewed_at" is normal; "now() (reviewed_at is
-- empty)" means the backfill will use the time it runs (Q-E).
-- ============================================================================
with exempt_emails(email) as (
  values ('<paste test account email here>')
),
settings as (
  select s.launch_date, s.founding_free_until from public.billing_settings s where s.id
),
chosen as (
  select distinct on (a.user_id)
    a.user_id, a.id as application_id, a.business_name, a.reviewed_at, a.created_at
  from public.cook_applications a
  where a.status = 'approved'
    and not exists (select 1 from public.merchant_subscriptions s where s.merchant_id = a.user_id)
  order by a.user_id, a.reviewed_at desc nulls last, a.created_at desc, a.id desc
),
facts as (
  select
    c.*,
    u.email,
    p.role,
    (select min(a2.created_at) from public.cook_applications a2 where a2.user_id = c.user_id) as applied_at,
    coalesce(c.reviewed_at, now()) as approved_at,
    coalesce(lower(u.email) in (select lower(btrim(e.email)) from exempt_emails e), false) as listed_exempt
  from chosen c
  left join auth.users u on u.id = c.user_id
  left join public.profiles p on p.id = c.user_id
),
proposed as (
  select
    f.*,
    (f.listed_exempt or f.role is not distinct from 'admin') as exempt,
    public.sgt_date(f.applied_at) < st.launch_date as founding_eligible,
    st.launch_date,
    st.founding_free_until
  from facts f cross join settings st
),
numbered as (
  select
    pr.*,
    case when pr.founding_eligible and not pr.exempt then
      (select coalesce(max(s.founding_number), 0) from public.merchant_subscriptions s)
      + row_number() over (partition by (pr.founding_eligible and not pr.exempt)
                           order by pr.reviewed_at nulls last, pr.created_at, pr.application_id)
    end as proposed_founding_number
  from proposed pr
)
select
  n.user_id,
  n.email,
  n.business_name,
  n.role,
  n.application_id,
  n.applied_at,
  n.approved_at,
  case when n.reviewed_at is null then 'now() (reviewed_at is empty)' else 'reviewed_at' end as approved_at_note,
  n.founding_eligible,
  n.exempt,
  case when n.listed_exempt then 'test account (backfill list)'
       when n.role is not distinct from 'admin' then 'admin account' end as exempt_reason,
  n.proposed_founding_number,
  case
    when n.exempt then n.founding_free_until
    when n.proposed_founding_number is not null and public.sgt_date(n.approved_at) > n.founding_free_until
      then greatest(n.founding_free_until, (public.sgt_date(n.approved_at) + make_interval(months => 1))::date)
    when n.proposed_founding_number is not null then n.founding_free_until
    else (greatest(public.sgt_date(n.approved_at), n.launch_date) + make_interval(months => 1))::date
  end as proposed_billing_anchor,
  case when n.role is null then 'NO PROFILE: the backfill will stop here' end as problem
from numbered n
order by n.reviewed_at nulls last, n.created_at, n.application_id;
-- END BLOCK 1


-- ============================================================================
-- BLOCK 2 — APPLY. Safe by default: with v_commit = false it does all the
-- work, then rolls it back and tells you what it would have done.
--   1. Replace the placeholder email (or use array[]::text[] for none).
--   2. Set v_expected_not_exempt to the number of rows in the preview with
--      exempt = false (today 0). If the real number differs, the block
--      refuses, so nobody starts being billed or gets a number by surprise.
--   3. Run with v_commit = false. Last line should be:
--        ERROR: TEST OK, rolled back: would create 1 subscription row(s): 0 founding, 0 not founding, 1 exempt. ...
--   4. Set v_commit = true and run again. Last line should be:
--        BACKFILL DONE: 1 backfilled row(s) in total, 0 approved cook(s) without a subscription
--      (A second run later says the same totals: it creates nothing new.)
-- ============================================================================
do $$
declare
  v_commit boolean := false;                                          -- true = keep the result
  v_exempt_emails text[] := array['<paste test account email here>']; -- test accounts: exempt, no number
  v_expected_not_exempt int := 0;                                     -- preview rows with exempt = false

  v_email text;
  v_missing text[] := array[]::text[];
  v_row record;
  v_result text;
  v_founding int := 0;
  v_regular int := 0;
  v_exempt int := 0;
  v_existing int := 0;
begin
  foreach v_email in array v_exempt_emails loop
    if v_email is null or pg_catalog.btrim(v_email) = '' or v_email like '<%' then
      raise exception 'BACKFILL REFUSED: replace the placeholder in v_exempt_emails with the test account email (or use array[]::text[] if there is none). Nothing was changed.';
    end if;
    if not exists (select 1 from auth.users u where lower(u.email) = lower(pg_catalog.btrim(v_email))) then
      v_missing := pg_catalog.array_append(v_missing, v_email);
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception 'BACKFILL REFUSED: no account has the email(s) %. Check for typos. Nothing was changed.', array_to_string(v_missing, ', ');
  end if;

  for v_row in
    select
      c.application_id,
      coalesce(lower(u.email) in (select lower(pg_catalog.btrim(e)) from unnest(v_exempt_emails) e), false) as listed_exempt
    from (
      select distinct on (a.user_id) a.user_id, a.id as application_id, a.reviewed_at, a.created_at
      from public.cook_applications a
      where a.status = 'approved'
        and not exists (select 1 from public.merchant_subscriptions s where s.merchant_id = a.user_id)
      order by a.user_id, a.reviewed_at desc nulls last, a.created_at desc, a.id desc
    ) c
    left join auth.users u on u.id = c.user_id
    order by c.reviewed_at nulls last, c.created_at, c.application_id
  loop
    v_result := public.billing_create_subscription(
      v_row.application_id,
      'backfill',
      v_row.listed_exempt,
      case when v_row.listed_exempt then 'test account (backfill list)' end
    );
    case v_result
      when 'created_founding' then v_founding := v_founding + 1;
      when 'created' then v_regular := v_regular + 1;
      when 'created_exempt' then v_exempt := v_exempt + 1;
      else v_existing := v_existing + 1;  -- approved by the trigger in the meantime
    end case;
  end loop;

  if v_founding + v_regular <> v_expected_not_exempt then
    raise exception 'BACKFILL REFUSED: % approved cook(s) without a subscription are NOT exempt (% founding, % not founding), but v_expected_not_exempt is %. Check the preview (block 1), then set v_expected_not_exempt to match. Nothing was changed.',
      v_founding + v_regular, v_founding, v_regular, v_expected_not_exempt;
  end if;

  if not v_commit then
    raise exception 'TEST OK, rolled back: would create % subscription row(s): % founding, % not founding, % exempt. Set v_commit := true to apply. Nothing was changed.',
      v_founding + v_regular + v_exempt, v_founding, v_regular, v_exempt;
  end if;
end;
$$;

select
  'BACKFILL DONE: '
  || (select count(*) from public.subscription_events e where e.action = 'subscription_created' and e.details ->> 'source' = 'backfill')
  || ' backfilled row(s) in total, '
  || (select count(distinct a.user_id) from public.cook_applications a
      where a.status = 'approved'
        and not exists (select 1 from public.merchant_subscriptions s where s.merchant_id = a.user_id))
  || ' approved cook(s) without a subscription' as result;
-- END BLOCK 2


-- ============================================================================
-- BLOCK 3 — VERIFY (read only).
-- Last line should be: the KS Bakery row with exempt = true,
-- founding_number empty, billing_anchor 2027-03-22, source backfill, and
-- missing_after = 0 on every row.
-- ============================================================================
select
  s.merchant_id,
  (select max(a.business_name) from public.cook_applications a where a.user_id = s.merchant_id) as business_name,
  s.exempt,
  s.founding_number,
  s.billing_anchor,
  s.applied_at,
  s.approved_at,
  e.details ->> 'source' as source,
  e.details ->> 'exempt_reason' as exempt_reason,
  e.details ->> 'approved_at_source' as approved_at_source,
  (select count(distinct a.user_id) from public.cook_applications a
    where a.status = 'approved'
      and not exists (select 1 from public.merchant_subscriptions s2 where s2.merchant_id = a.user_id)) as missing_after
from public.merchant_subscriptions s
join public.subscription_events e on e.merchant_id = s.merchant_id and e.action = 'subscription_created'
where e.details ->> 'source' = 'backfill'
order by s.approved_at;
-- END BLOCK 3
