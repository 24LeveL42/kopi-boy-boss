import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * Subscriptions step 2, run for real in PGlite:
 *   docs/supabase-subscriptions-step2.sql            (trigger, functions)
 *   docs/supabase-subscriptions-step2-backfill.sql   (preview / apply / verify)
 *   docs/supabase-subscriptions-step2-live-test.sql  (the live DO-block test)
 *   docs/supabase-delete-test-merchant.sql           (owner-run delete)
 * on top of step 1 (docs/supabase-subscriptions.sql) and a harness with the
 * Partner tables the trigger touches: auth.users + on_auth_user_created,
 * profiles, cook/rider/picker applications, kitchens, menu_items, the real
 * user_has_role() and the existing promote_approved_applicant triggers
 * (copied from the Partner repo's docs/supabase-schema.sql).
 */

const read = (p: string) => readFileSync(new URL(`../../docs/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const STEP1 = read("supabase-subscriptions.sql");
const STEP2 = read("supabase-subscriptions-step2.sql");
const BACKFILL = read("supabase-subscriptions-step2-backfill.sql");
const LIVE_TEST = read("supabase-subscriptions-step2-live-test.sql");
const DELETE_SCRIPT = read("supabase-delete-test-merchant.sql");
const BILLING_OFF = read("supabase-billing-off.sql");
const BILLING_OFF_LIVE_TEST = read("supabase-billing-off-live-test.sql");

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`section not found: ${start}`);
  return text.slice(a + start.length, b);
}
const uncomment = (s: string) =>
  s
    .split("\n")
    .filter((l) => l.startsWith("-- "))
    .map((l) => l.slice(3))
    .join("\n");

const CHECKS = between(STEP2, "-- CHECKS-BEGIN", "-- CHECKS-END")
  .split("\n")
  .filter((l) => l.startsWith("-- select "))
  .map((l) => l.slice(3));
const BILLING_OFF_CHECKS = between(BILLING_OFF, "-- CHECKS-BEGIN", "-- CHECKS-END")
  .split("\n")
  .filter((l) => l.startsWith("-- select "))
  .map((l) => l.slice(3));
const EMERGENCY = uncomment(between(STEP2, "-- EMERGENCY-BEGIN", "-- EMERGENCY-END"));
const UNDO = uncomment(between(STEP2, "-- UNDO-BEGIN", "-- UNDO-END"));

const block = (text: string, n: number) => {
  const start = text.indexOf(`-- BLOCK ${n} `);
  const end = text.indexOf(`-- END BLOCK ${n}`);
  if (start < 0 || end < 0) throw new Error(`block ${n} not found`);
  return text.slice(start, end);
};

const TEST_EMAIL = "ks.bakery.owner@example.com";
const EMAIL_PLACEHOLDER = "<paste test account email here>";
const backfillPreview = (email = TEST_EMAIL) => block(BACKFILL, 1).replace(EMAIL_PLACEHOLDER, email);
function backfillApply(opts: { email?: string | null; commit?: boolean; expectedNotExempt?: number } = {}) {
  let s = block(BACKFILL, 2);
  if (opts.email !== undefined) {
    s = s.replace(`array['${EMAIL_PLACEHOLDER}']`, opts.email === null ? "array[]::text[]" : `array['${opts.email}']`);
  }
  if (opts.commit) s = s.replace("v_commit boolean := false", "v_commit boolean := true");
  if (opts.expectedNotExempt !== undefined) {
    s = s.replace("v_expected_not_exempt int := 0", `v_expected_not_exempt int := ${opts.expectedNotExempt}`);
  }
  return s;
}
function deleteScript(opts: { email?: string; commit?: boolean; deleteAuth?: boolean } = {}) {
  let s = block(DELETE_SCRIPT, 1);
  if (opts.email) s = s.replace("'<paste test merchant email here>'", `'${opts.email}'`);
  if (opts.commit) s = s.replace("v_commit boolean := false", "v_commit boolean := true");
  if (opts.deleteAuth) s = s.replace("v_delete_auth_user boolean := false", "v_delete_auth_user boolean := true");
  return s;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = id(900);

/** The Partner tables step 2 touches, as they are live (minus unrelated columns). */
const HARNESS = `
create role anon;
create role authenticated;
create schema auth;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;

create table auth.users (
  id uuid primary key,
  instance_id uuid,
  aud text,
  role text,
  email text,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- Same lookup order as Supabase's auth.uid().
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant execute on function auth.uid() to anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'customer' check (role in ('customer', 'cook', 'rider', 'picker', 'admin')),
  is_active boolean not null default true
);

create function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, full_name) values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer set search_path = public;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.user_has_role(check_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = check_role);
$$;

create table public.cook_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  business_type text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.rider_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_type text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.picker_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
-- Boss approves through RLS as a signed-in admin.
alter table public.cook_applications enable row level security;
grant select, insert, update on public.cook_applications to authenticated;
create policy "Admins can read every cook application" on public.cook_applications for select using (public.user_has_role('admin'));
create policy "Admins can update every cook application" on public.cook_applications for update using (public.user_has_role('admin'));

create table public.kitchens (
  id uuid primary key references public.profiles(id) on delete cascade,
  business_name text not null
);
create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens(id) on delete cascade,
  name text not null
);
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens(id) on delete cascade
);

-- The existing promotion triggers (Partner schema), unchanged.
create or replace function public.promote_approved_applicant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set role = tg_argv[0] where id = new.user_id and role = 'customer';
  return new;
end;
$$;
create trigger after_cook_application_approved after insert or update of status on public.cook_applications
  for each row when (new.status = 'approved') execute function public.promote_approved_applicant('cook');
create trigger after_rider_application_approved after insert or update of status on public.rider_applications
  for each row when (new.status = 'approved') execute function public.promote_approved_applicant('rider');
create trigger after_picker_application_approved after insert or update of status on public.picker_applications
  for each row when (new.status = 'approved') execute function public.promote_approved_applicant('picker');

insert into auth.users (id, email) values ('${ADMIN}', 'hq@example.com');
update public.profiles set role = 'admin' where id = '${ADMIN}';
`;

type Sub = {
  merchant_id: string;
  founding_number: number | null;
  is_founding: boolean;
  billing_anchor: string;
  applied_at: string;
  approved_at: string;
  months_paid: number;
  exempt: boolean;
};

const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

/** The error message, or "" if it worked. */
async function attempt(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  try {
    if (params.length) await db.query(sql, params);
    else await db.exec(sql);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

async function freshDb(opts: { step2?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(HARNESS);
  await db.exec(STEP1);
  if (opts.step2 !== false) await db.exec(STEP2);
  return db;
}

let userSeq = 1;
async function addUser(db: PGlite, opts: { email?: string; role?: string } = {}): Promise<string> {
  const uid = id(userSeq++);
  await db.query("insert into auth.users (id, email) values ($1, $2)", [uid, opts.email ?? `${uid}@example.com`]);
  if (opts.role) await db.query("update public.profiles set role = $2 where id = $1", [uid, opts.role]);
  return uid;
}
async function apply(db: PGlite, uid: string, createdAt: string, status = "pending"): Promise<string> {
  const [r] = await rows<{ id: string }>(
    db,
    "insert into public.cook_applications (user_id, business_name, business_type, status, created_at) values ($1, 'Test Kitchen', 'Home Cook', $2, $3) returning id",
    [uid, status, createdAt]
  );
  return r.id;
}
/** Approve the way Boss does (only rows not approved yet). */
async function approve(db: PGlite, appId: string, reviewedAt: string | null = "2026-11-20T02:00:00Z") {
  await db.query(
    "update public.cook_applications set status = 'approved', reviewed_by = $3, reviewed_at = $2 where id = $1 and status <> 'approved'",
    [appId, reviewedAt, ADMIN]
  );
}
async function sub(db: PGlite, uid: string): Promise<Sub | undefined> {
  const [r] = await rows<Sub>(
    db,
    `select merchant_id, founding_number, is_founding, billing_anchor::text, applied_at::text, approved_at::text, months_paid, exempt
     from public.merchant_subscriptions where merchant_id = $1`,
    [uid]
  );
  return r;
}
async function events(db: PGlite, uid: string, action = "subscription_created") {
  return rows<{ actor: string | null; details: Record<string, unknown> }>(
    db,
    "select actor, details from public.subscription_events where merchant_id = $1 and action = $2 order by created_at",
    [uid, action]
  );
}
const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await rows<{ n: number }>(db, sql, params))[0].n;
/** As the table owner with the billing flag on, inside a rolled-back transaction. */
async function asOwnerWithFlag<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('kb.billing_write', 'on', true)");
    return await fn();
  } finally {
    await db.exec("rollback");
  }
}
/** As a signed-in browser user (authenticated + JWT sub), rolled back. */
async function asUser<T>(db: PGlite, uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    await db.exec("set local role authenticated");
    return await fn();
  } finally {
    await db.exec("rollback");
  }
}

// 21 Dec 2026 23:59:59 SGT and 22 Dec 2026 00:00:00 SGT.
const LAST_FOUNDING_MOMENT = "2026-12-21T15:59:59Z";
const LAUNCH_MOMENT = "2026-12-21T16:00:00Z";

describe("step 2 — founding eligibility and the billing anchor", () => {
  let db: PGlite;
  before(async () => {
    db = await freshDb();
  });
  after(() => db.close());

  it("applied 21 Dec 23:59:59 SGT: founding #1, anchor 22 Mar 2027, months_paid 0, applied_at stored", async () => {
    const u = await addUser(db);
    await approve(db, await apply(db, u, LAST_FOUNDING_MOMENT));
    const s = await sub(db, u);
    assert.equal(s?.founding_number, 1);
    assert.equal(s?.is_founding, true);
    assert.equal(s?.billing_anchor, "2027-03-22");
    assert.equal(s?.months_paid, 0);
    assert.equal(s?.exempt, false);
    assert.equal(new Date(s!.applied_at).toISOString(), "2026-12-21T15:59:59.000Z");
  });

  it("applied 22 Dec 00:00 SGT: not founding, no number; approved 22 Dec -> anchor 22 Jan 2027", async () => {
    const u = await addUser(db);
    await approve(db, await apply(db, u, LAUNCH_MOMENT), "2026-12-22T02:00:00Z");
    const s = await sub(db, u);
    assert.equal(s?.founding_number, null);
    assert.equal(s?.is_founding, false);
    assert.equal(s?.billing_anchor, "2027-01-22");
  });

  it("non-founding anchors: 10 Jan -> 10 Feb, 31 Jan -> 28 Feb, 31 Jan 16:30 UTC (1 Feb SGT) -> 1 Mar", async () => {
    const cases: [string, string][] = [
      ["2027-01-10T03:00:00Z", "2027-02-10"],
      ["2027-01-31T04:00:00Z", "2027-02-28"],
      ["2027-01-31T16:30:00Z", "2027-03-01"],
    ];
    for (const [reviewed, anchor] of cases) {
      const u = await addUser(db);
      await approve(db, await apply(db, u, "2027-01-05T02:00:00Z"), reviewed);
      assert.equal((await sub(db, u))?.billing_anchor, anchor, reviewed);
    }
  });

  it("Q-A: founding approved on/before 22 Mar 2027 keeps 22 Mar; approved after it -> approval date + 1 month", async () => {
    const cases: [string, string][] = [
      ["2027-02-25T02:00:00Z", "2027-03-22"],
      ["2027-03-22T02:00:00Z", "2027-03-22"], // due on the approval day, not overdue
      ["2027-03-23T02:00:00Z", "2027-04-23"],
      ["2027-05-31T02:00:00Z", "2027-06-30"],
    ];
    for (const [reviewed, anchor] of cases) {
      const u = await addUser(db);
      await approve(db, await apply(db, u, "2026-12-01T02:00:00Z"), reviewed);
      const s = await sub(db, u);
      assert.equal(s?.is_founding, true, reviewed);
      assert.equal(s?.billing_anchor, anchor, reviewed);
    }
  });

  it("Q-C: the EARLIEST application decides (rejected 10 Dec, re-applied 5 Jan, approved -> founding)", async () => {
    const u = await addUser(db);
    const first = await apply(db, u, "2026-12-10T02:00:00Z");
    await db.query("update public.cook_applications set status = 'rejected' where id = $1", [first]);
    assert.equal(await sub(db, u), undefined);
    await approve(db, await apply(db, u, "2027-01-05T02:00:00Z"), "2027-01-06T02:00:00Z");
    const s = await sub(db, u);
    assert.equal(s?.is_founding, true);
    assert.equal(new Date(s!.applied_at).toISOString(), "2026-12-10T02:00:00.000Z");
    assert.equal(s?.billing_anchor, "2027-03-22");
  });

  it("Q-E: reviewed_at empty -> approved_at = now(), and the event says so", async () => {
    const u = await addUser(db);
    await approve(db, await apply(db, u, "2026-12-01T02:00:00Z"), null);
    const s = await sub(db, u);
    assert.ok(Math.abs(new Date(s!.approved_at).getTime() - Date.now()) < 60_000);
    const [e] = await events(db, u);
    assert.equal(e.details.approved_at_source, "now (reviewed_at was empty)");
  });

  it("writes one subscription_created event with the details", async () => {
    const u = await addUser(db);
    const app = await apply(db, u, LAST_FOUNDING_MOMENT);
    await approve(db, app);
    const e = await events(db, u);
    assert.equal(e.length, 1);
    const d = e[0].details;
    assert.equal(d.application_id, app);
    assert.equal(d.source, "trigger");
    assert.equal(d.founding_eligible, true);
    assert.equal(typeof d.founding_number, "number");
    assert.equal(d.exempt, false);
    assert.equal(d.exempt_reason, null);
    assert.equal(d.billing_anchor, "2027-03-22");
    assert.equal(d.approved_at_source, "reviewed_at");
    assert.equal(e[0].actor, null, "no signed-in user in the SQL editor");
  });
});

describe("step 2 — numbering", () => {
  it("1000 pre-launch approvals in one statement: numbers 1..1000, no gaps, no duplicates", async () => {
    const db = await freshDb();
    await db.exec(`
      insert into auth.users (id, email)
        select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'bulk' || g || '@example.com' from generate_series(1, 1000) g;
      insert into public.cook_applications (user_id, business_name, business_type, created_at)
        select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'Bulk ' || g, 'Home Cook', '2026-12-01T00:00:00Z'::timestamptz + g * interval '1 minute'
        from generate_series(1, 1000) g;
      update public.cook_applications set status = 'approved', reviewed_at = '2026-12-15T02:00:00Z';
    `);
    const [r] = await rows<{ n: number; d: number; lo: number; hi: number; founding: number; anchors: number }>(
      db,
      `select count(founding_number)::int as n, count(distinct founding_number)::int as d,
              min(founding_number) as lo, max(founding_number) as hi,
              count(*) filter (where is_founding)::int as founding,
              count(distinct billing_anchor)::int as anchors
       from public.merchant_subscriptions`
    );
    assert.deepEqual(r, { n: 1000, d: 1000, lo: 1, hi: 1000, founding: 1000, anchors: 1 });
    for (const n of [101, 1000]) {
      const [s] = await rows<{ billing_anchor: string }>(db, "select billing_anchor::text from public.merchant_subscriptions where founding_number = $1", [n]);
      assert.equal(s?.billing_anchor, "2027-03-22", `#${n}`);
    }
    assert.equal(await count(db, "select count(*)::int as n from public.subscription_events where action = 'subscription_created'"), 1000);
    await db.close();
  });

  it("the next number is max + 1; a forced duplicate is refused by the unique index", async () => {
    const db = await freshDb();
    const a = await addUser(db);
    const b = await addUser(db);
    await approve(db, await apply(db, a, "2026-12-01T00:00:00Z"));
    await approve(db, await apply(db, b, "2026-12-01T00:00:00Z"));
    assert.equal((await sub(db, b))?.founding_number, 2);
    const err = await asOwnerWithFlag(db, () =>
      attempt(db, "update public.merchant_subscriptions set founding_number = 1 where merchant_id = $1", [b])
    );
    assert.match(err, /duplicate key|unique/);
    await db.close();
  });

  it("Q-G: deleting the highest-numbered merchant lets the next approval reuse that number", async () => {
    const db = await freshDb();
    const a = await addUser(db);
    const b = await addUser(db);
    await approve(db, await apply(db, a, "2026-12-01T00:00:00Z"));
    await approve(db, await apply(db, b, "2026-12-01T00:00:00Z"));
    await db.exec("begin; select set_config('kb.billing_write', 'on', true);");
    await db.query("delete from public.merchant_subscriptions where merchant_id = $1", [b]);
    await db.exec("commit");
    const c = await addUser(db);
    await approve(db, await apply(db, c, "2026-12-01T00:00:00Z"));
    assert.equal((await sub(db, c))?.founding_number, 2);
    await db.close();
  });

  it("the approval takes the kb_founding_assign advisory lock (held until the transaction ends)", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    await db.exec("begin");
    await approve(db, app);
    const held = await count(
      db,
      `select count(*)::int as n from pg_locks
       where locktype = 'advisory' and granted
         and ((classid::bigint << 32) | objid::bigint) = (hashtext('kb_founding_assign')::bigint & 4294967295)`
    );
    await db.exec("rollback");
    assert.equal(held, 1);
    const [src] = await rows<{ prosrc: string }>(db, "select prosrc from pg_proc where proname = 'billing_create_subscription'");
    assert.match(src.prosrc, /pg_advisory_xact_lock\(pg_catalog\.hashtext\('kb_founding_assign'\)\)/);
    await db.close();
  });
});

describe("step 2 — when nothing (more) happens", () => {
  let db: PGlite;
  before(async () => {
    db = await freshDb();
  });
  after(() => db.close());

  it("re-approve (approved -> rejected -> approved) changes nothing: same row, same number, one event", async () => {
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    await approve(db, app);
    const before = await sub(db, u);
    await db.query("update public.cook_applications set status = 'rejected' where id = $1", [app]);
    await db.query("update public.cook_applications set status = 'approved', reviewed_at = '2027-04-01T02:00:00Z' where id = $1", [app]);
    assert.deepEqual(await sub(db, u), before);
    assert.equal((await events(db, u)).length, 1);
  });

  it("approved -> approved, and a second approved application for the same user, change nothing", async () => {
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    await approve(db, app);
    const before = await sub(db, u);
    await db.query("update public.cook_applications set status = 'approved', reviewed_at = now() where id = $1", [app]);
    await approve(db, await apply(db, u, "2027-02-01T00:00:00Z"), "2027-02-02T00:00:00Z");
    assert.deepEqual(await sub(db, u), before);
    assert.equal((await events(db, u)).length, 1);
  });

  it("pending, rejected and pending -> rejected create nothing; 'withdrawn' is refused by the status check", async () => {
    const u = await addUser(db);
    await apply(db, u, "2026-12-01T00:00:00Z");
    await apply(db, u, "2026-12-01T00:00:00Z", "rejected");
    const p = await apply(db, u, "2026-12-01T00:00:00Z");
    await db.query("update public.cook_applications set status = 'rejected' where id = $1", [p]);
    assert.equal(await sub(db, u), undefined);
    const err = await attempt(db, "update public.cook_applications set status = 'withdrawn' where id = $1", [p]);
    assert.match(err, /check constraint/);
    assert.equal(await sub(db, u), undefined);
  });

  it("rider and picker approvals create nothing", async () => {
    const u = await addUser(db);
    for (const table of ["rider_applications", "picker_applications"]) {
      const [r] = await rows<{ id: string }>(db, `insert into public.${table} (user_id, created_at) values ($1, '2026-12-01T00:00:00Z') returning id`, [u]);
      await db.query(`update public.${table} set status = 'approved', reviewed_at = now() where id = $1`, [r.id]);
      await db.query(`insert into public.${table} (user_id, status) values ($1, 'approved')`, [u]);
    }
    assert.equal(await sub(db, u), undefined);
    assert.equal(await count(db, "select count(*)::int as n from public.subscription_events where merchant_id = $1", [u]), 0);
  });

  it("an application INSERTED already approved (HQ / SQL editor) still gets its row", async () => {
    const u = await addUser(db);
    await db.query(
      "insert into public.cook_applications (user_id, business_name, status, reviewed_at, created_at) values ($1, 'Direct', 'approved', '2026-11-30T02:00:00Z', '2026-11-29T02:00:00Z')",
      [u]
    );
    const s = await sub(db, u);
    assert.equal(s?.is_founding, true);
    assert.equal((await events(db, u))[0].details.source, "trigger");
  });

  it("exempt: an admin-role applicant gets exempt = true, no number, anchor = founding_free_until; the next founding number is unaffected", async () => {
    const fresh = await freshDb();
    const admin = await addUser(fresh, { role: "admin" });
    await approve(fresh, await apply(fresh, admin, "2026-12-01T00:00:00Z"));
    const s = await sub(fresh, admin);
    assert.equal(s?.exempt, true);
    assert.equal(s?.founding_number, null);
    assert.equal(s?.billing_anchor, "2027-03-22");
    assert.equal((await events(fresh, admin))[0].details.exempt_reason, "admin account");
    const [{ role }] = await rows<{ role: string }>(fresh, "select role from public.profiles where id = $1", [admin]);
    assert.equal(role, "admin", "the existing trigger never demotes an admin");
    const next = await addUser(fresh);
    await approve(fresh, await apply(fresh, next, "2026-12-01T00:00:00Z"));
    assert.equal((await sub(fresh, next))?.founding_number, 1);
    await fresh.close();
  });
});

describe("step 2 — fail closed, the lock flag and privileges", () => {
  it("no profile row: the approval fails with billing_setup_failed and stays pending", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    await db.query("delete from public.profiles where id = $1", [u]);
    const err = await attempt(db, "update public.cook_applications set status = 'approved', reviewed_at = now() where id = $1", [app]);
    assert.match(err, /^billing_setup_failed: user .* has no profile row \(the approval was not saved/);
    const [a] = await rows<{ status: string }>(db, "select status from public.cook_applications where id = $1", [app]);
    assert.equal(a.status, "pending");
    assert.equal(await count(db, "select count(*)::int as n from public.subscription_events"), 0);
    await db.close();
  });

  it("no billing_settings row: the approval fails, and the role promotion rolls back with it", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    await db.exec("begin; select set_config('kb.billing_write', 'on', true); delete from public.billing_settings; commit;");
    const err = await attempt(db, "update public.cook_applications set status = 'approved' where id = $1", [app]);
    assert.match(err, /^billing_setup_failed: the billing_settings row is missing/);
    const [p] = await rows<{ role: string }>(db, "select role from public.profiles where id = $1", [u]);
    assert.equal(p.role, "customer");
    assert.equal(await sub(db, u), undefined);
    await db.close();
  });

  it("a signed-in admin approving through RLS gets the row (no billing grants needed); actor = the admin; flag back off", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    const flag = await asUser(db, ADMIN, async () => {
      await db.query("update public.cook_applications set status = 'approved', reviewed_by = $2, reviewed_at = now() where id = $1", [app, ADMIN]);
      const [r] = await rows<{ f: string | null }>(db, "select current_setting('kb.billing_write', true) as f");
      const [s] = await rows<{ actor: string }>(db, "select actor from public.subscription_events where merchant_id = $1", [u]);
      return { flag: r.f, actor: s?.actor };
    });
    assert.notEqual(flag.flag, "on");
    assert.equal(flag.actor, ADMIN);
  });

  it("browser roles can't run the create or trigger functions; all three are SECURITY DEFINER with search_path ''", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    for (const role of ["anon", "authenticated"]) {
      await db.exec("begin");
      await db.exec(`set local role ${role}`);
      const err = await attempt(db, "select public.billing_create_subscription($1, 'backfill')", [app]);
      await db.exec("rollback");
      assert.match(err, /permission denied/, role);
    }
    const fns = await rows<{ proname: string; prosecdef: boolean; proconfig: string[] }>(
      db,
      "select proname, prosecdef, proconfig from pg_proc where proname in ('billing_create_subscription', 'billing_on_cook_application_approved', 'admin_remove_unpaid_subscription') order by proname"
    );
    assert.equal(fns.length, 3);
    for (const f of fns) {
      assert.equal(f.prosecdef, true, f.proname);
      assert.deepEqual(f.proconfig, ['search_path=""'], f.proname);
    }
    await db.close();
  });

  it("the create function refuses an application that isn't approved, and an unknown source", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    assert.match(await attempt(db, "select public.billing_create_subscription($1, 'backfill')", [app]), /is pending, not approved/);
    assert.match(await attempt(db, "select public.billing_create_subscription($1, 'browser')", [app]), /unknown source/);
    assert.equal(await sub(db, u), undefined);
    await db.close();
  });
});

describe("step 2 — admin_remove_unpaid_subscription (Boss delete flow)", () => {
  let db: PGlite;
  let merchant: string;
  before(async () => {
    db = await freshDb();
    merchant = await addUser(db);
    await approve(db, await apply(db, merchant, "2026-12-01T00:00:00Z"));
  });
  after(() => db.close());

  it("without removing the subscription first, deleting the profile is refused (the RESTRICT problem)", async () => {
    const err = await attempt(db, "delete from public.profiles where id = $1", [merchant]);
    assert.match(err, /foreign key/);
  });

  it("a non-admin is refused", async () => {
    const err = await asUser(db, merchant, () => attempt(db, "select public.admin_remove_unpaid_subscription($1, 'x')", [merchant]));
    assert.match(err, /Only admins can remove a subscription/);
  });

  it("anon can't run it at all", async () => {
    await db.exec("begin; set local role anon;");
    const err = await attempt(db, "select public.admin_remove_unpaid_subscription($1, 'x')", [merchant]);
    await db.exec("rollback");
    assert.match(err, /permission denied/);
  });

  it("refused with a payment, including a voided one", async () => {
    await db.exec("begin; select set_config('kb.billing_write', 'on', true);");
    await db.query(
      "insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference, voided_at, voided_by, void_reason) values ($1, 2995, '2027-03-20', 'PN-VOID', now(), $2, 'typo')",
      [merchant, ADMIN]
    );
    const err = await asUserInside(db, ADMIN, () => attempt(db, "select public.admin_remove_unpaid_subscription($1, 'test')", [merchant]));
    await db.exec("rollback");
    assert.match(err, /^billing_has_payments: this merchant has 1 payment record/);
  });

  it("a reason is required", async () => {
    const err = await asUser(db, ADMIN, () => attempt(db, "select public.admin_remove_unpaid_subscription($1, '  ')", [merchant]));
    assert.match(err, /A reason is required/);
  });

  it("no payments: removes the row, logs subscription_deleted (actor = admin), events stay; then the profile can go", async () => {
    await db.exec("begin");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ADMIN]);
    await db.exec("set local role authenticated");
    const [r] = await rows<{ removed: boolean }>(db, "select public.admin_remove_unpaid_subscription($1, 'Boss: delete test partner') as removed", [merchant]);
    const [again] = await rows<{ removed: boolean }>(db, "select public.admin_remove_unpaid_subscription($1, 'again') as removed", [merchant]);
    await db.exec("reset role");
    await db.exec("commit");
    assert.equal(r.removed, true);
    assert.equal(again.removed, false, "no row -> false");
    assert.equal(await sub(db, merchant), undefined);
    const del = await events(db, merchant, "subscription_deleted");
    assert.equal(del.length, 1);
    assert.equal(del[0].actor, ADMIN);
    assert.equal(del[0].details.reason, "Boss: delete test partner");
    assert.equal((await events(db, merchant)).length, 1, "the creation event is kept");
    assert.equal(await attempt(db, "delete from public.profiles where id = $1", [merchant]), "");
    const err = await asOwnerWithFlag(db, () => attempt(db, "delete from public.subscription_events where merchant_id = $1", [merchant]));
    assert.match(err, /billing_append_only/);
  });
});

/** Like asUser, but inside a transaction the caller already opened. */
async function asUserInside<T>(db: PGlite, uid: string, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
  await db.exec("savepoint as_user; set local role authenticated;");
  try {
    return await fn();
  } finally {
    await db.exec("rollback to savepoint as_user; reset role;");
  }
}

describe("step 2 — backfill (KS Bakery: approved before the trigger existed)", () => {
  /** Approved cooks from before step 2: the test account, an admin, optionally a real merchant. */
  async function preStep2(opts: { realMerchant?: boolean; reviewedAtNull?: boolean } = {}) {
    const db = await freshDb({ step2: false });
    const ks = await addUser(db, { email: TEST_EMAIL });
    await apply(db, ks, "2026-10-01T02:00:00Z", "rejected");
    const ksApp = await apply(db, ks, "2026-10-05T02:00:00Z");
    await approve(db, ksApp, opts.reviewedAtNull ? null : "2026-10-06T02:00:00Z");
    const admin = await addUser(db, { role: "admin" });
    await approve(db, await apply(db, admin, "2026-10-07T02:00:00Z"), "2026-10-08T02:00:00Z");
    let real: string | undefined;
    if (opts.realMerchant) {
      real = await addUser(db);
      await approve(db, await apply(db, real, "2026-10-09T02:00:00Z"), "2026-10-10T02:00:00Z");
    }
    await db.exec(STEP2);
    return { db, ks, admin, real };
  }

  it("the preview lists the cooks without a row and proposes exactly what the apply block then does", async () => {
    const { db, ks, admin, real } = await preStep2({ realMerchant: true });
    const preview = await rows<Record<string, unknown>>(db, backfillPreview());
    assert.deepEqual(
      preview.map((r) => [r.user_id, r.exempt, r.exempt_reason, r.proposed_founding_number, String((r.proposed_billing_anchor as Date).toISOString().slice(0, 10))]),
      [
        [ks, true, "test account (backfill list)", null, "2027-03-22"],
        [admin, true, "admin account", null, "2027-03-22"],
        [real, false, null, 1, "2027-03-22"],
      ]
    );
    await db.exec(backfillApply({ email: TEST_EMAIL, commit: true, expectedNotExempt: 1 }));
    for (const r of preview) {
      const s = await sub(db, r.user_id as string);
      assert.equal(s?.exempt, r.exempt);
      assert.equal(s?.founding_number, r.proposed_founding_number);
    }
    await db.close();
  });

  it("refuses the placeholder, an unknown email, and a not-exempt count that doesn't match; nothing changes", async () => {
    const { db } = await preStep2({ realMerchant: true });
    assert.match(await attempt(db, backfillApply()), /BACKFILL REFUSED: replace the placeholder/);
    assert.match(await attempt(db, backfillApply({ email: "typo@example.com" })), /BACKFILL REFUSED: no account has the email\(s\) typo@example.com/);
    assert.match(
      await attempt(db, backfillApply({ email: TEST_EMAIL, commit: true })),
      /BACKFILL REFUSED: 1 approved cook\(s\) without a subscription are NOT exempt \(1 founding, 0 not founding\), but v_expected_not_exempt is 0/
    );
    assert.equal(await count(db, "select count(*)::int as n from public.merchant_subscriptions"), 0);
    await db.close();
  });

  it("v_commit = false: TEST OK message, nothing kept", async () => {
    const { db } = await preStep2();
    const err = await attempt(db, backfillApply({ email: TEST_EMAIL }));
    assert.match(err, /^TEST OK, rolled back: would create 2 subscription row\(s\): 0 founding, 0 not founding, 2 exempt\./);
    assert.equal(await count(db, "select count(*)::int as n from public.merchant_subscriptions"), 0);
    assert.equal(await count(db, "select count(*)::int as n from public.subscription_events"), 0);
    await db.close();
  });

  it("v_commit = true: KS Bakery exempt, no number, anchor 22 Mar 2027, applied_at = earliest application, approved_at = reviewed_at; re-run creates nothing", async () => {
    const { db, ks, admin } = await preStep2();
    const results = await db.exec(backfillApply({ email: TEST_EMAIL, commit: true }));
    const last = results[results.length - 1].rows[0] as { result: string };
    assert.equal(last.result, "BACKFILL DONE: 2 backfilled row(s) in total, 0 approved cook(s) without a subscription");
    const s = await sub(db, ks);
    assert.equal(s?.exempt, true);
    assert.equal(s?.founding_number, null);
    assert.equal(s?.billing_anchor, "2027-03-22");
    assert.equal(new Date(s!.applied_at).toISOString(), "2026-10-01T02:00:00.000Z", "earliest application (Q-C)");
    assert.equal(new Date(s!.approved_at).toISOString(), "2026-10-06T02:00:00.000Z");
    const [e] = await events(db, ks);
    assert.equal(e.details.source, "backfill");
    assert.equal(e.details.exempt_reason, "test account (backfill list)");
    assert.equal((await sub(db, admin))?.exempt, true);

    const snapshot = await rows(db, "select to_jsonb(s) as r from public.merchant_subscriptions s order by merchant_id");
    const again = await db.exec(backfillApply({ email: TEST_EMAIL, commit: true }));
    assert.equal((again[again.length - 1].rows[0] as { result: string }).result, last.result);
    assert.deepEqual(await rows(db, "select to_jsonb(s) as r from public.merchant_subscriptions s order by merchant_id"), snapshot);
    assert.equal(await count(db, "select count(*)::int as n from public.subscription_events"), 2);

    const verify = await rows<{ exempt: boolean; founding_number: number | null; source: string; missing_after: number }>(db, block(BACKFILL, 3));
    assert.equal(verify.length, 2);
    assert.ok(verify.every((v) => v.exempt && v.founding_number === null && v.source === "backfill" && Number(v.missing_after) === 0));
    await db.close();
  });

  it("Q-E: KS Bakery with no reviewed_at -> the preview flags it and approved_at = the time of the backfill", async () => {
    const { db, ks } = await preStep2({ reviewedAtNull: true });
    const preview = await rows<{ user_id: string; approved_at_note: string }>(db, backfillPreview());
    assert.equal(preview.find((r) => r.user_id === ks)?.approved_at_note, "now() (reviewed_at is empty)");
    await db.exec(backfillApply({ email: TEST_EMAIL, commit: true }));
    const s = await sub(db, ks);
    assert.ok(Math.abs(new Date(s!.approved_at).getTime() - Date.now()) < 60_000);
    await db.close();
  });

  it("with no test emails (array[]::text[]) only the admin is exempt", async () => {
    const { db, ks } = await preStep2();
    await db.exec(backfillApply({ email: null, commit: true, expectedNotExempt: 1 }));
    assert.equal((await sub(db, ks))?.founding_number, 1);
    await db.close();
  });
});

describe("step 2 — live test script, owner delete script, checks, re-run, emergency and undo", () => {
  it("the live DO-block test passes in the harness and leaves nothing behind", async () => {
    const db = await freshDb();
    const tables = ["auth.users", "public.profiles", "public.cook_applications", "public.rider_applications", "public.merchant_subscriptions", "public.subscription_events", "public.subscription_payments"];
    const before = await Promise.all(tables.map((t) => count(db, `select count(*)::int as n from ${t}`)));
    const err = await attempt(db, LIVE_TEST);
    assert.match(err, /^TEST OK, rolled back: founding #1 anchor 2027-03-22, not founding anchor 2027-01-22, re-approve no-op, rider no-op, delete function ok\. Nothing was saved\.$/);
    const afterCounts = await Promise.all(tables.map((t) => count(db, `select count(*)::int as n from ${t}`)));
    assert.deepEqual(afterCounts, before);
    await db.close();
  });

  it("the live test refuses to commit", async () => {
    const db = await freshDb();
    const err = await attempt(db, LIVE_TEST.replace("v_commit boolean := false", "v_commit boolean := true"));
    assert.match(err, /never commits/);
    await db.close();
  });

  it("owner delete script: placeholder and admin refused; test mode rolls back; commit deletes everything but the events", async () => {
    const db = await freshDb();
    const email = "test.merchant@example.com";
    const u = await addUser(db, { email });
    await approve(db, await apply(db, u, "2026-12-01T00:00:00Z"));
    await db.query("insert into public.kitchens (id, business_name) values ($1, 'Test Kitchen')", [u]);
    await db.query("insert into public.menu_items (kitchen_id, name) values ($1, 'Kaya toast'), ($1, 'Kopi')", [u]);
    await db.query("insert into public.orders (kitchen_id) values ($1)", [u]);

    assert.match(await attempt(db, deleteScript()), /DELETE REFUSED: put the test merchant's email/);
    assert.match(await attempt(db, deleteScript({ email: "hq@example.com" })), /is an admin account/);
    const dry = await attempt(db, deleteScript({ email }));
    assert.match(dry, /^TEST OK, rolled back: would delete subscription 1 \(founding # 1, exempt false\), menu_items 2, kitchens 1 \(orders with it: 1\), cook_applications 1, profiles 1, auth user kept\./);
    assert.ok(await sub(db, u), "test mode kept everything");

    const results = await db.exec(deleteScript({ email, commit: true }));
    assert.equal((results[results.length - 1].rows[0] as { result: string }).result, "DELETE SCRIPT FINISHED");
    const verify = await rows<Record<string, number>>(db, block(DELETE_SCRIPT, 2).replace("<paste test merchant email here>", email));
    assert.deepEqual(
      Object.fromEntries(Object.entries(verify[0]).map(([k, v]) => [k, Number(v)])),
      { auth_user_left: 1, profile_left: 0, subscription_left: 0, applications_left: 0, kitchen_left: 0, deleted_events: 1 }
    );
    const [e] = await events(db, u, "subscription_deleted");
    assert.equal(e.details.source, "owner_script");
    assert.equal(e.actor, null);
    await db.close();
  });

  it("owner delete script: refused when a payment exists; v_delete_auth_user removes the login too", async () => {
    const db = await freshDb();
    const paid = await addUser(db, { email: "paid@example.com" });
    await approve(db, await apply(db, paid, "2026-12-01T00:00:00Z"));
    await db.exec("begin; select set_config('kb.billing_write', 'on', true);");
    await db.query("insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference) values ($1, 2995, '2027-03-20', 'PN-1')", [paid]);
    await db.exec("commit");
    assert.match(await attempt(db, deleteScript({ email: "paid@example.com", commit: true })), /DELETE REFUSED: this merchant has 1 payment record/);
    assert.ok(await sub(db, paid));

    const gone = await addUser(db, { email: "gone@example.com" });
    await approve(db, await apply(db, gone, "2026-12-01T00:00:00Z"));
    await db.exec(deleteScript({ email: "gone@example.com", commit: true, deleteAuth: true }));
    assert.equal(await count(db, "select count(*)::int as n from auth.users where id = $1", [gone]), 0);
    await db.close();
  });

  it("the read-only checks give the expected answers", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    await approve(db, await apply(db, u, "2026-12-01T00:00:00Z"));
    assert.equal(CHECKS.length, 6);
    const r: Record<string, unknown>[][] = [];
    for (const sql of CHECKS) r.push(await rows<Record<string, unknown>>(db, sql));
    assert.deepEqual(r[0].map((x) => x.tgname), ["after_cook_application_subscription", "after_cook_application_subscription_insert"]);
    assert.equal(r[1].length, 3);
    assert.ok(r[1].every((x) => x.prosecdef === true));
    assert.deepEqual(r[2], [{ proname: "admin_remove_unpaid_subscription", rolname: "authenticated" }]);
    assert.deepEqual(r[3], [{ has_new_actions: true }]);
    assert.deepEqual(r[4], []);
    assert.equal(Number(r[5][0].duplicates), 0);
    await db.close();
  });

  it("re-running the step-2 file changes nothing (data, functions, triggers, constraint, grants)", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    await approve(db, await apply(db, u, "2026-12-01T00:00:00Z"));
    const snap = async () => ({
      subs: await rows(db, "select to_jsonb(s) as r from public.merchant_subscriptions s order by merchant_id"),
      events: await count(db, "select count(*)::int as n from public.subscription_events"),
      fns: await rows(db, "select proname, prosrc, prosecdef, proconfig, proacl::text from pg_proc where proname in ('billing_create_subscription', 'billing_on_cook_application_approved', 'admin_remove_unpaid_subscription') order by proname"),
      trg: await rows(db, "select tgname, pg_get_triggerdef(oid) as d from pg_trigger where tgrelid = 'public.cook_applications'::regclass and not tgisinternal order by tgname"),
      con: await rows(db, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'subscription_events_action_check'"),
    });
    const first = await snap();
    const results = await db.exec(STEP2);
    assert.equal((results[results.length - 1].rows[0] as { result: string }).result, "STEP 2 INSTALLED");
    assert.deepEqual(await snap(), first);
    await db.close();
  });

  it("the step-2 file refuses to run without step 1", async () => {
    const db = new PGlite();
    await db.exec(HARNESS);
    assert.match(await attempt(db, STEP2), /subscriptions step 2: missing .*merchant_subscriptions.applied_at.*Nothing was changed/);
    await db.exec("rollback"); // the file's own begin; is left aborted (the SQL editor ends it for you)
    assert.equal(await count(db, "select count(*)::int as n from pg_proc where proname = 'billing_create_subscription'"), 0);
    await db.close();
  });

  it("EMERGENCY drops only the triggers: approvals work and show up as missing; re-running step 2 + the backfill repairs it", async () => {
    const db = await freshDb();
    const results = await db.exec(EMERGENCY);
    assert.equal((results[results.length - 1].rows[0] as { result: string }).result, "TRIGGERS DROPPED");
    const u = await addUser(db);
    await approve(db, await apply(db, u, "2026-12-01T00:00:00Z"));
    assert.equal(await sub(db, u), undefined);
    assert.equal((await rows(db, CHECKS[4])).length, 1);
    await db.exec(STEP2);
    await db.exec(backfillApply({ email: null, commit: true, expectedNotExempt: 1 }));
    assert.equal((await sub(db, u))?.founding_number, 1);
    await db.close();
  });

  it("UNDO refuses once a subscription row exists, and works before that", async () => {
    const db = await freshDb();
    const results = await db.exec(UNDO);
    assert.equal((results[results.length - 1].rows[0] as { result: string }).result, "STEP 2 UNDONE");
    assert.equal(await count(db, "select count(*)::int as n from pg_proc where proname in ('billing_create_subscription', 'billing_on_cook_application_approved', 'admin_remove_unpaid_subscription')"), 0);
    assert.equal(await count(db, "select count(*)::int as n from pg_trigger where tgname like 'after_cook_application_subscription%'"), 0);
    await db.exec(STEP2);
    const u = await addUser(db);
    await approve(db, await apply(db, u, "2026-12-01T00:00:00Z"));
    assert.match(await attempt(db, UNDO), /UNDO REFUSED/);
    await db.exec("rollback");
    assert.equal(await count(db, "select count(*)::int as n from pg_trigger where tgname like 'after_cook_application_subscription%'"), 2);
    await db.close();
  });
});

/*
 * Billing OFF (docs/supabase-billing-off.sql): the pilot. Installed on top
 * of step 1 + step 2 with existing rows, it must keep every row, keep both
 * trigger names, and make approvals and approved inserts (the assisted
 * claim path) create no row and no founding number.
 */
async function billingOffDb(): Promise<{ db: PGlite; founding: string; exempt: string }> {
  const db = await freshDb();
  // Rows made while billing was still "on": a founding merchant and an exempt admin-cook.
  const founding = await addUser(db);
  await approve(db, await apply(db, founding, "2026-12-01T00:00:00Z"));
  const exempt = await addUser(db, { role: "admin" });
  await approve(db, await apply(db, exempt, "2026-12-01T00:00:00Z"));
  const results = await db.exec(BILLING_OFF);
  assert.equal((results[results.length - 1].rows[0] as { result: string }).result, "BILLING OFF INSTALLED");
  return { db, founding, exempt };
}
const ALL_OFF = { billing_enabled: false, reminders_inapp_enabled: false, reminders_email_enabled: false, restrictions_enabled: false };
const settings = async (db: PGlite) =>
  (
    await rows<typeof ALL_OFF>(
      db,
      "select billing_enabled, reminders_inapp_enabled, reminders_email_enabled, restrictions_enabled from public.billing_settings"
    )
  )[0];
const maxFounding = (db: PGlite) => count(db, "select coalesce(max(founding_number), 0)::int as n from public.merchant_subscriptions");

describe("billing off — install", () => {
  it("adds billing_enabled boolean NOT NULL DEFAULT false, everything off, and keeps every existing row unchanged", async () => {
    const db = await freshDb();
    const u = await addUser(db);
    await approve(db, await apply(db, u, "2026-12-01T00:00:00Z"));
    const snap = async () => ({
      subs: await rows(db, "select to_jsonb(s) as r from public.merchant_subscriptions s order by merchant_id"),
      events: await rows(db, "select to_jsonb(e) as r from public.subscription_events e order by created_at, id"),
    });
    const first = await snap();
    await db.exec(BILLING_OFF);
    assert.deepEqual(await snap(), first, "no row changed, no event written (the switches were already off)");
    const [col] = await rows<{ data_type: string; is_nullable: string; column_default: string }>(
      db,
      "select data_type, is_nullable, column_default from information_schema.columns where table_name = 'billing_settings' and column_name = 'billing_enabled'"
    );
    assert.deepEqual(col, { data_type: "boolean", is_nullable: "NO", column_default: "false" });
    assert.deepEqual(await settings(db), ALL_OFF);
    await db.close();
  });

  it("keeps both trigger names and drops nothing (same tables, triggers and functions as before)", async () => {
    const db = await freshDb();
    const objects = async () => ({
      tables: await rows(db, "select tablename from pg_tables where schemaname = 'public' order by 1"),
      triggers: await rows(db, "select tgrelid::regclass::text as t, tgname, pg_get_triggerdef(oid) as d from pg_trigger where not tgisinternal order by 1, 2"),
      functions: await rows(db, "select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1"),
    });
    const first = await objects();
    await db.exec(BILLING_OFF);
    assert.deepEqual(await objects(), first);
    await db.close();
  });

  it("switches that were on are turned off and logged once as switch_changed; re-running changes nothing more", async () => {
    const db = await freshDb();
    await db.exec(`begin; select set_config('kb.billing_write', 'on', true);
      update public.billing_settings set reminders_email_enabled = true, restrictions_enabled = true; commit;`);
    await db.exec(BILLING_OFF);
    assert.deepEqual(await settings(db), ALL_OFF);
    const ev = await rows<{ merchant_id: string | null; details: { before: Record<string, boolean>; source: string } }>(
      db,
      "select merchant_id, details from public.subscription_events where action = 'switch_changed'"
    );
    assert.equal(ev.length, 1);
    assert.equal(ev[0].merchant_id, null);
    assert.equal(ev[0].details.source, "supabase-billing-off.sql");
    assert.equal(ev[0].details.before.reminders_email_enabled, true);
    const results = await db.exec(BILLING_OFF);
    assert.equal((results[results.length - 1].rows[0] as { result: string }).result, "BILLING OFF INSTALLED");
    assert.equal(await count(db, "select count(*)::int as n from public.subscription_events where action = 'switch_changed'"), 1);
    await db.close();
  });

  it("re-running the file changes nothing (functions, constraint, settings, data)", async () => {
    const { db } = await billingOffDb();
    const snap = async () => ({
      subs: await rows(db, "select to_jsonb(s) as r from public.merchant_subscriptions s order by merchant_id"),
      events: await count(db, "select count(*)::int as n from public.subscription_events"),
      settings: await rows(db, "select to_jsonb(s) - 'updated_at' as r from public.billing_settings s"),
      fns: await rows(db, "select proname, prosrc, prosecdef, proconfig, proacl::text from pg_proc where proname in ('billing_create_subscription', 'billing_on_cook_application_approved', 'subscription_status') order by proname"),
      con: await rows(db, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'billing_settings_off_means_off'"),
    });
    const first = await snap();
    await db.exec(BILLING_OFF);
    assert.deepEqual(await snap(), first);
    await db.close();
  });

  it("refuses to run without step 2, and nothing changes", async () => {
    const db = await freshDb({ step2: false });
    assert.match(await attempt(db, BILLING_OFF), /billing off: missing .*billing_create_subscription.*Nothing was changed/);
    await db.exec("rollback");
    assert.equal(await count(db, "select count(*)::int as n from information_schema.columns where column_name = 'billing_enabled'"), 0);
    await db.close();
  });

  it("after it, the step-1 and step-2 files refuse to re-run (they would put the old functions back)", async () => {
    const { db } = await billingOffDb();
    assert.match(await attempt(db, STEP1), /subscriptions: billing off is installed.*Nothing was changed/);
    await db.exec("rollback");
    assert.match(await attempt(db, STEP2), /subscriptions step 2: billing off is installed.*Nothing was changed/);
    await db.exec("rollback");
    assert.equal(await count(db, "select count(*)::int as n from pg_proc where proname = 'subscription_status' and prosrc like '%billing_enabled%'"), 1);
    assert.equal(await count(db, "select count(*)::int as n from pg_proc where proname = 'billing_on_cook_application_approved' and prosrc like '%billing_enabled%'"), 1);
    await db.close();
  });

  it("the read-only checks give the expected answers", async () => {
    const { db } = await billingOffDb();
    assert.deepEqual(await rows(db, BILLING_OFF_CHECKS[0]), [ALL_OFF]);
    assert.deepEqual((await rows<{ tgname: string }>(db, BILLING_OFF_CHECKS[1])).map((r) => r.tgname), [
      "after_cook_application_subscription",
      "after_cook_application_subscription_insert",
    ]);
    assert.deepEqual(await rows(db, BILLING_OFF_CHECKS[2]), [{ kept: 2, not_off: 0 }]);
    await db.close();
  });
});

describe("billing off — behaviour", () => {
  let db: PGlite;
  let founding: string;
  let exempt: string;
  before(async () => {
    ({ db, founding, exempt } = await billingOffDb());
  });
  after(() => db.close());

  it("a Boss approval (pending -> approved) makes a cook with NO subscription row, NO founding number and NO event", async () => {
    const u = await addUser(db);
    const maxBefore = await maxFounding(db);
    await approve(db, await apply(db, u, LAST_FOUNDING_MOMENT)); // would have been founding
    assert.equal(await count(db, "select count(*)::int as n from public.profiles where id = $1 and role = 'cook'", [u]), 1);
    assert.equal(await sub(db, u), undefined);
    assert.deepEqual(await events(db, u), []);
    assert.equal(await maxFounding(db), maxBefore);
  });

  it("an application INSERTED already approved (the assisted claim path) makes no row and no founding number", async () => {
    const u = await addUser(db);
    const maxBefore = await maxFounding(db);
    await apply(db, u, "2026-11-01T02:00:00Z", "approved");
    assert.equal(await count(db, "select count(*)::int as n from public.profiles where id = $1 and role = 'cook'", [u]), 1);
    assert.equal(await sub(db, u), undefined);
    assert.equal(await maxFounding(db), maxBefore);
  });

  it("a signed-in admin approving through RLS works the same (no row, no error)", async () => {
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    await db.exec("begin");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ADMIN]);
    await db.exec("set local role authenticated");
    await db.query("update public.cook_applications set status = 'approved', reviewed_at = now() where id = $1", [app]);
    await db.exec("commit");
    assert.equal(await count(db, "select count(*)::int as n from public.cook_applications where id = $1 and status = 'approved'", [app]), 1);
    assert.equal(await sub(db, u), undefined);
  });

  it("billing can't block an approval any more: it goes through even with the settings row missing", async () => {
    // Under step 2 this failed the approval (fail closed). Off: no billing work at all.
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    await db.exec("begin; select set_config('kb.billing_write', 'on', true); delete from public.billing_settings;");
    try {
      await approve(db, app);
      assert.equal(await count(db, "select count(*)::int as n from public.cook_applications where id = $1 and status = 'approved'", [app]), 1);
      assert.equal(await sub(db, u), undefined);
    } finally {
      await db.exec("rollback");
    }
    assert.equal(await count(db, "select count(*)::int as n from public.billing_settings"), 1, "the settings row is back after the rollback");
  });

  it("billing_create_subscription refuses with billing_off (so the backfill can't make rows either)", async () => {
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z", "approved");
    assert.match(await attempt(db, "select public.billing_create_subscription($1, 'backfill')", [app]), /^billing_off: /);
    assert.match(await attempt(db, backfillApply({ email: null, commit: true, expectedNotExempt: 1 })), /billing_off/);
    await db.exec("rollback").catch(() => {});
    assert.equal(await sub(db, u), undefined);
  });

  it("subscription_status is 'off' for every existing row, founding and exempt alike, on any date", async () => {
    for (const day of ["2026-12-01", "2027-03-22", "2027-03-26", "2030-01-01"]) {
      const r = await rows<{ s: string }>(db, "select public.subscription_status(s, $1::date) as s from public.merchant_subscriptions s order by merchant_id", [day]);
      assert.deepEqual(r.map((x) => x.s), ["off", "off"], day);
    }
    assert.ok((await sub(db, founding))?.founding_number, "the old founding row is kept");
    assert.equal((await sub(db, exempt))?.exempt, true, "the old exempt row is kept");
  });

  it("no reminder or restriction switch can go on while billing is off (even as owner with the flag)", async () => {
    for (const col of ["reminders_inapp_enabled", "reminders_email_enabled", "restrictions_enabled"]) {
      const err = await asOwnerWithFlag(db, () => attempt(db, `update public.billing_settings set ${col} = true`));
      assert.match(err, /billing_settings_off_means_off/, col);
    }
  });

  it("browser roles can't flip the switch or run the billing functions", async () => {
    const err = await asUser(db, ADMIN, () => attempt(db, "update public.billing_settings set billing_enabled = true"));
    assert.match(err, /permission denied/);
    for (const fn of [
      "public.billing_create_subscription(uuid, text, boolean, text)",
      "public.billing_on_cook_application_approved()",
      "public.subscription_status(public.merchant_subscriptions, date)",
    ]) {
      assert.equal(await count(db, `select (has_function_privilege('authenticated', '${fn}', 'EXECUTE') or has_function_privilege('anon', '${fn}', 'EXECUTE'))::int as n`), 0, fn);
    }
  });

  it("a signed-in admin reads billing_enabled = false (what the Boss Billing page shows); a merchant reads nothing", async () => {
    assert.deepEqual(await asUser(db, ADMIN, () => rows(db, "select billing_enabled from public.billing_settings where id = true")), [{ billing_enabled: false }]);
    assert.deepEqual(await asUser(db, founding, () => rows(db, "select billing_enabled from public.billing_settings")), []);
  });

  it("the Boss delete flow still works: an old unpaid row is removed; a merchant with no row returns false", async () => {
    const noRow = await addUser(db);
    await approve(db, await apply(db, noRow, "2026-12-01T00:00:00Z"));
    const r = await asUser(db, ADMIN, async () => ({
      old: (await rows<{ r: boolean }>(db, "select public.admin_remove_unpaid_subscription($1, 'test') as r", [founding]))[0].r,
      none: (await rows<{ r: boolean }>(db, "select public.admin_remove_unpaid_subscription($1, 'test') as r", [noRow]))[0].r,
    }));
    assert.deepEqual(r, { old: true, none: false });
  });

  it("the flag is the only thing off: with billing_enabled = true (owner, flag on) the step-2 behaviour comes back", async () => {
    const u = await addUser(db);
    const app = await apply(db, u, "2026-12-01T00:00:00Z");
    const s = await asOwnerWithFlag(db, async () => {
      await db.query("update public.billing_settings set billing_enabled = true");
      await approve(db, app);
      const st = await rows<{ s: string }>(db, "select public.subscription_status(s, '2026-12-01') as s from public.merchant_subscriptions s where merchant_id = $1", [u]);
      return { sub: await sub(db, u), status: st[0]?.s };
    });
    assert.ok(s.sub?.founding_number, "a founding number while on");
    assert.equal(s.status, "free");
    assert.equal(await sub(db, u), undefined, "rolled back: off again");
  });
});

describe("billing off — live test scripts", () => {
  it("the billing-off live test passes and leaves nothing behind", async () => {
    const { db } = await billingOffDb();
    const tables = ["auth.users", "public.profiles", "public.cook_applications", "public.merchant_subscriptions", "public.subscription_events", "public.billing_settings"];
    const before = await Promise.all(tables.map((t) => count(db, `select count(*)::int as n from ${t}`)));
    const err = await attempt(db, BILLING_OFF_LIVE_TEST);
    assert.match(
      err,
      /^TEST OK, rolled back: billing off, approval and approved insert made cook with no subscription row or founding number, 2 existing row\(s\) kept and read off, highest founding number still 1, create refused, switches locked off\. Nothing was saved\.$/
    );
    assert.deepEqual(await Promise.all(tables.map((t) => count(db, `select count(*)::int as n from ${t}`))), before);
    assert.deepEqual(await settings(db), ALL_OFF);
    await db.close();
  });

  it("the billing-off live test fails loudly if billing is somehow on", async () => {
    const { db } = await billingOffDb();
    await db.exec("begin; select set_config('kb.billing_write', 'on', true); update public.billing_settings set billing_enabled = true; commit;");
    assert.match(await attempt(db, BILLING_OFF_LIVE_TEST), /^TEST FAILED: a billing switch is on/);
    await db.close();
  });

  it("the step-2 live test refuses to run while billing is off", async () => {
    const { db } = await billingOffDb();
    assert.match(await attempt(db, LIVE_TEST), /^REFUSED: billing is off \(pilot\)/);
    await db.close();
  });
});
