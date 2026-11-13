import { test } from "node:test";
import assert from "node:assert/strict";
import { approveApplication, setRoleUnlessAdmin } from "./approvals.ts";

type Result = { data: unknown; error: { message: string } | null };
type Call = { table: string; op: "select" | "update"; values?: Record<string, unknown>; eq?: [string, unknown]; neq?: [string, unknown]; returning?: string };

/**
 * Minimal stand-in for the Supabase query builder. Records every query in
 * order and answers each from `respond`, keyed by "table.op".
 */
function fakeSupabase(respond: Record<string, Result>) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: "select" };
      let pushed = false;
      const record = () => {
        if (!pushed) calls.push(call);
        pushed = true;
      };
      const result = () => {
        record();
        return respond[`${table}.${call.op}`] ?? { data: null, error: null };
      };
      const builder = {
        select(columns?: string) {
          if (call.op === "update") call.returning = columns;
          return builder;
        },
        update(values: Record<string, unknown>) {
          call.op = "update";
          call.values = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.eq = [column, value];
          return builder;
        },
        neq(column: string, value: unknown) {
          call.neq = [column, value];
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(result());
        },
        then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { calls, client: client as unknown as Parameters<typeof setRoleUnlessAdmin>[0] };
}

const ok = (data: unknown): Result => ({ data, error: null });
const fail = (message: string): Result => ({ data: null, error: { message } });

const cookArgs = {
  table: "cook_applications" as const,
  role: "cook" as const,
  applicationId: "app-1",
  applicantUserId: "user-1",
  reviewerId: "admin-1",
};

test("approve updates the profile role before marking the application approved", async () => {
  const { calls, client } = fakeSupabase({
    "profiles.select": ok({ role: "customer" }),
    "profiles.update": ok([{ id: "user-1" }]),
  });
  await approveApplication(client, cookArgs);

  assert.deepEqual(
    calls.map((c) => `${c.table}.${c.op}`),
    ["profiles.select", "profiles.update", "cook_applications.update"]
  );
  assert.deepEqual(calls[1].values, { role: "cook" });
  assert.deepEqual(calls[1].eq, ["id", "user-1"]);
  assert.equal(calls[2].values?.status, "approved");
  assert.equal(calls[2].values?.reviewed_by, "admin-1");
  assert.deepEqual(calls[2].eq, ["id", "app-1"]);
});

test("rider approval uses the rider role and rider_applications", async () => {
  const { calls, client } = fakeSupabase({
    "profiles.select": ok({ role: "customer" }),
    "profiles.update": ok([{ id: "user-2" }]),
  });
  await approveApplication(client, {
    table: "rider_applications",
    role: "rider",
    applicationId: "app-2",
    applicantUserId: "user-2",
    reviewerId: "admin-1",
  });
  assert.deepEqual(
    calls.map((c) => `${c.table}.${c.op}`),
    ["profiles.select", "profiles.update", "rider_applications.update"]
  );
  assert.deepEqual(calls[1].values, { role: "rider" });
});

test("a role update error leaves the application untouched (still pending)", async () => {
  const { calls, client } = fakeSupabase({
    "profiles.select": ok({ role: "customer" }),
    "profiles.update": fail("new row violates row-level security policy"),
  });
  await assert.rejects(approveApplication(client, cookArgs), {
    message: "Couldn't update role: new row violates row-level security policy",
  });
  assert.ok(!calls.some((c) => c.table === "cook_applications"));
});

test("no profile row updated throws 'Applicant profile not found.' and skips the status write", async () => {
  for (const data of [[], null]) {
    const { calls, client } = fakeSupabase({
      "profiles.select": ok(null),
      "profiles.update": ok(data),
    });
    await assert.rejects(approveApplication(client, cookArgs), { message: "Applicant profile not found." });
    assert.ok(!calls.some((c) => c.table === "cook_applications"));
  }
});

test("a profile read error stops before any write", async () => {
  const { calls, client } = fakeSupabase({ "profiles.select": fail("boom") });
  await assert.rejects(approveApplication(client, cookArgs), {
    message: "Couldn't check applicant's profile: boom",
  });
  assert.deepEqual(
    calls.map((c) => `${c.table}.${c.op}`),
    ["profiles.select"]
  );
});

test("an admin applicant keeps their role but the application is still approved", async () => {
  const { calls, client } = fakeSupabase({ "profiles.select": ok({ role: "admin" }) });
  await approveApplication(client, cookArgs);
  assert.deepEqual(
    calls.map((c) => `${c.table}.${c.op}`),
    ["profiles.select", "cook_applications.update"]
  );
});

test("an application update error is reported after the role was set", async () => {
  const { client } = fakeSupabase({
    "profiles.select": ok({ role: "customer" }),
    "profiles.update": ok([{ id: "user-1" }]),
    "cook_applications.update": fail("denied"),
  });
  await assert.rejects(approveApplication(client, cookArgs), { message: "Couldn't approve application: denied" });
});

test("the status write only touches a row that isn't approved yet, and returns its id", async () => {
  const { calls, client } = fakeSupabase({
    "profiles.select": ok({ role: "customer" }),
    "profiles.update": ok([{ id: "user-1" }]),
    "cook_applications.update": ok([{ id: "app-1" }]),
  });
  const result = await approveApplication(client, cookArgs);
  assert.deepEqual(result, { justApproved: true });
  assert.deepEqual(calls[2].neq, ["status", "approved"]);
  assert.equal(calls[2].returning, "id");
});

test("approving an already-approved application changes nothing: justApproved is false", async () => {
  for (const data of [[], null]) {
    const { client } = fakeSupabase({
      "profiles.select": ok({ role: "cook" }),
      "profiles.update": ok([{ id: "user-1" }]),
      "cook_applications.update": ok(data),
    });
    assert.deepEqual(await approveApplication(client, cookArgs), { justApproved: false });
  }
});
