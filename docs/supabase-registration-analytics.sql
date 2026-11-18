-- ============================================================================
-- KOPI BOY — Registration analytics (Boss, Phase 2): one read-only report
-- function over the Partner app's registration_events.
--
-- Needs: the Partner repo's docs/supabase-registration-tracking.sql
-- (public.registration_events) and public.user_has_role(text).
--
-- WHAT IT ADDS (additive only; no table, row, policy or existing function is
-- touched):
--   * public.admin_registration_analytics(p_from timestamptz, p_to timestamptz)
--     returns jsonb — aggregated counts only, never raw rows or session ids.
--     Admins only (raises 42501 for anyone else). Read-only (STABLE: it
--     cannot write).
--
-- HOW IT COUNTS
--   * Unit = a session (one browser tab). Every number is "how many sessions
--     did this at least once" — the unique index already stops a session
--     counting an event twice.
--   * A session belongs to the period its FIRST event falls in
--     ([p_from, p_to)), and then all its events count, even ones after p_to.
--     So a sign-up that crosses midnight is counted once, whole, and the
--     funnel never splits a session across two periods.
--   * Test sessions: a session with ANY is_test row is left out entirely
--     (as the tracking file asks). How many were left out is reported.
--   * Abandoned (approved: 30 minutes): form_start, no submit_success, and
--     the session's last event is more than 30 minutes ago. Started but
--     active in the last 30 minutes = "in progress", not abandoned.
--   * Range: p_from < p_to, at most 400 days. Boss works out SGT day
--     boundaries and passes them in.
--
-- RETURNS (jsonb; every count is an integer, 0 when nothing happened):
--   {
--     "from", "to", "generated_at",
--     "tracking_since":           earliest non-test event ever (null = none yet),
--     "sessions":                 non-test sessions in the period,
--     "test_sessions_excluded":   test sessions in the period (left out),
--     "events":                   { "<event_type>": sessions, ... } (only types seen),
--     "fields":                   [ { "field", "step", "sessions" } ] field_reached, by step,
--     "validation_errors":        [ { "field", "code", "sessions" } ] most first,
--     "signin_errors":            [ { "code", "sessions" } ],
--     "abandon_last_field":       [ { "field", "sessions" } ] from explicit 'abandon' rows ('' = none),
--     "started":                  sessions with form_start,
--     "submitted":                sessions with submit_success,
--     "abandoned":                started, not submitted, idle > 30 min,
--     "in_progress":              started, not submitted, active in the last 30 min
--   }
--
-- One transaction, safe to re-run.
-- ============================================================================

begin;

do $$
declare
  v_missing text[] := '{}';
begin
  if to_regclass('public.registration_events') is null then
    v_missing := pg_catalog.array_append(v_missing, 'public.registration_events (run the Partner repo''s docs/supabase-registration-tracking.sql first)');
  end if;
  if to_regprocedure('public.user_has_role(text)') is null then
    v_missing := pg_catalog.array_append(v_missing, 'public.user_has_role(text)');
  end if;
  if pg_catalog.array_length(v_missing, 1) > 0 then
    raise exception 'registration analytics: missing %. Nothing was changed.', pg_catalog.array_to_string(v_missing, ', ');
  end if;
end;
$$;

create or replace function public.admin_registration_analytics(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.user_has_role('admin'), false) then
    raise exception 'Only admins can view registration analytics.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'A valid date range is required (from before to).' using errcode = '22023';
  end if;
  if p_to - p_from > interval '400 days' then
    raise exception 'The date range can be at most 400 days.' using errcode = '22023';
  end if;

  with
  -- Sessions with any event in the period (uses the created_at index) ...
  touched as (
    select distinct e.session_id
      from public.registration_events e
     where e.created_at >= p_from and e.created_at < p_to
  ),
  -- ... kept only if their FIRST event is in the period.
  sessions as (
    select e.session_id,
           pg_catalog.bool_or(e.is_test) as is_test,
           pg_catalog.max(e.created_at) as last_at,
           pg_catalog.bool_or(e.event_type = 'form_start') as started,
           pg_catalog.bool_or(e.event_type = 'submit_success') as submitted
      from public.registration_events e
      join touched t on t.session_id = e.session_id
     group by e.session_id
    having pg_catalog.min(e.created_at) >= p_from and pg_catalog.min(e.created_at) < p_to
  ),
  live as (
    select * from sessions where not is_test
  ),
  ev as (
    select e.session_id, e.event_type, e.field, e.step, e.error_code
      from public.registration_events e
      join live l on l.session_id = e.session_id
  )
  select pg_catalog.jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'generated_at', pg_catalog.now(),
    'tracking_since', (select pg_catalog.min(s.first_at)
                         from (select pg_catalog.min(x.created_at) as first_at
                                 from public.registration_events x
                                group by x.session_id
                               having not pg_catalog.bool_or(x.is_test)) s),
    'sessions', (select pg_catalog.count(*) from live),
    'test_sessions_excluded', (select pg_catalog.count(*) from sessions where is_test),
    'events', coalesce((
      select pg_catalog.jsonb_object_agg(g.event_type, g.n)
        from (select event_type, pg_catalog.count(distinct session_id) as n from ev group by event_type) g
    ), '{}'::jsonb),
    'fields', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', g.field, 'step', g.step, 'sessions', g.n)
                                  order by g.step nulls last, g.field)
        from (select field, pg_catalog.min(step) as step, pg_catalog.count(distinct session_id) as n
                from ev where event_type = 'field_reached' and field <> '' group by field) g
    ), '[]'::jsonb),
    'validation_errors', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', g.field, 'code', g.error_code, 'sessions', g.n)
                                  order by g.n desc, g.field, g.error_code)
        from (select field, error_code, pg_catalog.count(distinct session_id) as n
                from ev where event_type = 'validation_error' group by field, error_code) g
    ), '[]'::jsonb),
    'signin_errors', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', g.error_code, 'sessions', g.n)
                                  order by g.n desc, g.error_code)
        from (select error_code, pg_catalog.count(distinct session_id) as n
                from ev where event_type = 'signin_error' group by error_code) g
    ), '[]'::jsonb),
    'abandon_last_field', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', g.field, 'sessions', g.n)
                                  order by g.n desc, g.field)
        from (select field, pg_catalog.count(distinct session_id) as n
                from ev where event_type = 'abandon' group by field) g
    ), '[]'::jsonb),
    'started', (select pg_catalog.count(*) from live where started),
    'submitted', (select pg_catalog.count(*) from live where submitted),
    'abandoned', (select pg_catalog.count(*) from live
                   where started and not submitted and last_at < pg_catalog.now() - interval '30 minutes'),
    'in_progress', (select pg_catalog.count(*) from live
                     where started and not submitted and last_at >= pg_catalog.now() - interval '30 minutes')
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.admin_registration_analytics(timestamptz, timestamptz) is
  'Boss: aggregated cook sign-up funnel counts for [p_from, p_to). Admins only, read-only, test sessions excluded. No session ids or raw rows are returned.';

-- Supabase grants EXECUTE on new functions to anon and authenticated by
-- default: take it back, then allow signed-in users only (the function itself
-- refuses anyone who isn't an admin).
revoke all on function public.admin_registration_analytics(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_registration_analytics(timestamptz, timestamptz) to authenticated;

commit;

-- ============================================================================
-- CHECKS AFTERWARDS (read only). Paste one at a time into the SQL editor.
-- CHECKS-BEGIN
--
-- 1. SECURITY DEFINER, empty search_path, STABLE (last line should be: 1 row, prosecdef = true, provolatile = s, proconfig = {search_path=""}):
-- select p.proname, p.prosecdef, p.provolatile, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_registration_analytics';
--
-- 2. Browser roles that can run it (last line should be: 1 row, authenticated):
-- select r.rolname from pg_roles r where r.rolname in ('anon', 'authenticated') and has_function_privilege(r.oid, 'public.admin_registration_analytics(timestamptz, timestamptz)', 'EXECUTE') order by 1;
--
-- 3. The SQL editor is not an admin session, so a call is refused (last line should be: ERROR "Only admins can view registration analytics."):
-- select public.admin_registration_analytics(now() - interval '7 days', now());
--
-- CHECKS-END
-- ============================================================================


-- ============================================================================
-- UNDO (removes only this function; no data is touched). Remove the leading
-- "-- " and run as one block. Last line should be: ANALYTICS FUNCTION DROPPED
-- UNDO-BEGIN
-- drop function if exists public.admin_registration_analytics(timestamptz, timestamptz);
-- select 'ANALYTICS FUNCTION DROPPED' as result;
-- UNDO-END
-- ============================================================================
