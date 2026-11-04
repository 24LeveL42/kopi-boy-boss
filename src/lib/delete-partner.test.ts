import { test } from "node:test";
import assert from "node:assert/strict";
import { deletePartnerWith, normalizeConfirmName } from "./delete-partner.ts";
import { fail, fakeSupabase, ok, type Result } from "./testing/fake-supabase.ts";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const COOK = "11111111-1111-4111-8111-111111111111";
const RIDER = "22222222-2222-4222-8222-222222222222";

const cookProfile = ok({ id: COOK, role: "cook", full_name: "Auntie Mei" });
const riderProfile = ok({ id: RIDER, role: "rider", full_name: "Ravi Kumar" });
const kitchen = ok({ business_name: "Mei's Kopi Corner" });

function setup(respond: Record<string, Result | Result[]>) {
  const fake = fakeSupabase(respond);
  const deletes = () => fake.calls.filter((c) => c.op === "delete").map((c) => c.name);
  return { ...fake, deletes };
}

// profiles is both read (select) and deleted; select and delete use different keys.
const cookOk = {
  "profiles.select": cookProfile,
  "kitchens.select": kitchen,
  "menu_items.delete": ok([{ id: "m1" }, { id: "m2" }]),
  "kitchens.delete": ok([{ id: COOK }]),
  "cook_applications.delete": ok([{ id: "a1" }]),
  "profiles.delete": ok([{ id: COOK }]),
};

test("cook happy path: 4 steps in order, then ok", async () => {
  const { client, deletes, calls } = setup(cookOk);
  const r = await deletePartnerWith(client, ADMIN, { partnerId: COOK, claimedRole: "cook", typedName: "Mei's Kopi Corner" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(deletes(), ["menu_items", "kitchens", "cook_applications", "profiles"]);
  assert.deepEqual(r.deleted, ["menu_items: 2 rows", "kitchens: 1 row", "cook_applications: 1 row", "profiles: 1 row"]);
  assert.deepEqual(r.notDeleted, []);
  for (const c of calls.filter((c) => c.op === "delete")) {
    assert.deepEqual(c.filters[0][1], COOK, "every delete is scoped to the partner id");
  }
});

test("rider happy path: 2 steps in order", async () => {
  const { client, deletes } = setup({
    "profiles.select": riderProfile,
    "rider_applications.delete": ok([{ id: "r1" }]),
    "profiles.delete": ok([{ id: RIDER }]),
  });
  const r = await deletePartnerWith(client, ADMIN, { partnerId: RIDER, claimedRole: "rider", typedName: "Ravi Kumar" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(deletes(), ["rider_applications", "profiles"]);
});

test("name match: trims and ignores case", async () => {
  const { client } = setup(cookOk);
  const r = await deletePartnerWith(client, ADMIN, { partnerId: COOK, claimedRole: "cook", typedName: "  MEI'S kopi corner " });
  assert.equal(r.ok, true, r.error);
  assert.equal(normalizeConfirmName("  Ab C "), "ab c");
});

test("rider with no name: confirmed with their email", async () => {
  const { client, calls } = setup({
    "profiles.select": ok({ id: RIDER, role: "rider", full_name: "  " }),
    "rpc.admin_user_emails": ok([{ id: RIDER, email: "ravi@example.com" }]),
    "rider_applications.delete": ok([]),
    "profiles.delete": ok([{ id: RIDER }]),
  });
  const wrong = await deletePartnerWith(client, ADMIN, { partnerId: RIDER, claimedRole: "rider", typedName: "Ravi" });
  assert.equal(wrong.ok, false);
  const r = await deletePartnerWith(client, ADMIN, { partnerId: RIDER, claimedRole: "rider", typedName: "Ravi@Example.com" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.deleted, ["rider_applications: 0 rows", "profiles: 1 row"]);
  assert.ok(calls.some((c) => c.kind === "rpc" && c.name === "admin_user_emails"));
});

// --- Refusals: nothing may be deleted ---

const refusals: [string, Record<string, Result | Result[]>, Record<string, unknown>, RegExp][] = [
  ["target is an admin", { "profiles.select": ok({ id: COOK, role: "admin", full_name: "Boss" }) },
    { partnerId: COOK, claimedRole: "cook", typedName: "Boss" }, /admin/],
  ["target is yourself", { "profiles.select": cookProfile },
    { partnerId: ADMIN, claimedRole: "cook", typedName: "x" }, /your own account/],
  ["claimed cook, really a rider", { "profiles.select": riderProfile },
    { partnerId: RIDER, claimedRole: "cook", typedName: "Ravi Kumar" }, /rider, not a cook/],
  ["claimed rider, really a cook", { "profiles.select": cookProfile, "kitchens.select": kitchen },
    { partnerId: COOK, claimedRole: "rider", typedName: "Auntie Mei" }, /cook, not a rider/],
  ["claimed rider, really a customer", { "profiles.select": ok({ id: RIDER, role: "customer", full_name: "C" }) },
    { partnerId: RIDER, claimedRole: "rider", typedName: "C" }, /customer, not a rider/],
  ["wrong typed name", cookOk, { partnerId: COOK, claimedRole: "cook", typedName: "Mei Kopi" }, /doesn't match/],
  ["empty typed name", cookOk, { partnerId: COOK, claimedRole: "cook", typedName: "   " }, /doesn't match/],
  ["missing typed name", cookOk, { partnerId: COOK, claimedRole: "cook", typedName: undefined }, /doesn't match/],
  ["typed the owner's name instead of the business", cookOk,
    { partnerId: COOK, claimedRole: "cook", typedName: "Auntie Mei" }, /doesn't match/],
  ["cook with no kitchen row", { ...cookOk, "kitchens.select": ok(null) },
    { partnerId: COOK, claimedRole: "cook", typedName: "" }, /no kitchen business name/],
  ["rider with no name and no email", { "profiles.select": ok({ id: RIDER, role: "rider", full_name: null }), "rpc.admin_user_emails": ok([]) },
    { partnerId: RIDER, claimedRole: "rider", typedName: "" }, /no name or email/],
  ["no such profile", { "profiles.select": ok(null) }, { partnerId: COOK, claimedRole: "cook", typedName: "x" }, /No partner/],
  ["profile read fails", { "profiles.select": fail("timeout") }, { partnerId: COOK, claimedRole: "cook", typedName: "x" }, /timeout/],
  ["kitchen read fails", { ...cookOk, "kitchens.select": fail("boom") },
    { partnerId: COOK, claimedRole: "cook", typedName: "Mei's Kopi Corner" }, /Couldn't read the kitchen/],
  ["unknown role", cookOk, { partnerId: COOK, claimedRole: "admin", typedName: "x" }, /Unknown partner type/],
  ["bad id", cookOk, { partnerId: "1 or 1=1", claimedRole: "cook", typedName: "x" }, /Invalid partner id/],
];

for (const [name, respond, input, why] of refusals) {
  test(`refused, nothing deleted: ${name}`, async () => {
    const { client, deletes } = setup(respond);
    const r = await deletePartnerWith(client, ADMIN, input as Parameters<typeof deletePartnerWith>[2]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", why);
    assert.match(r.error ?? "", /Nothing was deleted/);
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(deletes(), [], "no delete call may be made");
  });
}

// --- Failures part-way: stop at once, report exactly ---

test("kitchens step fails: stops, profiles is never touched, report is exact", async () => {
  const { client, deletes } = setup({ ...cookOk, "kitchens.delete": fail("permission denied for table kitchens") });
  const r = await deletePartnerWith(client, ADMIN, { partnerId: COOK, claimedRole: "cook", typedName: "Mei's Kopi Corner" });
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, "kitchens");
  assert.match(r.error ?? "", /Stopped at kitchens: permission denied/);
  assert.deepEqual(r.deleted, ["menu_items: 2 rows"]);
  assert.deepEqual(r.notDeleted, ["kitchens", "cook_applications", "profiles"]);
  assert.deepEqual(deletes(), ["menu_items", "kitchens"]);
});

test("first step fails: nothing deleted, all steps reported as not deleted", async () => {
  const { client, deletes } = setup({ ...cookOk, "menu_items.delete": fail("nope") });
  const r = await deletePartnerWith(client, ADMIN, { partnerId: COOK, claimedRole: "cook", typedName: "Mei's Kopi Corner" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.deleted, []);
  assert.deepEqual(r.notDeleted, ["menu_items", "kitchens", "cook_applications", "profiles"]);
  assert.deepEqual(deletes(), ["menu_items"]);
});

test("profile delete silently affects 0 rows: reported as a failure, not success", async () => {
  const { client } = setup({ ...cookOk, "profiles.delete": ok([]) });
  const r = await deletePartnerWith(client, ADMIN, { partnerId: COOK, claimedRole: "cook", typedName: "Mei's Kopi Corner" });
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, "profiles");
  assert.deepEqual(r.notDeleted, ["profiles"]);
  assert.equal(r.deleted.length, 3);
});

test("a step that throws is caught and reported, not re-thrown", async () => {
  const fake = setup(cookOk);
  const realFrom = fake.client.from.bind(fake.client);
  (fake.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    if (t === "cook_applications") throw new Error("socket hang up");
    return realFrom(t);
  };
  const r = await deletePartnerWith(fake.client, ADMIN, { partnerId: COOK, claimedRole: "cook", typedName: "Mei's Kopi Corner" });
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, "cook_applications");
  assert.deepEqual(r.notDeleted, ["cook_applications", "profiles"]);
});
