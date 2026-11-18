import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * docs/supabase-registration-analytics.sql, run for real in PGlite on top of
 * a harness with profiles, the real user_has_role(), and registration_events
 * exactly as the Partner repo's docs/supabase-registration-tracking.sql
 * creates it (table, unique index, RLS, grants).
 */

const SQL = readFileSync(new URL("../../docs/supabase-registration-analytics.sql", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
);

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`section not found: ${start}`);
  return text.slice(a + start.length, b);
}
const UNDO = between(SQL, "-- UNDO-BEGIN", "-- UNDO-END")
  .split("\n")
  .filter((l) => l.startsWith("-- "))
  .map((l) => l.slice(3))
  .join("\n");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = id(900);
const COOK = id(901);

const HARNESS = `
create role anon;
create role authenticated;
create schema auth;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant execute on function auth.uid() to anon, authenticated;

create table public.profiles (
  id uuid primary key,
  role text not null default 'customer'
);
create or replace function public.user_has_role(check_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = check_role);
$$;
insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${COOK}', 'cook');

-- As in the Partner repo's docs/supabase-registration-tracking.sql.
create table public.registration_events (
  id bigint generated always as identity primary key,
  session_id uuid not null,
  form text not null default 'cook' check (form in ('cook')),
  event_type text not null check (event_type in (
    'signin_view', 'in_app_browser', 'chose_sign_up', 'chose_sign_in', 'signin_click',
    'signin_error', 'existing_account',
    'page_view', 'cook_form_view', 'rider_form_view', 'form_start', 'field_reached',
    'submit_attempt', 'validation_error', 'submit_success', 'abandon'
  )),
  field text not null default '' check (field in (
    '', 'full_name', 'contact_number', 'business_name', 'business_type', 'business_uen',
    'business_address', 'postal_code', 'paynow_mobile', 'paynow_uen', 'privacy_ack'
  )),
  step smallint check (step between 1 and 20),
  error_code text not null default '' check (error_code in (
    '', 'required', 'invalid_format', 'invalid_postal_code', 'invalid_business_uen',
    'paynow_missing', 'invalid_mobile', 'invalid_uen', 'privacy_required', 'server_error',
    'google_error', 'auth_failed', 'google_slow'
  )),
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index registration_events_once
  on public.registration_events (session_id, form, event_type, field, error_code);
create index registration_events_created_at on public.registration_events (created_at);
alter table public.registration_events enable row level security;
revoke all on public.registration_events from public, anon, authenticated;
grant select on public.registration_events to authenticated;
create policy "Admins can read registration events" on public.registration_events for select
  to authenticated using (public.user_has_role('admin'));
`;

type Report = {
  from: string;
  to: string;
  tracking_since: string | null;
  sessions: number;
  test_sessions_excluded: number;
  events: Record<string, number>;
  fields: { field: string; step: number; sessions: number }[];
  validation_errors: { field: string; code: string; sessions: number }[];
  signin_errors: { code: string; sessions: number }[];
  abandon_last_field: { field: string; sessions: number }[];
  started: number;
  submitted: number;
  abandoned: number;
  in_progress: number;
};

type Ev = { event: string; field?: string; step?: number; code?: string; at: string; test?: boolean };

async function addSession(db: PGlite, session: string, events: Ev[]) {
  for (const e of events) {
    await db.query(
      `insert into public.registration_events (session_id, event_type, field, step, error_code, is_test, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [session, e.event, e.field ?? "", e.step ?? null, e.code ?? "", e.test ?? false, e.at]
    );
  }
}

/** Runs as a signed-in browser user (authenticated + JWT sub), rolled back. */
async function asUser<T>(db: PGlite, uid: string | null, fn: () => Promise<T>, role = "authenticated"): Promise<T> {
  await db.exec("begin");
  try {
    if (uid) await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    await db.exec(`set local role ${role}`);
    return await fn();
  } finally {
    await db.exec("rollback");
  }
}

async function report(db: PGlite, from: string, to: string, uid = ADMIN): Promise<Report> {
  return asUser(db, uid, async () => {
    const r = await db.query<{ r: Report }>("select public.admin_registration_analytics($1, $2) as r", [from, to]);
    return r.rows[0].r;
  });
}

async function attempt(db: PGlite, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

const FROM = "2026-11-10T16:00:00Z"; // 11 Nov 00:00 SGT
const TO = "2026-11-17T16:00:00Z"; // 18 Nov 00:00 SGT
const S = (n: number) => id(n);

describe("admin_registration_analytics", () => {
  let db: PGlite;

  before(async () => {
    db = new PGlite();
    await db.exec(HARNESS);
    await db.exec(SQL);
  });
  after(async () => {
    await db.close();
  });

  it("returns a zeroed report, not an error, when there are no events", async () => {
    const r = await report(db, FROM, TO);
    assert.equal(r.sessions, 0);
    assert.equal(r.tracking_since, null);
    assert.deepEqual(r.events, {});
    assert.deepEqual(r.fields, []);
    assert.deepEqual(r.validation_errors, []);
    assert.equal(r.started, 0);
    assert.equal(r.submitted, 0);
    assert.equal(r.abandoned, 0);
    assert.equal(r.in_progress, 0);
  });

  it("is runnable by signed-in users only, and refuses anyone who isn't an admin", async () => {
    const asCook = await attempt(db, () => report(db, FROM, TO, COOK));
    assert.match(asCook, /Only admins can view registration analytics/);
    const asAnon = await attempt(db, () =>
      asUser(db, null, () => db.query("select public.admin_registration_analytics(now() - interval '1 day', now())"), "anon")
    );
    assert.match(asAnon, /permission denied/);
    // The SQL editor / owner is not an admin session either.
    const asOwner = await attempt(db, () => db.query("select public.admin_registration_analytics(now() - interval '1 day', now())"));
    assert.match(asOwner, /Only admins/);
  });

  it("rejects bad ranges", async () => {
    assert.match(await attempt(db, () => report(db, TO, FROM)), /valid date range/);
    assert.match(await attempt(db, () => report(db, FROM, FROM)), /valid date range/);
    assert.match(
      await attempt(db, () => report(db, "2025-01-01T00:00:00Z", "2026-03-01T00:00:00Z")),
      /at most 400 days/
    );
  });

  it("counts sessions per event, the field funnel, errors, abandonment, and leaves out test sessions", async () => {
    const d = "2026-11-12T02:00:00Z";
    // 1: full sign-up, submitted.
    await addSession(db, S(1), [
      { event: "signin_view", at: "2026-11-12T02:00:00Z" },
      { event: "chose_sign_up", at: "2026-11-12T02:00:05Z" },
      { event: "signin_click", at: "2026-11-12T02:00:10Z" },
      { event: "page_view", at: "2026-11-12T02:01:00Z" },
      { event: "cook_form_view", at: "2026-11-12T02:01:05Z" },
      { event: "form_start", at: "2026-11-12T02:01:10Z" },
      { event: "field_reached", field: "full_name", step: 1, at: "2026-11-12T02:01:10Z" },
      { event: "field_reached", field: "contact_number", step: 2, at: "2026-11-12T02:01:20Z" },
      { event: "submit_attempt", at: "2026-11-12T02:05:00Z" },
      { event: "validation_error", field: "postal_code", step: 7, code: "invalid_postal_code", at: "2026-11-12T02:05:00Z" },
      { event: "submit_success", at: "2026-11-12T02:06:00Z" },
    ]);
    // 2: started, gave up at contact_number, tab closed long ago.
    await addSession(db, S(2), [
      { event: "signin_view", at: "2026-11-13T02:00:00Z" },
      { event: "in_app_browser", at: "2026-11-13T02:00:00Z" },
      { event: "page_view", at: "2026-11-13T02:01:00Z" },
      { event: "cook_form_view", at: "2026-11-13T02:01:05Z" },
      { event: "form_start", at: "2026-11-13T02:01:10Z" },
      { event: "field_reached", field: "full_name", step: 1, at: "2026-11-13T02:01:10Z" },
      { event: "validation_error", field: "postal_code", step: 7, code: "invalid_postal_code", at: "2026-11-13T02:02:00Z" },
      { event: "validation_error", field: "full_name", step: 1, code: "required", at: "2026-11-13T02:02:00Z" },
      { event: "abandon", field: "full_name", step: 1, at: "2026-11-13T02:03:00Z" },
    ]);
    // 3: Google error on the sign-in screen, never got further.
    await addSession(db, S(3), [
      { event: "signin_view", at: "2026-11-14T02:00:00Z" },
      { event: "signin_click", at: "2026-11-14T02:00:10Z" },
      { event: "signin_error", code: "google_error", at: "2026-11-14T02:00:20Z" },
    ]);
    // 4: test session — every row of it is left out, even the non-test ones.
    await addSession(db, S(4), [
      { event: "signin_view", at: d },
      { event: "page_view", at: "2026-11-12T02:01:00Z", test: true },
      { event: "form_start", at: "2026-11-12T02:01:10Z", test: true },
    ]);
    // 5: first event before the period: belongs to the previous period, not this one.
    await addSession(db, S(5), [
      { event: "signin_view", at: "2026-11-10T15:59:00Z" },
      { event: "page_view", at: "2026-11-10T16:01:00Z" },
    ]);
    // 6: starts in the period, submits after it ends: counted here, whole.
    await addSession(db, S(6), [
      { event: "cook_form_view", at: "2026-11-17T15:50:00Z" },
      { event: "form_start", at: "2026-11-17T15:55:00Z" },
      { event: "field_reached", field: "full_name", step: 1, at: "2026-11-17T15:55:00Z" },
      { event: "submit_success", at: "2026-11-17T16:10:00Z" },
    ]);

    const r = await report(db, FROM, TO);
    assert.equal(r.sessions, 4);
    assert.equal(r.test_sessions_excluded, 1);
    assert.equal(new Date(r.tracking_since!).toISOString(), "2026-11-10T15:59:00.000Z");
    assert.deepEqual(r.events, {
      signin_view: 3,
      chose_sign_up: 1,
      signin_click: 2,
      in_app_browser: 1,
      signin_error: 1,
      page_view: 2,
      cook_form_view: 3,
      form_start: 3,
      field_reached: 3,
      submit_attempt: 1,
      validation_error: 2,
      submit_success: 2,
      abandon: 1,
    });
    assert.deepEqual(r.fields, [
      { field: "full_name", step: 1, sessions: 3 },
      { field: "contact_number", step: 2, sessions: 1 },
    ]);
    assert.deepEqual(r.validation_errors, [
      { field: "postal_code", code: "invalid_postal_code", sessions: 2 },
      { field: "full_name", code: "required", sessions: 1 },
    ]);
    assert.deepEqual(r.signin_errors, [{ code: "google_error", sessions: 1 }]);
    assert.deepEqual(r.abandon_last_field, [{ field: "full_name", sessions: 1 }]);
    assert.equal(r.started, 3);
    assert.equal(r.submitted, 2);
    assert.equal(r.abandoned, 1);
    assert.equal(r.in_progress, 0);
  });

  it("returns no session ids", async () => {
    const r = await report(db, FROM, TO);
    assert.doesNotMatch(JSON.stringify(r), /00000000-0000-4000-8000/);
  });

  it("counts a started session active in the last 30 minutes as in progress, not abandoned", async () => {
    // On its own: the fixtures above sit close to today's real date.
    await db.exec("delete from public.registration_events");
    await db.exec(`
      insert into public.registration_events (session_id, event_type, created_at) values
        ('${S(20)}', 'form_start', now() - interval '10 minutes');
      insert into public.registration_events (session_id, event_type, created_at) values
        ('${S(21)}', 'form_start', now() - interval '2 hours');
    `);
    const r = await asUser(db, ADMIN, async () => {
      const q = await db.query<{ r: Report }>(
        "select public.admin_registration_analytics(now() - interval '1 day', now() + interval '1 minute') as r"
      );
      return q.rows[0].r;
    });
    assert.equal(r.started, 2);
    assert.equal(r.in_progress, 1);
    assert.equal(r.abandoned, 1);
  });

  it("is safe to re-run, and the UNDO block removes only the function", async () => {
    await db.exec(SQL);
    await db.exec(UNDO);
    const fn = await db.query("select 1 from pg_proc where proname = 'admin_registration_analytics'");
    assert.equal(fn.rows.length, 0);
    const n = await db.query<{ n: number }>("select count(*)::int as n from public.registration_events");
    assert.ok(n.rows[0].n > 0);
    await db.exec(SQL);
  });
});
