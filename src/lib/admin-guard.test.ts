import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAdminWith, isAdminWith, NotAdminError } from "./admin-guard.ts";
import { fail, fakeSupabase, ok } from "./testing/fake-supabase.ts";

const ADMIN_USER = { id: "admin-1" };

test("signed out: blocked, and the database role check is never asked", async () => {
  const { client, calls } = fakeSupabase({ "auth.getUser": ok(null) });
  await assert.rejects(assertAdminWith(client), (e: unknown) => e instanceof NotAdminError && /Not signed in/.test(e.message));
  assert.deepEqual(calls.map((c) => c.kind), ["auth"]);
});

test("auth error: blocked", async () => {
  const { client } = fakeSupabase({ "auth.getUser": fail("JWT expired") });
  await assert.rejects(assertAdminWith(client), NotAdminError);
});

test("auth throws: blocked", async () => {
  const { client } = fakeSupabase({});
  (client.auth as unknown as { getUser: () => Promise<never> }).getUser = () => Promise.reject(new Error("network"));
  await assert.rejects(assertAdminWith(client), NotAdminError);
});

test("signed-in non-admin (database says false): blocked", async () => {
  const { client } = fakeSupabase({ "auth.getUser": ok({ id: "cook-1" }), "rpc.user_has_role": ok(false) });
  await assert.rejects(assertAdminWith(client), (e: unknown) => e instanceof NotAdminError && /admins only/.test(e.message));
});

test("role check errors: blocked (fails closed)", async () => {
  const { client } = fakeSupabase({ "auth.getUser": ok(ADMIN_USER), "rpc.user_has_role": fail("function not found") });
  await assert.rejects(assertAdminWith(client), NotAdminError);
});

test("role check returns something other than true: blocked", async () => {
  for (const data of [null, "true", 1, {}]) {
    const { client } = fakeSupabase({ "auth.getUser": ok(ADMIN_USER), "rpc.user_has_role": ok(data) });
    await assert.rejects(assertAdminWith(client), NotAdminError, `data=${JSON.stringify(data)}`);
  }
});

test("admin: allowed, returns the verified user and the same client", async () => {
  const { client, calls } = fakeSupabase({ "auth.getUser": ok(ADMIN_USER), "rpc.user_has_role": ok(true) });
  const result = await assertAdminWith(client);
  assert.equal(result.user.id, "admin-1");
  assert.equal(result.supabase, client);
  const rpc = calls.find((c) => c.kind === "rpc");
  assert.equal(rpc?.name, "user_has_role");
  assert.deepEqual(rpc?.args, { check_role: "admin" });
});

test("the check never reads profiles.role directly", async () => {
  const { client, calls } = fakeSupabase({ "auth.getUser": ok(ADMIN_USER), "rpc.user_has_role": ok(true) });
  await assertAdminWith(client);
  assert.equal(calls.filter((c) => c.kind === "table").length, 0);
});

test("isAdminWith: true only for data === true with no error", async () => {
  assert.equal(await isAdminWith(fakeSupabase({ "rpc.user_has_role": ok(true) }).client), true);
  assert.equal(await isAdminWith(fakeSupabase({ "rpc.user_has_role": ok(false) }).client), false);
  assert.equal(await isAdminWith(fakeSupabase({ "rpc.user_has_role": fail("x") }).client), false);
});
