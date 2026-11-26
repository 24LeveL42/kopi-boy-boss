import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeSupabase, fail, ok } from "./testing/fake-supabase.ts";
import { goLiveProblemWith, kitchenHasPaynowWith, NO_PAYNOW_MESSAGE, NO_UEN_MESSAGE, PAYNOW_CHECK_FAILED_MESSAGE } from "./kitchen-go-live.ts";
import { friendlyKitchenError } from "./kitchen-admin.ts";

const KITCHEN = "24fd6ea3-abd2-4e0a-a8de-83e725a1351e";
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("PayNow yes/no from admin_get_kitchen_private; null when it can't be checked", async () => {
  const yes = fakeSupabase({ "rpc.admin_get_kitchen_private": ok([{ kitchen_id: KITCHEN, paynow_type: "mobile", paynow_value: "91234567" }]) });
  assert.equal(await kitchenHasPaynowWith(yes.client, KITCHEN), true);
  assert.deepEqual(yes.calls[0].args, { p_kitchen_id: KITCHEN });

  for (const row of [{ paynow_type: null, paynow_value: null }, { paynow_type: "mobile", paynow_value: "  " }, { paynow_type: "", paynow_value: "1" }]) {
    assert.equal(await kitchenHasPaynowWith(fakeSupabase({ "rpc.admin_get_kitchen_private": ok([row]) }).client, KITCHEN), false);
  }
  assert.equal(await kitchenHasPaynowWith(fakeSupabase({ "rpc.admin_get_kitchen_private": ok([]) }).client, KITCHEN), null);
  assert.equal(await kitchenHasPaynowWith(fakeSupabase({ "rpc.admin_get_kitchen_private": fail("Only admins") }).client, KITCHEN), null);
  const bad = fakeSupabase({});
  assert.equal(await kitchenHasPaynowWith(bad.client, "x"), null);
  assert.equal(bad.calls.length, 0);
});

test("not asking for Live: no check at all", async () => {
  const { client, calls } = fakeSupabase({});
  assert.equal(await goLiveProblemWith(client, KITCHEN, false), null);
  assert.equal(calls.length, 0);
});

test("already live: left alone (no PayNow read)", async () => {
  const { client, calls } = fakeSupabase({ "kitchens.select": ok({ id: KITCHEN, is_live: true }) });
  assert.equal(await goLiveProblemWith(client, KITCHEN, true), null);
  assert.deepEqual(calls.map((c) => c.name), ["kitchens"]);
  assert.equal(calls[0].columns, "id, is_live");
});

test("switching on Live: refused without PayNow, or when it can't be checked; allowed with it", async () => {
  const kitchen = { "kitchens.select": ok({ id: KITCHEN, is_live: false }) };
  const none = fakeSupabase({ ...kitchen, "rpc.admin_get_kitchen_private": ok([{ paynow_type: null, paynow_value: null }]) });
  assert.equal(await goLiveProblemWith(none.client, KITCHEN, true), NO_PAYNOW_MESSAGE);
  const failed = fakeSupabase({ ...kitchen, "rpc.admin_get_kitchen_private": fail("boom") });
  assert.equal(await goLiveProblemWith(failed.client, KITCHEN, true), PAYNOW_CHECK_FAILED_MESSAGE);
  const readFailed = fakeSupabase({ "kitchens.select": fail("boom") });
  assert.equal(await goLiveProblemWith(readFailed.client, KITCHEN, true), PAYNOW_CHECK_FAILED_MESSAGE);
  const has = fakeSupabase({ ...kitchen, "rpc.admin_get_kitchen_private": ok([{ paynow_type: "uen", paynow_value: "53123456A" }]) });
  assert.equal(await goLiveProblemWith(has.client, KITCHEN, true), null);
});

test("switching on Live with PayNow: refused in plain words when the kitchen needs a UEN and has none", async () => {
  const paynow = { "rpc.admin_get_kitchen_private": ok([{ paynow_type: "mobile", paynow_value: "91234567" }]) };
  const noUen = { "kitchens.select": [ok({ id: KITCHEN, is_live: false }), ok({ id: KITCHEN, business_uen: null })] };
  const hawker = fakeSupabase({ ...paynow, ...noUen, "cook_applications.select": ok({ business_type: "Hawker" }) });
  assert.equal(await goLiveProblemWith(hawker.client, KITCHEN, true), NO_UEN_MESSAGE);
  assert.deepEqual(hawker.calls.find((c) => c.name === "cook_applications")?.filters, [["user_id", KITCHEN], ["status", "approved"], ["limit", 1]]);

  const homeCook = fakeSupabase({ ...paynow, ...noUen, "cook_applications.select": ok({ business_type: "Home Cook" }) });
  assert.equal(await goLiveProblemWith(homeCook.client, KITCHEN, true), null);
  const withUen = fakeSupabase({
    ...paynow,
    "kitchens.select": [ok({ id: KITCHEN, is_live: false }), ok({ id: KITCHEN, business_uen: "53123456A" })],
    "cook_applications.select": ok({ business_type: "Hawker" }),
  });
  assert.equal(await goLiveProblemWith(withUen.client, KITCHEN, true), null);
  // Can't read it: the save goes ahead and the database decides.
  const unread = fakeSupabase({ ...paynow, ...noUen, "cook_applications.select": fail("boom") });
  assert.equal(await goLiveProblemWith(unread.client, KITCHEN, true), null);
});

test("the database's own refusal (y_kitchen_live_needs_uen) reads the same", () => {
  assert.equal(
    friendlyKitchenError("Add your business UEN (Business Registration Number) in Kitchen Setup before your shop goes live."),
    NO_UEN_MESSAGE
  );
  assert.match(NO_UEN_MESSAGE, /Untick Live to save your other changes/);
});

test("saveKitchenProfile checks Live against PayNow before saving", () => {
  const actions = src("./actions.ts");
  const start = actions.indexOf("export async function saveKitchenProfile(");
  const fn = actions.slice(start, actions.indexOf("\n}\n", start));
  const check = fn.indexOf("goLiveProblemWith(supabase, kitchenId, wantsLive)");
  const save = fn.indexOf("saveKitchenProfileWith(supabase,");
  assert.ok(check > 0 && check < save, "the check comes first");
  assert.match(fn, /if \(blocked\) return \{ ok: false, message: blocked \};/);
});

test("the edit form locks Live (ticking only) without PayNow; the page passes only a yes/no", () => {
  const form = src("../components/MerchantEditForm.tsx");
  assert.match(form, /const liveLocked = !existingKitchen\.is_live && hasPaynow !== true;/);
  assert.match(form, /disabled=\{saving \|\| \(\(liveLocked \|\| uenLocked\) && !isLive\)\}/);
  const page = src("../app/merchants/[id]/edit/page.tsx");
  assert.match(page, /kitchenHasPaynowWith\(supabase, id\)/);
  assert.match(page, /<MerchantEditForm existingKitchen=\{kitchen\} hasPaynow=\{hasPaynow\} uenPending=\{uenStatus\.state === "pending"\} \/>/);
  // UEN pending also locks ticking Live; unticking stays allowed.
  assert.match(form, /const uenLocked = !existingKitchen\.is_live && uenPending;/);
  assert.match(page, /kitchenUenStatusWith\(supabase, id\)/);
});
