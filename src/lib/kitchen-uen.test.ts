import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeSupabase, fail, ok } from "./testing/fake-supabase.ts";
import { kitchenUenStatusWith, setKitchenBusinessUenWith } from "./kitchen-uen.ts";
import { BUSINESS_UEN_PATTERN, normalizeBusinessUen } from "./business-uen.ts";

const KITCHEN = "24fd6ea3-abd2-4e0a-a8de-83e725a1351e";
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the UEN pattern is the database's", () => {
  for (const good of ["53123456A", "201912345K", "T09LL0001B", "S12AB3456C", "R98ZZ0000Z"]) assert.ok(BUSINESS_UEN_PATTERN.test(good), good);
  for (const bad of ["12345", "5312345A", "53123456", "X09LL0001B", "53123456a", " 53123456A"]) assert.ok(!BUSINESS_UEN_PATTERN.test(bad), bad);
  assert.equal(normalizeBusinessUen(" 53123456a "), "53123456A");
  assert.equal(normalizeBusinessUen(7), "");
  const sql = readFileSync(new URL("../../docs/supabase-assisted-uen-later.sql", import.meta.url), "utf8");
  assert.ok(sql.includes(`'${BUSINESS_UEN_PATTERN.source}'`), "same pattern as admin_set_kitchen_business_uen");
});

test("status: decided by the latest approved application, not the kitchen's category", async () => {
  const status = (kitchen: unknown, app: unknown) =>
    kitchenUenStatusWith(fakeSupabase({ "kitchens.select": ok(kitchen), "cook_applications.select": ok(app) }).client, KITCHEN);

  assert.deepEqual(await status({ id: KITCHEN, business_uen: "53123456A" }, { business_type: "Hawker" }), {
    state: "set",
    uen: "53123456A",
    applicationType: "Hawker",
  });
  assert.deepEqual(await status({ id: KITCHEN, business_uen: null }, { business_type: "Bakery" }), { state: "pending", applicationType: "Bakery" });
  assert.deepEqual(await status({ id: KITCHEN, business_uen: null }, { business_type: "Home Cook" }), { state: "not-needed", reason: "home-cook" });
  assert.deepEqual(await status({ id: KITCHEN, business_uen: null }, null), { state: "not-needed", reason: "no-application" });

  const { client, calls } = fakeSupabase({});
  await kitchenUenStatusWith(client, KITCHEN);
  const app = calls.find((c) => c.name === "cook_applications")!;
  assert.equal(app.columns, "business_type");
  assert.deepEqual(app.filters, [["user_id", KITCHEN], ["status", "approved"], ["limit", 1]]);
  assert.deepEqual(app.order, ["reviewed_at", "created_at"]);
  assert.equal(calls.find((c) => c.name === "kitchens")!.columns, "id, business_uen");
});

test("status: unknown when it can't be read, or for a bad id (no call)", async () => {
  const k = fakeSupabase({ "kitchens.select": fail("boom") });
  assert.deepEqual(await kitchenUenStatusWith(k.client, KITCHEN), { state: "unknown", message: "boom" });
  const a = fakeSupabase({ "kitchens.select": ok({ id: KITCHEN, business_uen: null }), "cook_applications.select": fail("nope") });
  assert.deepEqual(await kitchenUenStatusWith(a.client, KITCHEN), { state: "unknown", message: "nope" });
  const bad = fakeSupabase({});
  assert.equal((await kitchenUenStatusWith(bad.client, "x")).state, "unknown");
  assert.equal(bad.calls.length, 0);
});

test("set: one admin_set_kitchen_business_uen call with the tidied UEN, the typed name and the reason", async () => {
  const { client, calls } = fakeSupabase({ "rpc.admin_set_kitchen_business_uen": ok("53123456A") });
  assert.deepEqual(await setKitchenBusinessUenWith(client, KITCHEN, " 53123456a ", " TEST Parata ", " owner sent ACRA "), { ok: true, uen: "53123456A" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "rpc");
  assert.deepEqual(calls[0].args, {
    p_kitchen_id: KITCHEN,
    p_uen: "53123456A",
    p_confirm_business_name: "TEST Parata",
    p_reason: "owner sent ACRA",
  });
});

test("set: refused before the database for a bad id, UEN, missing name or reason", async () => {
  const cases: [unknown[], RegExp][] = [
    [["x", "53123456A", "N", "r"], /invalid kitchen id/],
    [[KITCHEN, "", "N", "r"], /enter the business UEN/],
    [[KITCHEN, "12345", "N", "r"], /UEN doesn't look right/],
    [[KITCHEN, "53123456A", " ", "r"], /type the kitchen's business name/],
    [[KITCHEN, "53123456A", "N", ""], /give a reason/],
    [[KITCHEN, "53123456A", "N", "r".repeat(201)], /at most 200/],
  ];
  for (const [args, message] of cases) {
    const { client, calls } = fakeSupabase({});
    const r = await setKitchenBusinessUenWith(client, args[0], args[1], args[2], args[3]);
    assert.equal(r.ok, false, JSON.stringify(args));
    if (!r.ok) assert.match(r.message, message);
    assert.equal(calls.length, 0);
  }
});

test("set: the database's refusals come back as 'Not saved: …'", async () => {
  const cases: [string, RegExp][] = [
    ["Not allowed: admins only.", /only an admin can change/],
    ["Type the kitchen's business name exactly to confirm.", /^Not saved: Type the kitchen's business name exactly/],
    ["A Home Cook kitchen doesn't carry a business UEN.", /^Not saved: A Home Cook/],
    ["function public.admin_set_kitchen_business_uen(uuid, text, text, text) does not exist", /doesn't have the UEN function yet/],
  ];
  for (const [error, message] of cases) {
    const { client } = fakeSupabase({ "rpc.admin_set_kitchen_business_uen": fail(error) });
    const r = await setKitchenBusinessUenWith(client, KITCHEN, "53123456A", "N", "r");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, message);
  }
});

test("the setKitchenBusinessUen action: admin first, then the one call, then a refresh", () => {
  const actions = src("./actions.ts");
  const start = actions.indexOf("export async function setKitchenBusinessUen(");
  assert.ok(start > 0);
  const fn = actions.slice(start, actions.indexOf("\n}\n", start));
  assert.match(fn, /const \{ supabase \} = await assertAdmin\(\);\n\s*const result = await setKitchenBusinessUenWith\(supabase, kitchenId, uen, confirmBusinessName, reason\);/);
  assert.match(fn, /if \(result\.ok\) revalidateKitchen\(kitchenId\);/);
  // The panel never writes kitchens itself; kitchens.business_uen stays derived.
  const panel = src("../components/KitchenUenPanel.tsx");
  assert.match(panel, /setKitchenBusinessUen\(kitchenId, uen, confirmName, reason\)/);
  assert.doesNotMatch(panel, /\.from\(|\.rpc\(/);
  assert.match(panel, />UEN pending</);
});
