import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * docs/supabase-subscriptions.sql (subscriptions step 1), run for real in
 * PGlite with the anon / authenticated roles, a fake auth.uid(), a minimal
 * profiles table and the real user_has_role() (copied from the Partner
 * schema, docs/supabase-schema.sql). Same pattern as the Partner repo's
 * src/lib/kitchen-privacy-sql.test.ts.
 */

// Normalised to \n so the section markers below match on a Windows checkout.
const SQL = readFileSync(new URL("../../docs/supabase-subscriptions.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`section not found: ${start}`);
  return text.slice(a + start.length, b);
}

/** The read-only check queries at the end of the file, uncommented (numbered 1–6). */
const CHECKS = between(SQL, "-- CHECKS AFTERWARDS", "-- UNDO")
  .split("\n")
  .filter((l) => /^-- select /.test(l))
  .map((l) => l.replace(/^-- /, ""));

/** The commented undo block, uncommented. */
const UNDO = between(SQL, "-- UNDO-BEGIN", "-- UNDO-END")
  .split("\n")
  .filter((l) => l.startsWith("-- "))
  .map((l) => l.slice(3))
  .join("\n");

const TABLES = [
  "billing_settings",
  "merchant_subscriptions",
  "subscription_payments",
  "subscription_reminders",
  "subscription_events",
  "billing_job_runs",
] as const;
const FUNCTIONS = ["sgt_date", "sgt_today", "billing_write_guard", "billing_touch_updated_at", "subscription_status"];

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COOK_A = id(1);
const COOK_B = id(2);
const COOK_C = id(3); // no payments: deletable once its subscription row goes
const ADMIN = id(400);
const CUSTOMER = id(500);

/** Real user_has_role() from the Partner schema (section 1). */
const USER_HAS_ROLE = `
create or replace function public.user_has_role(check_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = check_role
  );
$$;`;

const schema = (withUserHasRole = true) => `
create role anon;
create role authenticated;
create schema auth;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;

create table public.profiles (
  id uuid primary key,
  role text not null default 'customer',
  is_active boolean not null default true
);
${withUserHasRole ? USER_HAS_ROLE : ""}

insert into public.profiles (id, role) values
  ('${COOK_A}', 'cook'), ('${COOK_B}', 'cook'), ('${COOK_C}', 'cook'),
  ('${ADMIN}', 'admin'), ('${CUSTOMER}', 'customer');
`;

/** Billing rows, written the only way allowed: as the owner with the flag on. */
const SEED = `
begin;
select set_config('kb.billing_write', 'on', true);
insert into public.merchant_subscriptions (merchant_id, approved_at, founding_number, billing_anchor) values
  ('${COOK_A}', '2026-11-01T02:00:00Z', 1, '2027-03-22'),
  ('${COOK_B}', '2026-12-10T02:00:00Z', null, '2027-01-22'),
  ('${COOK_C}', '2026-12-11T02:00:00Z', null, '2027-01-22');
insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference, recorded_by) values
  ('${COOK_A}', 2995, '2027-03-20', 'PN-A-1', '${ADMIN}'),
  ('${COOK_B}', 2995, '2027-01-20', 'PN-B-1', '${ADMIN}');
insert into public.subscription_reminders (merchant_id, due_date, kind, channel, status) values
  ('${COOK_A}', '2027-03-22', 'due_in_7', 'inapp', 'dry_run'),
  ('${COOK_B}', '2027-01-22', 'due_in_7', 'email', 'queued');
insert into public.subscription_events (merchant_id, actor, action) values
  ('${COOK_A}', null, 'founding_assigned'),
  ('${COOK_B}', '${ADMIN}', 'payment_recorded');
insert into public.billing_job_runs (as_of, mode, counts) values ('2027-03-15', 'dry_run', '{"would_remind": 1}');
commit;
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(schema());
  await db.exec(SQL);
  await db.exec(SEED);
  return db;
}

/** Runs fn as `role` / signed-in `uid`, inside a transaction that's always rolled back. */
async function as<T>(db: PGlite, role: "anon" | "authenticated", uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? ""]);
    await db.exec(`set local role ${role}`);
    return await fn();
  } finally {
    await db.exec("rollback");
  }
}

/** Runs fn as the table owner (bypasses grants and RLS, not triggers), optionally with the flag, always rolled back. */
async function owner<T>(db: PGlite, withFlag: boolean, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    if (withFlag) await db.query("select set_config('kb.billing_write', 'on', true)");
    return await fn();
  } finally {
    await db.exec("rollback");
  }
}

/** The error message, or "" if the statement worked. */
async function attempt(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

/** One write per table, for the "nobody but the billing functions" checks. */
const WRITES: Record<(typeof TABLES)[number], string[]> = {
  billing_settings: [
    "insert into public.billing_settings (id) values (true)",
    "update public.billing_settings set restrictions_enabled = true",
    "delete from public.billing_settings",
  ],
  merchant_subscriptions: [
    `insert into public.merchant_subscriptions (merchant_id, approved_at, billing_anchor) values ('${CUSTOMER}', now(), '2027-01-22')`,
    `update public.merchant_subscriptions set months_paid = 12 where merchant_id = '${COOK_A}'`,
    `delete from public.merchant_subscriptions where merchant_id = '${COOK_A}'`,
  ],
  subscription_payments: [
    `insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference) values ('${COOK_A}', 2995, '2027-03-21', 'SELF')`,
    `update public.subscription_payments set amount_cents = 1 where merchant_id = '${COOK_A}'`,
    `delete from public.subscription_payments where merchant_id = '${COOK_A}'`,
  ],
  subscription_reminders: [
    `insert into public.subscription_reminders (merchant_id, due_date, kind, channel, status) values ('${COOK_A}', '2027-03-22', 'due_today', 'inapp', 'queued')`,
    "update public.subscription_reminders set status = 'sent'",
    "delete from public.subscription_reminders",
  ],
  subscription_events: [
    `insert into public.subscription_events (merchant_id, action) values ('${COOK_A}', 'waived')`,
    "update public.subscription_events set action = 'waived'",
    "delete from public.subscription_events",
  ],
  billing_job_runs: [
    "insert into public.billing_job_runs (as_of, mode) values ('2027-03-22', 'live')",
    "update public.billing_job_runs set error = 'x'",
    "delete from public.billing_job_runs",
  ],
};

describe("subscriptions SQL — prerequisites", () => {
  it("stops before changing anything when user_has_role() is missing", async () => {
    const db = new PGlite();
    await db.exec(schema(false));
    let message = "";
    try {
      await db.exec(SQL);
    } catch (e) {
      message = (e as Error).message;
    }
    await db.exec("rollback");
    assert.match(message, /subscriptions: missing public\.user_has_role\(text\)\. Nothing was changed\./);
    const [{ t }] = await rows<{ t: string | null }>(db, "select to_regclass('public.billing_settings')::text as t");
    assert.equal(t, null);
    const [{ f }] = await rows<{ f: string | null }>(db, "select to_regprocedure('public.sgt_today()')::text as f");
    assert.equal(f, null);
    await db.close();
  });
});

describe("subscriptions SQL — settings, grants, RLS and the lock", () => {
  let db: PGlite;
  before(async () => {
    db = await freshDb();
  });
  after(() => db.close());

  it("creates one settings row with every switch OFF and the agreed price and payee", async () => {
    const settings = await rows<Record<string, unknown>>(
      db,
      `select reminders_inapp_enabled, reminders_email_enabled, restrictions_enabled,
              launch_date::text, founding_free_until::text, founding_limit, grace_days,
              price_cents, payee_name, payee_uen
       from public.billing_settings`
    );
    assert.deepEqual(settings, [
      {
        reminders_inapp_enabled: false,
        reminders_email_enabled: false,
        restrictions_enabled: false,
        launch_date: "2026-12-22",
        founding_free_until: "2027-03-22",
        founding_limit: 100,
        grace_days: 3,
        price_cents: 2995,
        payee_name: "KOPIE BOY",
        payee_uen: "53535194A",
      },
    ]);
  });

  it("merchant A reads only their own subscription and payments, never merchant B's", async () => {
    const subs = await as(db, "authenticated", COOK_A, () => rows<{ merchant_id: string }>(db, "select merchant_id from public.merchant_subscriptions"));
    assert.deepEqual(subs.map((r) => r.merchant_id), [COOK_A]);
    const pays = await as(db, "authenticated", COOK_A, () => rows<{ reference: string }>(db, "select reference from public.subscription_payments"));
    assert.deepEqual(pays.map((r) => r.reference), ["PN-A-1"]);
    const bSub = await as(db, "authenticated", COOK_A, () =>
      rows(db, "select * from public.merchant_subscriptions where merchant_id = $1", [COOK_B])
    );
    assert.equal(bSub.length, 0);
    const bPay = await as(db, "authenticated", COOK_A, () =>
      rows(db, "select * from public.subscription_payments where merchant_id = $1", [COOK_B])
    );
    assert.equal(bPay.length, 0);
  });

  it("a merchant sees nothing in the admin-only tables", async () => {
    for (const table of ["billing_settings", "subscription_reminders", "subscription_events", "billing_job_runs"]) {
      const found = await as(db, "authenticated", COOK_A, () => rows(db, `select * from public.${table}`));
      assert.equal(found.length, 0, table);
    }
  });

  it("a signed-in customer sees nothing in any billing table", async () => {
    for (const table of TABLES) {
      const found = await as(db, "authenticated", CUSTOMER, () => rows(db, `select * from public.${table}`));
      assert.equal(found.length, 0, table);
    }
  });

  it("a merchant can't insert, update or delete any billing table, even their own rows", async () => {
    for (const table of TABLES) {
      for (const sql of WRITES[table]) {
        const error = await as(db, "authenticated", COOK_A, () => attempt(db, sql));
        assert.match(error, /permission denied/, `${table}: ${sql}`);
      }
    }
  });

  it("…and setting the kb.billing_write flag themselves doesn't help (no write grant)", async () => {
    for (const table of TABLES) {
      for (const sql of WRITES[table]) {
        const error = await as(db, "authenticated", COOK_A, async () => {
          await db.query("select set_config('kb.billing_write', 'on', true)");
          return attempt(db, sql);
        });
        assert.match(error, /permission denied/, `${table}: ${sql}`);
      }
    }
  });

  it("anon gets nothing: every read and write is refused", async () => {
    for (const table of TABLES) {
      const read = await as(db, "anon", null, () => attempt(db, `select * from public.${table}`));
      assert.match(read, /permission denied/, table);
      for (const sql of WRITES[table]) {
        const error = await as(db, "anon", null, () => attempt(db, sql));
        assert.match(error, /permission denied/, `${table}: ${sql}`);
      }
    }
  });

  it("admins can read every row of every billing table", async () => {
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      const found = await as(db, "authenticated", ADMIN, () => rows(db, `select * from public.${table}`));
      counts[table] = found.length;
    }
    assert.deepEqual(counts, {
      billing_settings: 1,
      merchant_subscriptions: 3,
      subscription_payments: 2,
      subscription_reminders: 2,
      subscription_events: 2,
      billing_job_runs: 1,
    });
  });

  it("admins can't write directly either (only the future billing functions can)", async () => {
    for (const table of TABLES) {
      for (const sql of WRITES[table]) {
        const error = await as(db, "authenticated", ADMIN, () => attempt(db, sql));
        assert.match(error, /permission denied/, `${table}: ${sql}`);
      }
    }
  });

  it("no browser role can run the new functions", async () => {
    const calls = [
      "select public.sgt_today()",
      "select public.sgt_date(now())",
      "select public.subscription_status(s, '2027-03-22') from public.merchant_subscriptions s",
    ];
    for (const sql of calls) {
      for (const [role, uid] of [["anon", null], ["authenticated", COOK_A], ["authenticated", ADMIN]] as const) {
        const error = await as(db, role, uid, () => attempt(db, sql));
        assert.match(error, /permission denied/, `${role} ${uid}: ${sql}`);
      }
    }
  });

  it("the lock trigger rejects every write without the flag, even from the table owner", async () => {
    for (const table of TABLES) {
      for (const sql of WRITES[table]) {
        const error = await owner(db, false, () => attempt(db, sql));
        assert.match(error, /billing_write_locked|billing_append_only/, `${table}: ${sql}`);
      }
      const truncate = await owner(db, false, () => attempt(db, `truncate public.${table} cascade`));
      assert.match(truncate, /billing_write_locked|billing_append_only/, `truncate ${table}`);
    }
  });

  it("with the flag on, the owner can write, and updated_at moves", async () => {
    // now() is this transaction's start time; the seed ran in an earlier one.
    const result = await owner(db, true, async () => {
      const [before] = await rows<{ fresh: boolean }>(db, "select updated_at = now() as fresh from public.merchant_subscriptions where merchant_id = $1", [COOK_A]);
      const [after] = await rows<{ months_paid: number; fresh: boolean }>(
        db,
        `update public.merchant_subscriptions set months_paid = 1 where merchant_id = $1
         returning months_paid, updated_at = now() as fresh`,
        [COOK_A]
      );
      return { before: before.fresh, after };
    });
    assert.equal(result.before, false);
    assert.deepEqual(result.after, { months_paid: 1, fresh: true });
  });

  it("the flag is transaction-local: the next transaction is locked again", async () => {
    await db.exec("begin; select set_config('kb.billing_write', 'on', true); commit;");
    const error = await attempt(db, "insert into public.billing_job_runs (as_of, mode) values ('2027-03-22', 'live')");
    assert.match(error, /billing_write_locked/);
  });

  it("payments are append-only: void once, never edit, delete or un-void (flag on)", async () => {
    const voided = await owner(db, true, () =>
      rows<{ voided: boolean }>(
        db,
        `update public.subscription_payments set voided_at = now(), voided_by = $1, void_reason = 'typo'
         where reference = 'PN-A-1' returning voided_at is not null as voided`,
        [ADMIN]
      )
    );
    assert.deepEqual(voided, [{ voided: true }]);

    const edit = await owner(db, true, () => attempt(db, "update public.subscription_payments set amount_cents = 1 where reference = 'PN-A-1'"));
    assert.match(edit, /billing_append_only: only the void fields/);

    const del = await owner(db, true, () => attempt(db, "delete from public.subscription_payments where reference = 'PN-A-1'"));
    assert.match(del, /billing_append_only: payments are voided, never deleted/);

    const unvoid = await owner(db, true, async () => {
      await db.query("update public.subscription_payments set voided_at = now(), voided_by = $1, void_reason = 'typo' where reference = 'PN-A-1'", [ADMIN]);
      return attempt(db, "update public.subscription_payments set voided_at = null, voided_by = null, void_reason = null where reference = 'PN-A-1'");
    });
    assert.match(unvoid, /billing_append_only: a voided payment never changes/);

    const noReason = await owner(db, true, () =>
      attempt(db, "update public.subscription_payments set voided_at = now() where reference = 'PN-A-1'")
    );
    assert.match(noReason, /check constraint/);
  });

  it("events are append-only even with the flag on", async () => {
    const update = await owner(db, true, () => attempt(db, "update public.subscription_events set action = 'waived'"));
    assert.match(update, /billing_append_only/);
    const del = await owner(db, true, () => attempt(db, "delete from public.subscription_events"));
    assert.match(del, /billing_append_only/);
    const insert = await owner(db, true, () =>
      attempt(db, "insert into public.subscription_events (merchant_id, action) values ($1, 'waived')", [COOK_A])
    );
    assert.equal(insert, "");
  });

  it("a payment reference can't be used twice (case and spaces ignored) until the first is voided", async () => {
    const dup = await owner(db, true, () =>
      attempt(db, "insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference) values ($1, 2995, '2027-04-20', ' pn-a-1 ')", [COOK_A])
    );
    assert.match(dup, /duplicate key|unique/);
    const afterVoid = await owner(db, true, async () => {
      await db.query("update public.subscription_payments set voided_at = now(), void_reason = 'wrong merchant' where reference = 'PN-A-1'");
      return attempt(db, "insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference) values ($1, 2995, '2027-04-20', 'PN-A-1')", [COOK_A]);
    });
    assert.equal(afterVoid, "");
  });

  it("a payment covers 1 to 12 months only", async () => {
    const thirteen = await owner(db, true, () =>
      attempt(db, "insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference, months) values ($1, 2995, '2027-04-20', 'PN-13', 13)", [COOK_A])
    );
    assert.match(thirteen, /check constraint/);
    const twelve = await owner(db, true, () =>
      attempt(db, "insert into public.subscription_payments (merchant_id, amount_cents, paid_on, reference, months) values ($1, 35940, '2027-04-20', 'PN-12', 12)", [COOK_A])
    );
    assert.equal(twelve, "");
  });

  it("each reminder is logged at most once per due date and channel (dry runs don't count)", async () => {
    const dup = await owner(db, true, () =>
      attempt(db, "insert into public.subscription_reminders (merchant_id, due_date, kind, channel, status) values ($1, '2027-01-22', 'due_in_7', 'email', 'sent')", [COOK_B])
    );
    assert.match(dup, /duplicate key|unique/);
    const dryRuns = await owner(db, true, () =>
      attempt(
        db,
        "insert into public.subscription_reminders (merchant_id, due_date, kind, channel, status) values ($1, '2027-03-22', 'due_in_7', 'inapp', 'dry_run'), ($1, '2027-03-22', 'due_in_7', 'inapp', 'dry_run')",
        [COOK_A]
      )
    );
    assert.equal(dryRuns, "");
  });

  it("founding numbers are unique and 1–100 only", async () => {
    const dup = await owner(db, true, () => attempt(db, "update public.merchant_subscriptions set founding_number = 1 where merchant_id = $1", [COOK_B]));
    assert.match(dup, /duplicate key|unique/);
    const over = await owner(db, true, () => attempt(db, "update public.merchant_subscriptions set founding_number = 101 where merchant_id = $1", [COOK_B]));
    assert.match(over, /check constraint/);
    const [b] = await rows<{ is_founding: boolean }>(db, "select is_founding from public.merchant_subscriptions where merchant_id = $1", [COOK_B]);
    assert.equal(b.is_founding, false);
    const [a] = await rows<{ is_founding: boolean }>(db, "select is_founding from public.merchant_subscriptions where merchant_id = $1", [COOK_A]);
    assert.equal(a.is_founding, true);
  });

  it("there is only ever one settings row", async () => {
    const second = await owner(db, true, () => attempt(db, "insert into public.billing_settings (id) values (false)"));
    assert.match(second, /check constraint/);
  });

  it("a merchant with payment records can't be deleted", async () => {
    const error = await owner(db, true, () => attempt(db, "delete from public.profiles where id = $1", [COOK_A]));
    assert.match(error, /foreign key/);
    const subRow = await owner(db, true, () => attempt(db, "delete from public.merchant_subscriptions where merchant_id = $1", [COOK_A]));
    assert.match(subRow, /foreign key/);
  });

  it("a merchant with no payments can be deleted once its subscription row is removed first", async () => {
    const blocked = await owner(db, true, () => attempt(db, "delete from public.profiles where id = $1", [COOK_C]));
    assert.match(blocked, /foreign key/);
    const deleted = await owner(db, true, async () => {
      await db.query("delete from public.merchant_subscriptions where merchant_id = $1", [COOK_C]);
      await db.query("delete from public.profiles where id = $1", [COOK_C]);
      return rows(db, "select id from public.profiles where id = $1", [COOK_C]);
    });
    assert.equal(deleted.length, 0);
  });
});

describe("subscriptions SQL — dates (fake clock)", () => {
  let db: PGlite;
  before(async () => {
    db = await freshDb();
  });
  after(() => db.close());

  /** subscription_status for one merchant on each date, as the owner. */
  const statuses = (merchantId: string, dates: string[]) =>
    rows<{ d: string; status: string }>(
      db,
      `select d::text, public.subscription_status(s, d) as status
       from public.merchant_subscriptions s, unnest($1::date[]) as d
       where s.merchant_id = $2 order by d`,
      [dates, merchantId]
    ).then((r) => Object.fromEntries(r.map((x) => [x.d, x.status])));

  it("founding merchant due 22 Mar 2027: 21 Mar due soon, 22 due today, 25 last grace day, 26 overdue", async () => {
    assert.deepEqual(await statuses(COOK_A, ["2027-03-14", "2027-03-15", "2027-03-21", "2027-03-22", "2027-03-23", "2027-03-25", "2027-03-26"]), {
      "2027-03-14": "free",
      "2027-03-15": "due_soon",
      "2027-03-21": "due_soon",
      "2027-03-22": "due_today",
      "2027-03-23": "grace",
      "2027-03-25": "grace",
      "2027-03-26": "overdue",
    });
  });

  it("after a month is paid it's 'active', and the next due date is 22 Apr", async () => {
    const result = await owner(db, true, async () => {
      const [row] = await rows<{ due: string }>(db, "update public.merchant_subscriptions set months_paid = 1 where merchant_id = $1 returning due_date::text as due", [COOK_A]);
      return { due: row.due, statuses: await statuses(COOK_A, ["2027-03-26", "2027-04-14", "2027-04-15", "2027-04-22", "2027-04-26"]) };
    });
    assert.equal(result.due, "2027-04-22");
    assert.deepEqual(result.statuses, {
      "2027-03-26": "active",
      "2027-04-14": "active",
      "2027-04-15": "due_soon",
      "2027-04-22": "due_today",
      "2027-04-26": "overdue",
    });
  });

  it("a late payment counts from the old due date, and one payment can cover several months", async () => {
    // Paid on 25 Mar (grace) for 1 month: next due is 22 Apr, not 25 Apr.
    const late = await owner(db, true, () =>
      rows<{ due: string }>(db, "update public.merchant_subscriptions set months_paid = 1 where merchant_id = $1 returning due_date::text as due", [COOK_A])
    );
    assert.deepEqual(late, [{ due: "2027-04-22" }]);
    // Paid 3 months at once.
    const three = await owner(db, true, () =>
      rows<{ due: string }>(db, "update public.merchant_subscriptions set months_paid = 3 where merchant_id = $1 returning due_date::text as due", [COOK_A])
    );
    assert.deepEqual(three, [{ due: "2027-06-22" }]);
  });

  it("exempt and waived come first", async () => {
    const exempt = await owner(db, true, async () => {
      await db.query("update public.merchant_subscriptions set exempt = true where merchant_id = $1", [COOK_A]);
      return statuses(COOK_A, ["2027-03-14", "2027-03-26"]);
    });
    assert.deepEqual(exempt, { "2027-03-14": "exempt", "2027-03-26": "exempt" });

    const waived = await owner(db, true, async () => {
      await db.query("update public.merchant_subscriptions set waived_until = '2027-04-01' where merchant_id = $1", [COOK_A]);
      return statuses(COOK_A, ["2027-03-26", "2027-03-31", "2027-04-01"]);
    });
    assert.deepEqual(waived, { "2027-03-26": "waived", "2027-03-31": "waived", "2027-04-01": "overdue" });
  });

  it("grace length comes from billing_settings", async () => {
    const result = await owner(db, true, async () => {
      await db.query("update public.billing_settings set grace_days = 5");
      return statuses(COOK_A, ["2027-03-27", "2027-03-28"]);
    });
    assert.deepEqual(result, { "2027-03-27": "grace", "2027-03-28": "overdue" });
  });

  /** due_date for an anchor after each number of paid months. */
  const dueDates = (anchor: string, months: number[]) =>
    owner(db, true, async () => {
      await db.query("update public.merchant_subscriptions set billing_anchor = $1 where merchant_id = $2", [anchor, COOK_C]);
      const out: string[] = [];
      for (const m of months) {
        const [row] = await rows<{ due: string }>(db, "update public.merchant_subscriptions set months_paid = $1 where merchant_id = $2 returning due_date::text as due", [m, COOK_C]);
        out.push(row.due);
      }
      return out;
    });

  it("anchor maths: 31 Jan -> 28 Feb -> 31 Mar -> 30 Apr, no drift", async () => {
    assert.deepEqual(await dueDates("2027-01-31", [0, 1, 2, 3, 12]), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2028-01-31"]);
  });

  it("anchor maths in the 2028 leap year: 31 Jan -> 29 Feb -> 31 Mar; 29 Feb -> 28 Feb 2029 -> 29 Feb 2032", async () => {
    assert.deepEqual(await dueDates("2028-01-31", [1, 2]), ["2028-02-29", "2028-03-31"]);
    assert.deepEqual(await dueDates("2028-02-29", [0, 1, 12, 48]), ["2028-02-29", "2028-03-29", "2029-02-28", "2032-02-29"]);
  });

  it("the status uses the same anchor maths (due 28 Feb after one month from 31 Jan)", async () => {
    const result = await owner(db, true, async () => {
      await db.query("update public.merchant_subscriptions set billing_anchor = '2027-01-31', months_paid = 1 where merchant_id = $1", [COOK_C]);
      return statuses(COOK_C, ["2027-02-27", "2027-02-28", "2027-03-03", "2027-03-04"]);
    });
    assert.deepEqual(result, { "2027-02-27": "due_soon", "2027-02-28": "due_today", "2027-03-03": "grace", "2027-03-04": "overdue" });
  });

  it("sgt_date: 15:59:59 UTC is still the same Singapore day, 16:00 UTC is the next", async () => {
    const [r] = await rows<{ before: string; at: string }>(
      db,
      "select public.sgt_date('2027-03-21T15:59:59Z')::text as before, public.sgt_date('2027-03-21T16:00:00Z')::text as at"
    );
    assert.deepEqual(r, { before: "2027-03-21", at: "2027-03-22" });
  });

  it("sgt_today() is today's date in Singapore", async () => {
    const [r] = await rows<{ same: boolean }>(db, "select public.sgt_today() = (now() at time zone 'Asia/Singapore')::date as same");
    assert.equal(r.same, true);
  });
});

/** Everything the file defines, for the "re-run changes nothing" check. */
async function snapshot(db: PGlite) {
  const list = TABLES.map((t) => `'${t}'`).join(", ");
  const fnList = FUNCTIONS.map((f) => `'${f}'`).join(", ");
  const data: Record<string, unknown> = {};
  for (const table of TABLES) {
    data[table] = await rows(db, `select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`);
  }
  return {
    data,
    grants: await rows(db, `select table_name, grantee, privilege_type from information_schema.table_privileges where table_schema = 'public' and table_name in (${list}) order by 1, 2, 3`),
    policies: await rows(db, `select tablename, policyname, cmd, roles::text, qual from pg_policies where tablename in (${list}) order by 1, 2`),
    rls: await rows(db, `select relname, relrowsecurity from pg_class where relname in (${list}) order by 1`),
    functions: await rows(db, `select p.proname, pg_get_functiondef(p.oid) as def, p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in (${fnList}) order by 1`),
    triggers: await rows(db, `select event_object_table, trigger_name, event_manipulation, action_timing, action_statement from information_schema.triggers where trigger_schema = 'public' and event_object_table in (${list}) order by 1, 2, 3`),
    truncateTriggers: await rows(db, `select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in (${list}) and not t.tgisinternal order by 1, 2`),
    indexes: await rows(db, `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in (${list}) order by 1, 2`),
    columns: await rows(db, `select table_name, column_name, data_type, column_default, is_nullable, generation_expression from information_schema.columns where table_schema = 'public' and table_name in (${list}) order by 1, 2`),
  };
}

describe("subscriptions SQL — re-runs, checks and undo", () => {
  it("re-running the file changes nothing (data, grants, policies, functions, triggers, indexes)", async () => {
    const db = await freshDb();
    const first = await snapshot(db);
    await db.exec(SQL);
    const second = await snapshot(db);
    assert.deepEqual(second, first);
    await db.close();
  });

  it("re-running never resets a switch someone turned on", async () => {
    const db = await freshDb();
    await db.exec("begin; select set_config('kb.billing_write', 'on', true); update public.billing_settings set reminders_inapp_enabled = true; commit;");
    await db.exec(SQL);
    const [r] = await rows<{ on: boolean }>(db, "select reminders_inapp_enabled as on from public.billing_settings");
    assert.equal(r.on, true);
    await db.close();
  });

  it("the read-only checks at the end of the file give the expected answers", async () => {
    const db = await freshDb();
    assert.equal(CHECKS.length, 6);
    const results: Record<string, unknown>[][] = [];
    for (const sql of CHECKS) results.push(await rows<Record<string, unknown>>(db, sql));

    // PGlite returns a date column as a JS Date at UTC midnight.
    const { founding_free_until, ...settings } = results[0][0];
    assert.deepEqual(settings, {
      reminders_inapp_enabled: false,
      reminders_email_enabled: false,
      restrictions_enabled: false,
      price_cents: 2995,
      payee_name: "KOPIE BOY",
      payee_uen: "53535194A",
      grace_days: 3,
    });
    assert.equal((founding_free_until as Date).toISOString().slice(0, 10), "2027-03-22");
    assert.equal(results[0].length, 1);
    assert.deepEqual(
      results[1].map((r) => `${r.table_name}/${r.grantee}/${r.privilege_type}`),
      [...TABLES].sort().map((t) => `${t}/authenticated/SELECT`)
    );
    assert.deepEqual(results[2].map((r) => r.relrowsecurity), [true, true, true, true, true, true]);
    assert.deepEqual(results[3], []);
    assert.deepEqual(results[4].map((r) => r.event_object_table), [...TABLES].sort());
    assert.equal(results[5].length, 1);
    await db.close();
  });

  it("the undo block removes everything, and the file then applies cleanly again", async () => {
    const db = new PGlite();
    await db.exec(schema());
    await db.exec(SQL);
    await db.exec(UNDO);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in (${TABLES.map((t) => `'${t}'`).join(", ")})`
    );
    assert.equal(n, 0);
    const [{ f }] = await rows<{ f: number }>(
      db,
      `select count(*)::int as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in (${FUNCTIONS.map((x) => `'${x}'`).join(", ")})`
    );
    assert.equal(f, 0);
    await db.exec(SQL);
    const [{ s }] = await rows<{ s: number }>(db, "select count(*)::int as s from public.billing_settings");
    assert.equal(s, 1);
    await db.close();
  });
});
