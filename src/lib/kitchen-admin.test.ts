import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeSupabase, fail, ok } from "./testing/fake-supabase.ts";
import {
  addMenuItemWith,
  auditValue,
  friendlyKitchenError,
  hqPhotoPath,
  KITCHEN_SAVE_COLUMNS,
  saveKitchenProfileWith,
  setMenuItemHiddenWith,
  STALE_ITEM_MESSAGE,
  STALE_KITCHEN_MESSAGE,
  updateMenuItemWith,
  validateKitchenProfile,
  validateMenuItem,
} from "./kitchen-admin.ts";

const KITCHEN = "24fd6ea3-abd2-4e0a-a8de-83e725a1351e";
const ITEM = "11111111-2222-4333-8444-555555555555";
const LOADED = "2026-11-19T06:39:12.123456+00:00";
const SAVED = "2026-11-19T07:00:00.000001+00:00";

const PROFILE = {
  business_name: "  TEST Parata  ",
  category: "home-cook",
  cuisine_type: "indian",
  is_halal: true,
  description: "  Fresh prata daily  ",
  hero_image: "https://example.supabase.co/storage/v1/object/public/kitchen-photos/x/hq/a.jpg",
  is_live: false,
};

const itemRow = (over: Record<string, unknown> = {}) => ({
  id: ITEM,
  kitchen_id: KITCHEN,
  name: "Egg prata",
  price: 2.5,
  photo_url: null,
  is_hidden: false,
  updated_at: SAVED,
  created_at: LOADED,
  ...over,
});

// --- Kitchen profile save ---

test("profile save is one UPDATE with exactly the allowed columns, filtered by id and the loaded updated_at", async () => {
  const { client, calls } = fakeSupabase({ "kitchens.update": ok([{ id: KITCHEN, updated_at: SAVED }]) });
  const r = await saveKitchenProfileWith(client, KITCHEN, LOADED, PROFILE);
  assert.deepEqual(r, { ok: true, updatedAt: SAVED });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.name, "kitchens");
  assert.equal(call.op, "update");
  assert.deepEqual(Object.keys(call.values as object).sort(), [...KITCHEN_SAVE_COLUMNS].sort());
  assert.deepEqual(call.values, {
    business_name: "TEST Parata",
    category: "home-cook",
    cuisine_type: "indian",
    is_halal: true,
    description: "Fresh prata daily",
    hero_image: PROFILE.hero_image,
    is_live: false,
  });
  assert.deepEqual(call.filters, [
    ["id", KITCHEN],
    ["updated_at", LOADED],
  ]);
});

test("the allowed columns are exactly the guard's list minus opening_hours (v1.1)", () => {
  assert.deepEqual([...KITCHEN_SAVE_COLUMNS], [
    "business_name", "category", "cuisine_type", "is_halal", "description", "hero_image", "is_live",
  ]);
});

test("extra fields sent by a direct POST are dropped, never written", async () => {
  const { client, calls } = fakeSupabase({ "kitchens.update": ok([{ id: KITCHEN, updated_at: SAVED }]) });
  await saveKitchenProfileWith(client, KITCHEN, LOADED, {
    ...PROFILE,
    acknowledged_terms_at: "2026-01-01",
    paynow_value: "91234567",
    region: "north",
    is_blocked: false,
    opening_hours: {},
    id: "someone-else",
  });
  assert.deepEqual(Object.keys(calls[0].values as object).sort(), [...KITCHEN_SAVE_COLUMNS].sort());
});

test("0 rows back = stale edit: nothing overwritten, a clear message", async () => {
  const { client } = fakeSupabase({ "kitchens.update": ok([]) });
  assert.deepEqual(await saveKitchenProfileWith(client, KITCHEN, LOADED, PROFILE), {
    ok: false,
    message: STALE_KITCHEN_MESSAGE,
    stale: true,
  });
});

test("database refusals come back as friendly messages, never thrown", async () => {
  const { client } = fakeSupabase({
    "kitchens.update": fail("This kitchen can't go live until the cook accepts the partner terms in the Partner app."),
  });
  const r = await saveKitchenProfileWith(client, KITCHEN, LOADED, { ...PROFILE, is_live: true });
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /hasn't accepted the Kopi Boy partner terms/);
});

test("bad input is refused before anything is sent", async () => {
  const cases: [unknown, unknown, unknown, RegExp][] = [
    ["not-a-uuid", LOADED, PROFILE, /invalid kitchen/],
    [KITCHEN, "", PROFILE, /Reload the page/],
    [KITCHEN, "yesterday", PROFILE, /Reload the page/],
    [KITCHEN, LOADED, { ...PROFILE, business_name: "   " }, /Business name is required/],
    [KITCHEN, LOADED, { ...PROFILE, business_name: "x".repeat(81) }, /at most 80/],
    [KITCHEN, LOADED, { ...PROFILE, category: "drinks" }, /Pick a category/],
    [KITCHEN, LOADED, { ...PROFILE, category: "bulk-orders" }, /Pick a category/],
    [KITCHEN, LOADED, { ...PROFILE, cuisine_type: "thai" }, /Pick a cuisine/],
    [KITCHEN, LOADED, { ...PROFILE, is_live: "true" }, /Live must be yes or no/],
    [KITCHEN, LOADED, { ...PROFILE, is_halal: 1 }, /Halal must be yes or no/],
    [KITCHEN, LOADED, { ...PROFILE, description: "x".repeat(501) }, /at most 500/],
    [KITCHEN, LOADED, { ...PROFILE, hero_image: "javascript:alert(1)" }, /https:\/\//],
    [KITCHEN, LOADED, null, /Business name is required/],
  ];
  for (const [id, stamp, input, message] of cases) {
    const { client, calls } = fakeSupabase({});
    const r = await saveKitchenProfileWith(client, id, stamp, input);
    assert.equal(r.ok, false, String(message));
    assert.match((r as { message: string }).message, message);
    assert.equal(calls.length, 0, `nothing sent for ${message}`);
  }
});

test("empty description and photo are saved as null", () => {
  const r = validateKitchenProfile({ ...PROFILE, description: "  ", hero_image: "" });
  assert.ok(r.ok);
  assert.equal(r.value.description, null);
  assert.equal(r.value.hero_image, null);
});

// --- Menu items ---

test("add item: one INSERT with kitchen_id, name, price, photo_url and no id", async () => {
  const { client, calls } = fakeSupabase({ "menu_items.insert": ok([itemRow({ updated_at: LOADED })]) });
  const r = await addMenuItemWith(client, KITCHEN, { name: " Egg prata ", price: "2.50", photo_url: null });
  assert.ok(r.ok);
  assert.equal(r.item.id, ITEM);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "insert");
  assert.deepEqual(calls[0].values, { kitchen_id: KITCHEN, name: "Egg prata", price: 2.5, photo_url: null });
});

test("edit item: UPDATE name/price/photo filtered by id, kitchen and the loaded updated_at", async () => {
  const { client, calls } = fakeSupabase({ "menu_items.update": ok([itemRow({ price: 3 })]) });
  const r = await updateMenuItemWith(client, KITCHEN, ITEM, LOADED, { name: "Egg prata", price: 3, photo_url: "" });
  assert.ok(r.ok);
  assert.equal(r.item.price, 3);
  assert.deepEqual(calls[0].values, { name: "Egg prata", price: 3, photo_url: null });
  assert.deepEqual(calls[0].filters, [
    ["id", ITEM],
    ["kitchen_id", KITCHEN],
    ["updated_at", LOADED],
  ]);
});

test("hide and show again send only is_hidden", async () => {
  for (const hidden of [true, false]) {
    const { client, calls } = fakeSupabase({ "menu_items.update": ok([itemRow({ is_hidden: hidden })]) });
    const r = await setMenuItemHiddenWith(client, KITCHEN, ITEM, LOADED, hidden);
    assert.ok(r.ok);
    assert.equal(r.item.is_hidden, hidden);
    assert.deepEqual(calls[0].values, { is_hidden: hidden });
    assert.equal(calls[0].op, "update");
  }
});

test("a stale item edit is refused with a message", async () => {
  const { client } = fakeSupabase({ "menu_items.update": ok([]) });
  assert.deepEqual(await setMenuItemHiddenWith(client, KITCHEN, ITEM, LOADED, true), {
    ok: false,
    message: STALE_ITEM_MESSAGE,
    stale: true,
  });
});

test("bad menu input is refused before anything is sent", async () => {
  const bad: [unknown, RegExp][] = [
    [{ name: "", price: 2 }, /name is required/],
    [{ name: "x".repeat(81), price: 2 }, /at most 80/],
    [{ name: "Prata", price: "abc" }, /must be a number/],
    [{ name: "Prata", price: "" }, /more than \$0/],
    [{ name: "Prata", price: 0 }, /more than \$0/],
    [{ name: "Prata", price: -1 }, /more than \$0/],
    [{ name: "Prata", price: 10000 }, /at most/],
    [{ name: "Prata", price: 2, photo_url: "ftp://x" }, /https:\/\//],
  ];
  for (const [input, message] of bad) {
    const { client, calls } = fakeSupabase({});
    const r = await addMenuItemWith(client, KITCHEN, input);
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, message);
    assert.equal(calls.length, 0);
  }
  const { client, calls } = fakeSupabase({});
  assert.equal((await setMenuItemHiddenWith(client, KITCHEN, ITEM, LOADED, "yes")).ok, false);
  assert.equal((await updateMenuItemWith(client, KITCHEN, "x", LOADED, { name: "a", price: 1 })).ok, false);
  assert.equal(calls.length, 0);
});

test("prices: '$4.5' and 4.499 round to 2 decimals", () => {
  const a = validateMenuItem({ name: "a", price: "$4.5" });
  const b = validateMenuItem({ name: "a", price: 4.499 });
  assert.ok(a.ok && b.ok);
  assert.equal(a.value.price, 4.5);
  assert.equal(b.value.price, 4.5);
});

// --- Friendly messages for every database refusal the guard can raise ---

test("friendlyKitchenError covers the terms, go-live, guard and RLS errors", () => {
  const cases: [string, RegExp][] = [
    ["Please acknowledge the Kopi Boy partner terms before setting up your kitchen.", /cook hasn't accepted the Kopi Boy partner terms/],
    ["HQ cannot set or change the partner terms acknowledgement. Only the cook can accept the terms, in the Partner app.", /only the cook can accept/],
    ["This kitchen can't go live until the cook accepts the partner terms in the Partner app.", /Can't put this kitchen live yet.*terms.*Untick Live/],
    ["This kitchen can't go live until the cook has saved a pickup address.", /pickup address.*Untick Live/],
    ["This kitchen can't go live without at least one visible menu item.", /isn't hidden.*Untick Live/],
    ["This kitchen is blocked. Reinstate the merchant before putting it live.", /merchant is blocked/],
    ["HQ cannot create or upsert a kitchen. Edit an existing kitchen with an update.", /only edit an existing kitchen/],
    ["HQ cannot change business_uen, region on a kitchen", /HQ can't change business_uen, region from this screen/],
    ["HQ cannot change kitchen_id on a menu item", /HQ can't change kitchen_id/],
    ['new row for relation "kitchens" violates check constraint "kitchens_category_check"', /values isn't allowed/],
    ["permission denied for table kitchens", /refused this change/],
    ["something odd", /^Not saved: something odd$/],
  ];
  for (const [db, friendly] of cases) assert.match(friendlyKitchenError(db), friendly, db);
});

// --- Photos ---

test("HQ photos go to <kitchen>/hq/<uuid>.<ext>, images only, up to 5 MB", () => {
  const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.deepEqual(hqPhotoPath(KITCHEN, { type: "image/jpeg", size: 1000 }, uuid), { ok: true, path: `${KITCHEN}/hq/${uuid}.jpg` });
  assert.deepEqual(hqPhotoPath(KITCHEN, { type: "image/png", size: 1000 }, uuid), { ok: true, path: `${KITCHEN}/hq/${uuid}.png` });
  assert.deepEqual(hqPhotoPath(KITCHEN, { type: "image/webp", size: 1000 }, uuid), { ok: true, path: `${KITCHEN}/hq/${uuid}.webp` });
  assert.equal(hqPhotoPath(KITCHEN, { type: "image/gif", size: 1000 }, uuid).ok, false);
  assert.equal(hqPhotoPath(KITCHEN, { type: "image/svg+xml", size: 1000 }, uuid).ok, false);
  assert.equal(hqPhotoPath(KITCHEN, { type: "image/jpeg", size: 6 * 1024 * 1024 }, uuid).ok, false);
  assert.equal(hqPhotoPath("../other", { type: "image/jpeg", size: 1 }, uuid).ok, false);
});

test("audit values read well", () => {
  assert.equal(auditValue(null), "(empty)");
  assert.equal(auditValue(true), "yes");
  assert.equal(auditValue(2.5), "2.5");
  assert.equal(auditValue("x".repeat(100)).length, 78);
});

// --- Source rules: where Boss may write, and what it may never send ---

const SRC = fileURLToPath(new URL("..", import.meta.url));
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}
const FILES = walk(SRC).map((path) => ({ rel: relative(SRC, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));
const file = (rel: string) => FILES.find((f) => f.rel === rel)!.text;
const FEATURE = [
  "lib/kitchen-admin.ts",
  "lib/actions.ts",
  "components/MerchantEditForm.tsx",
  "components/MenuItemsEditor.tsx",
  "components/KitchenPhotoField.tsx",
  "components/KitchenAuditLog.tsx",
  "app/merchants/[id]/edit/page.tsx",
];

test("no upsert into kitchens, menu_items or kitchen_addresses anywhere in Boss", () => {
  for (const f of FILES) {
    assert.doesNotMatch(f.text, /from\(\s*["'`](kitchens|menu_items|kitchen_addresses)["'`]\s*\)\s*\.upsert\(/, f.rel);
  }
});

test("kitchen-admin.ts is the only file that inserts or updates kitchens or menu_items", () => {
  const writers = FILES.filter((f) =>
    /from\(\s*["'`](kitchens|menu_items)["'`]\s*\)\s*\.(insert|update|upsert)\(/.test(f.text)
  ).map((f) => f.rel);
  assert.deepEqual(writers, ["lib/kitchen-admin.ts"]);
  assert.doesNotMatch(file("lib/kitchen-admin.ts"), /\.(upsert|delete)\(/, "kitchen-admin.ts never upserts or deletes");
});

test("the feature never sends or reads the terms stamp, PayNow or opening hours", () => {
  for (const rel of FEATURE) {
    assert.doesNotMatch(file(rel), /acknowledged_terms_at|opening_hours|paynow_(type|value)/, rel);
  }
});

test("the screens never write to the database themselves (only photo uploads to storage)", () => {
  for (const rel of ["components/MerchantEditForm.tsx", "components/MenuItemsEditor.tsx", "components/KitchenPhotoField.tsx"]) {
    const text = file(rel);
    assert.doesNotMatch(text, /\.rpc\(/, rel);
    const froms = [...text.matchAll(/(\w+(?:\(\))?)\.from\(/g)].map((m) => m[1]);
    assert.ok(froms.every((f) => f === "storage"), `${rel}: only storage.from(...)`);
  }
  assert.match(file("components/KitchenPhotoField.tsx"), /storage\.from\("kitchen-photos"\)/);
  assert.match(file("components/KitchenPhotoField.tsx"), /hqPhotoPath\(/);
  assert.match(file("components/KitchenPhotoField.tsx"), /upsert: false/);
});

test("the menu screen has hide and show again, and no delete", () => {
  const editor = file("components/MenuItemsEditor.tsx");
  assert.match(editor, /"Show again" : "Hide"/);
  assert.doesNotMatch(editor, />\s*Delete|"Delete|Remove item|deleteMenuItem/);
  assert.doesNotMatch(file("lib/actions.ts"), /deleteMenuItem|menu_items/);
});

test("actions.ts only calls kitchen-admin.ts for this feature, after assertAdmin()", () => {
  const actions = file("lib/actions.ts");
  for (const [name, helper] of [
    ["saveKitchenProfile", "saveKitchenProfileWith"],
    ["addMenuItem", "addMenuItemWith"],
    ["updateMenuItem", "updateMenuItemWith"],
    ["setMenuItemHidden", "setMenuItemHiddenWith"],
  ]) {
    const start = actions.indexOf(`export async function ${name}(`);
    assert.ok(start > 0, name);
    const fn = actions.slice(start, actions.indexOf("\n}\n", start));
    assert.match(fn, /\{\s*const \{ supabase \} = await assertAdmin\(\);/, `${name}: assertAdmin first`);
    assert.match(fn, new RegExp(`await ${helper}\\(supabase,`), `${name} calls ${helper}`);
    assert.doesNotMatch(fn, /\.from\(|\.rpc\(/, `${name} has no database call of its own`);
  }
});

test("the edit page never shows the menu editor over a failed menu read", () => {
  const page = file("app/merchants/[id]/edit/page.tsx");
  const gate = page.indexOf("itemsResult.error ?");
  const editor = page.indexOf("<MenuItemsEditor");
  assert.ok(gate > 0 && gate < editor);
});
