import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeSupabase, fail, ok } from "./testing/fake-supabase.ts";
import {
  addDraftItemWith,
  assistedPhotoPath,
  cancelDraftShopWith,
  claimLinkFor,
  claimMessage,
  claimReadiness,
  createDraftShopWith,
  DRAFT_SAVE_COLUMNS,
  friendlyAssistedError,
  hashClaimToken,
  issueClaimLinkWith,
  loadClaimLinksWith,
  markClaimLinkSentWith,
  newClaimToken,
  normalizeOwnerMobile,
  revokeClaimLinkWith,
  saveDraftShopWith,
  setDraftItemHiddenWith,
  STALE_DRAFT_ITEM_MESSAGE,
  STALE_DRAFT_MESSAGE,
  toDraftItem,
  updateDraftItemWith,
  validateDraftShop,
  whatsappUrl,
} from "./assisted-onboarding.ts";

const SHOP = "7b0c1a52-3f1e-4d9a-9c11-2a4b5c6d7e8f";
const ITEM = "11111111-2222-4333-8444-555555555555";
const TOKEN_ID = "99999999-8888-4777-8666-555555555555";
const LOADED = "2026-11-25T06:39:12.123456+00:00";
const SAVED = "2026-11-25T07:00:00.000001+00:00";
const EXPIRES = "2026-11-27T07:00:00+00:00";

const DRAFT = {
  business_name: "  TEST Ah Hock Noodles  ",
  category: "hawker",
  cuisine_type: "chinese",
  is_halal: false,
  description: "  Since 1980  ",
  hero_image: "",
  owner_name: "  Tan Ah Hock ",
  owner_mobile: "+65 9123 4567",
  business_uen: " 53123456a ",
  business_address: " Blk 1 Test Lane #01-01 ",
  postal_code: " 310123 ",
};

const itemRow = (over: Record<string, unknown> = {}) => ({
  id: ITEM,
  shop_id: SHOP,
  name: "Wanton mee",
  price: 5,
  photo_url: null,
  is_hidden: false,
  updated_at: SAVED,
  created_at: LOADED,
  ...over,
});

// --- Validation ---

test("owner mobile: 8 digits starting with 8 or 9; spaces, dashes and +65 are dropped", () => {
  assert.equal(normalizeOwnerMobile("9123 4567"), "91234567");
  assert.equal(normalizeOwnerMobile("+65 8123-4567"), "81234567");
  assert.equal(normalizeOwnerMobile("6591234567"), "91234567");
  for (const bad of ["71234567", "9123456", "912345678", "+60 91234567", "", null, 91234567]) {
    assert.equal(normalizeOwnerMobile(bad), null, String(bad));
  }
});

test("a draft is trimmed and tidied; optional fields become null", () => {
  const r = validateDraftShop(DRAFT);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    business_name: "TEST Ah Hock Noodles",
    category: "hawker",
    cuisine_type: "chinese",
    is_halal: false,
    description: "Since 1980",
    hero_image: null,
    owner_name: "Tan Ah Hock",
    owner_mobile: "91234567",
    business_uen: "53123456A",
    business_address: "Blk 1 Test Lane #01-01",
    postal_code: "310123",
  });
  const bare = validateDraftShop({ ...DRAFT, business_uen: "", business_address: "", postal_code: "" });
  assert.ok(bare.ok);
  assert.equal(bare.value.business_uen, null);
  assert.equal(bare.value.business_address, null);
  assert.equal(bare.value.postal_code, null);
});

test("a draft with a bad field is refused with a message HQ can act on", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ business_name: "  " }, /Business name is required/],
    [{ category: "restaurant" }, /Pick a category/],
    [{ cuisine_type: "thai" }, /Pick a cuisine/],
    [{ is_halal: "yes" }, /Halal must be yes or no/],
    [{ owner_name: "" }, /Owner name is required/],
    [{ owner_name: "x".repeat(81) }, /at most 80/],
    [{ owner_mobile: "6123 4567" }, /Singapore mobile number/],
    [{ business_uen: "12345" }, /UEN doesn't look right/],
    [{ business_address: "x".repeat(301) }, /at most 300/],
    [{ postal_code: "31012" }, /6 digits/],
    [{ hero_image: "javascript:alert(1)" }, /photo/],
  ];
  for (const [over, message] of cases) {
    const r = validateDraftShop({ ...DRAFT, ...over });
    assert.equal(r.ok, false, JSON.stringify(over));
    if (!r.ok) assert.match(r.message, message);
  }
  assert.equal(validateDraftShop(null).ok, false);
});

test("claim readiness mirrors admin_issue_assisted_claim_link", () => {
  const shop = { status: "draft" as const, category: "hawker" as const, business_uen: null, business_address: null, postal_code: null };
  assert.deepEqual(claimReadiness(shop, []), [
    "Pickup address",
    "Postal code",
    "Business UEN (needed for every category except Home Cook)",
    "At least one menu item that isn't hidden",
  ]);
  assert.deepEqual(claimReadiness({ ...shop, category: "home-cook", business_address: "A", postal_code: "310123" }, [{ is_hidden: false }]), []);
  assert.equal(claimReadiness({ ...shop, category: "home-cook", business_address: "A", postal_code: "310123" }, [{ is_hidden: true }]).length, 1);
  assert.deepEqual(claimReadiness({ ...shop, status: "claimed" }, []), ["This shop is no longer a draft."]);
});

// --- Draft writes ---

test("create sends exactly DRAFT_SAVE_COLUMNS: never status, PayNow, pricing_plan or claim fields", async () => {
  const { client, calls } = fakeSupabase({ "assisted_shops.insert": ok([{ id: SHOP, updated_at: SAVED }]) });
  const r = await createDraftShopWith(client, { ...DRAFT, status: "claimed", pricing_plan: "x", paynow_value: "91234567", claimed_user_id: SHOP });
  assert.deepEqual(r, { ok: true, id: SHOP, updatedAt: SAVED });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "insert");
  assert.deepEqual(Object.keys(calls[0].values as object).sort(), [...DRAFT_SAVE_COLUMNS].sort());
  assert.equal((calls[0].values as Record<string, unknown>).owner_mobile, "91234567");
});

test("create: an invalid draft never reaches the database; a duplicate mobile reads well", async () => {
  const { client, calls } = fakeSupabase({});
  assert.equal((await createDraftShopWith(client, { ...DRAFT, owner_mobile: "1" })).ok, false);
  assert.equal(calls.length, 0);

  const dup = fakeSupabase({
    "assisted_shops.insert": fail('duplicate key value violates unique constraint "assisted_shops_open_mobile_idx"'),
  });
  const r = await createDraftShopWith(dup.client, DRAFT);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /already an open draft for this owner's mobile/);
});

test("save updates by id, loaded updated_at and status = draft; 0 rows = stale", async () => {
  const { client, calls } = fakeSupabase({ "assisted_shops.update": [ok([{ id: SHOP, updated_at: SAVED }]), ok([])] });
  assert.deepEqual(await saveDraftShopWith(client, SHOP, LOADED, DRAFT), { ok: true, id: SHOP, updatedAt: SAVED });
  assert.deepEqual(calls[0].filters, [
    ["id", SHOP],
    ["updated_at", LOADED],
    ["status", "draft"],
  ]);
  assert.deepEqual(Object.keys(calls[0].values as object).sort(), [...DRAFT_SAVE_COLUMNS].sort());
  assert.deepEqual(await saveDraftShopWith(client, SHOP, LOADED, DRAFT), { ok: false, message: STALE_DRAFT_MESSAGE, stale: true });
});

test("save refuses a bad id or missing version without a database call", async () => {
  const { client, calls } = fakeSupabase({});
  assert.equal((await saveDraftShopWith(client, "nope", LOADED, DRAFT)).ok, false);
  assert.equal((await saveDraftShopWith(client, SHOP, "", DRAFT)).ok, false);
  assert.equal(calls.length, 0);
});

test("draft items: add, edit and hide, scoped to the shop; never a delete", async () => {
  const { client, calls } = fakeSupabase({
    "assisted_shop_items.insert": ok([itemRow()]),
    "assisted_shop_items.update": [ok([itemRow({ price: 6 })]), ok([itemRow({ is_hidden: true })]), ok([])],
  });
  const added = await addDraftItemWith(client, SHOP, { name: " Wanton mee ", price: "$5", photo_url: null });
  assert.ok(added.ok);
  assert.equal(added.item.kitchen_id, SHOP, "shown in the shared editor with the shop id");
  assert.deepEqual(calls[0].values, { shop_id: SHOP, name: "Wanton mee", price: 5, photo_url: null });

  assert.ok((await updateDraftItemWith(client, SHOP, ITEM, LOADED, { name: "Wanton mee", price: "6", photo_url: null })).ok);
  assert.deepEqual(calls[1].filters, [
    ["id", ITEM],
    ["shop_id", SHOP],
    ["updated_at", LOADED],
  ]);
  const hidden = await setDraftItemHiddenWith(client, SHOP, ITEM, LOADED, true);
  assert.ok(hidden.ok && hidden.item.is_hidden);
  assert.deepEqual(calls[2].values, { is_hidden: true });
  assert.deepEqual(await setDraftItemHiddenWith(client, SHOP, ITEM, LOADED, false), { ok: false, message: STALE_DRAFT_ITEM_MESSAGE, stale: true });
  assert.equal((await setDraftItemHiddenWith(client, SHOP, ITEM, LOADED, "yes")).ok, false);
  assert.ok(calls.every((c) => c.op !== "delete"));
});

test("toDraftItem maps a row, and refuses junk", () => {
  assert.deepEqual(toDraftItem(itemRow({ price: "4.50" })), {
    id: ITEM,
    kitchen_id: SHOP,
    name: "Wanton mee",
    price: 4.5,
    photo_url: null,
    is_hidden: false,
    updated_at: SAVED,
    created_at: LOADED,
  });
  assert.equal(toDraftItem(undefined), null);
  assert.equal(toDraftItem({ name: "x" }), null);
});

// --- Claim token and link ---

test("a claim token is 32 random bytes in base64url (43 characters), different every time", () => {
  const tokens = new Set(Array.from({ length: 200 }, newClaimToken));
  assert.equal(tokens.size, 200);
  for (const t of tokens) {
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(t, "base64url").length, 32);
  }
});

test("the hash is lowercase hex SHA-256 of the token's UTF-8 bytes (what Postgres sha256(convert_to()) gives)", async () => {
  assert.equal(await hashClaimToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const t = newClaimToken();
  assert.equal(await hashClaimToken(t), createHash("sha256").update(t, "utf8").digest("hex"));
});

test("the link puts the token in the #fragment of the Partner claim page, and refuses anything else", () => {
  const t = newClaimToken();
  assert.equal(claimLinkFor(t), `https://partners.kopi-boy.com/claim#${t}`);
  for (const bad of ["", "short", `${t}x`, `${t.slice(1)}/`, "<script>".padEnd(43, "a")]) {
    assert.throws(() => claimLinkFor(bad));
  }
});

test("issuing sends only the hash, and returns the token and link once", async () => {
  const { client, calls } = fakeSupabase({ "rpc.admin_issue_assisted_claim_link": ok([{ token_id: TOKEN_ID, expires_at: EXPIRES }]) });
  const r = await issueClaimLinkWith(client, SHOP);
  assert.ok(r.ok);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "admin_issue_assisted_claim_link");
  const args = calls[0].args as Record<string, string>;
  assert.deepEqual(Object.keys(args).sort(), ["p_shop_id", "p_token_hash"]);
  assert.equal(args.p_shop_id, SHOP);
  assert.equal(args.p_token_hash, await hashClaimToken(r.token));
  assert.ok(!JSON.stringify(calls).includes(r.token), "the raw token never goes to the database");
  assert.equal(r.link, `https://partners.kopi-boy.com/claim#${r.token}`);
  assert.equal(r.tokenId, TOKEN_ID);
  assert.equal(r.expiresAt, EXPIRES);
});

test("a refused issue returns the database's reason and no token", async () => {
  const { client } = fakeSupabase({ "rpc.admin_issue_assisted_claim_link": fail("Add at least one menu item before sending a claim link.") });
  const r = await issueClaimLinkWith(client, SHOP);
  assert.deepEqual(r, { ok: false, message: "Couldn't create the link: Add at least one menu item before sending a claim link." });

  const empty = fakeSupabase({ "rpc.admin_issue_assisted_claim_link": ok([]) });
  const e = await issueClaimLinkWith(empty.client, SHOP);
  assert.equal(e.ok, false);
  assert.ok(!("token" in e));

  const none = fakeSupabase({});
  assert.equal((await issueClaimLinkWith(none.client, "not-a-uuid")).ok, false);
  assert.equal(none.calls.length, 0);
});

test("mark sent, revoke and cancel call their functions; revoke and cancel need a reason", async () => {
  const { client, calls } = fakeSupabase({});
  assert.deepEqual(await markClaimLinkSentWith(client, TOKEN_ID), { ok: true });
  assert.deepEqual(calls[0], { kind: "rpc", name: "admin_mark_assisted_claim_link_sent", args: { p_token_id: TOKEN_ID }, filters: [] });

  assert.equal((await revokeClaimLinkWith(client, TOKEN_ID, "  ")).ok, false);
  assert.equal((await revokeClaimLinkWith(client, TOKEN_ID, "x".repeat(201))).ok, false);
  assert.deepEqual(await revokeClaimLinkWith(client, TOKEN_ID, " wrong number "), { ok: true });
  assert.deepEqual(calls[1].args, { p_token_id: TOKEN_ID, p_reason: "wrong number" });

  assert.equal((await cancelDraftShopWith(client, SHOP, "")).ok, false);
  assert.deepEqual(await cancelDraftShopWith(client, SHOP, "owner changed their mind"), { ok: true });
  assert.deepEqual(calls[2].args, { p_shop_id: SHOP, p_reason: "owner changed their mind" });
  assert.equal(calls.length, 3);

  const refused = fakeSupabase({ "rpc.admin_revoke_assisted_claim_link": fail("This link has already been used to claim the shop.") });
  assert.deepEqual(await revokeClaimLinkWith(refused.client, TOKEN_ID, "x"), {
    ok: false,
    message: "Not revoked: This link has already been used to claim the shop.",
  });
});

test("loading links passes through the list, or the error", async () => {
  const row = { id: TOKEN_ID, state: "live" };
  assert.deepEqual(await loadClaimLinksWith(fakeSupabase({ "rpc.admin_list_assisted_claim_links": ok([row]) }).client, SHOP), { ok: true, links: [row] });
  assert.deepEqual(await loadClaimLinksWith(fakeSupabase({ "rpc.admin_list_assisted_claim_links": fail("boom") }).client, SHOP), { ok: false, message: "boom" });
});

test("the WhatsApp message names the owner and shop, carries the link and expiry, and warns not to forward", () => {
  const link = claimLinkFor(newClaimToken());
  const msg = claimMessage({ ownerName: " Tan  Ah Hock ", businessName: "Ah Hock Noodles", link, expiresAt: "2026-11-27T10:00:00Z" });
  assert.match(msg, /^Hi Tan Ah Hock, this is Kopi Boy HQ\./);
  assert.ok(msg.includes(link));
  assert.match(msg, /Ah Hock Noodles/);
  assert.match(msg, /Fri, 27 Nov, 6:00\s?pm/); // shown in Singapore time
  assert.match(msg, /don't forward/);
  assert.match(msg, /PayNow/);
});

test("the wa.me link goes to +65 and the owner's number, with the message encoded", () => {
  const url = new URL(whatsappUrl("9123 4567", "Hi & bye #1"));
  assert.equal(url.origin + url.pathname, "https://wa.me/6591234567");
  assert.equal(url.searchParams.get("text"), "Hi & bye #1");
  assert.throws(() => whatsappUrl("12345678", "x"));
});

test("friendly errors", () => {
  assert.match(friendlyAssistedError('violates unique constraint "assisted_claim_tokens_one_open_idx"'), /another link was issued/);
  assert.match(friendlyAssistedError("new row violates check constraint"), /isn't allowed/);
  assert.match(friendlyAssistedError("permission denied for table assisted_shops"), /refused/);
  assert.equal(friendlyAssistedError("Shop not found.", "Not cancelled"), "Not cancelled: Shop not found.");
  assert.equal(friendlyAssistedError(""), "Not saved: unknown error");
});

test("draft photos go to assisted/<shopId>/<uuid>.<ext>, JPG/PNG/WebP up to 5 MB", () => {
  const uuid = "0f0f0f0f-1111-4222-8333-444444444444";
  assert.deepEqual(assistedPhotoPath(SHOP, { type: "image/jpeg", size: 1000 }, uuid), { ok: true, path: `assisted/${SHOP}/${uuid}.jpg` });
  assert.deepEqual(assistedPhotoPath(SHOP, { type: "image/webp", size: 1000 }, uuid), { ok: true, path: `assisted/${SHOP}/${uuid}.webp` });
  assert.equal(assistedPhotoPath(SHOP, { type: "image/gif", size: 1000 }, uuid).ok, false);
  assert.equal(assistedPhotoPath(SHOP, { type: "image/png", size: 5 * 1024 * 1024 + 1 }, uuid).ok, false);
  assert.equal(assistedPhotoPath("../x", { type: "image/png", size: 1 }, uuid).ok, false);
});

// --- Source rules ---

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
  "lib/assisted-onboarding.ts",
  "components/AssistedShopForm.tsx",
  "components/AssistedMenuEditor.tsx",
  "components/ClaimLinkPanel.tsx",
  "components/CancelAssistedShop.tsx",
  "components/AssistedAuditLog.tsx",
  "app/merchants/assisted/page.tsx",
  "app/merchants/assisted/new/page.tsx",
  "app/merchants/assisted/[id]/page.tsx",
];

test("assisted-onboarding.ts is the only file that writes the assisted tables or calls the admin_*assisted* functions", () => {
  const writers = FILES.filter((f) => /from\(\s*["'`]assisted_[a-z_]+["'`]\s*\)\s*\.(insert|update|upsert|delete)\(/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(writers, ["lib/assisted-onboarding.ts"]);
  const callers = FILES.filter((f) => /\.rpc\(\s*["'`]admin_[a-z_]*assisted/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(callers, ["lib/assisted-onboarding.ts"]);
  assert.doesNotMatch(file("lib/assisted-onboarding.ts"), /\.(upsert|delete)\(/);
  for (const f of FILES) assert.doesNotMatch(f.text, /assisted_claim_(preview|complete)/, `${f.rel}: the claim is the Partner server's, never Boss's`);
});

// What a write may send is pinned by the DRAFT_SAVE_COLUMNS tests above; here, no PayNow or terms stamp anywhere.
test("the feature never mentions PayNow columns or the terms stamp, and never logs", () => {
  for (const rel of FEATURE) {
    // The one allowed mention: the history shows when the owner acknowledged, read from the claim's audit row.
    const text = file(rel).replaceAll("d.acknowledged_terms_at", "");
    assert.doesNotMatch(text, /paynow_(type|value)|acknowledged_terms_at/, rel);
    assert.doesNotMatch(text, /console\.|localStorage|sessionStorage|document\.cookie/, `${rel}: the token must never be logged or kept`);
  }
  assert.ok(!(DRAFT_SAVE_COLUMNS as readonly string[]).includes("pricing_plan"), "pricing_plan waits for the plan codes");
});

test("the screens never call the database themselves (only photo uploads to storage)", () => {
  for (const rel of FEATURE.filter((r) => r.startsWith("components/"))) {
    const text = file(rel);
    assert.doesNotMatch(text, /\.rpc\(|createClient/, rel);
  }
  assert.match(file("components/AssistedShopForm.tsx"), /uploadPath=\{\(file, uuid\) => assistedPhotoPath\(shop\.id, file, uuid\)\}/);
  assert.match(file("components/AssistedMenuEditor.tsx"), /photoPath=\{\(file, uuid\) => assistedPhotoPath\(shopId, file, uuid\)\}/);
  assert.match(file("components/KitchenPhotoField.tsx"), /uploadPath \? uploadPath\(file, uuid\) : hqPhotoPath\(kitchenId, file, uuid\)/);
});

test("actions.ts only calls assisted-onboarding.ts for this feature, after assertAdmin()", () => {
  const actions = file("lib/actions.ts");
  for (const [name, helper] of [
    ["createAssistedShop", "createDraftShopWith"],
    ["saveAssistedShop", "saveDraftShopWith"],
    ["addAssistedShopItem", "addDraftItemWith"],
    ["updateAssistedShopItem", "updateDraftItemWith"],
    ["setAssistedShopItemHidden", "setDraftItemHiddenWith"],
    ["issueAssistedClaimLink", "issueClaimLinkWith"],
    ["markAssistedClaimLinkSent", "markClaimLinkSentWith"],
    ["revokeAssistedClaimLink", "revokeClaimLinkWith"],
    ["cancelAssistedShop", "cancelDraftShopWith"],
  ]) {
    const start = actions.indexOf(`export async function ${name}(`);
    assert.ok(start > 0, name);
    const fn = actions.slice(start, actions.indexOf("\n}\n", start));
    assert.match(fn, /\{\s*const \{ supabase \} = await assertAdmin\(\);/, `${name}: assertAdmin first`);
    assert.match(fn, new RegExp(`await ${helper}\\(supabase,`), `${name} calls ${helper}`);
    assert.doesNotMatch(fn, /\.from\(|\.rpc\(|console\./, `${name} has no database call or log of its own`);
    assert.match(fn, /return result;/);
  }
});

test("the claim link panel: shown once from state, wa.me with no referrer, send recorded, revoke needs a reason", () => {
  const panel = file("components/ClaimLinkPanel.tsx");
  assert.match(panel, /useState<Fresh \| null>\(null\)/);
  assert.match(panel, /whatsappUrl\(ownerMobile, message\)/);
  assert.match(panel, /rel="noopener noreferrer"/);
  assert.match(panel, /referrerPolicy="no-referrer"/);
  assert.match(panel, /onClick=\{recordSend\}/);
  assert.match(panel, /markAssistedClaimLinkSent\(shopId, fresh\.tokenId\)/);
  assert.match(panel, /revokeAssistedClaimLink\(shopId, link\.id, reason\)/);
  assert.match(panel, /Boss can&apos;t show this link again/);
});

test("the shop page never shows the menu editor over a failed read, and only drafts are editable", () => {
  const page = file("app/merchants/assisted/[id]/page.tsx");
  const gate = page.indexOf("itemsResult.error ?");
  const editor = page.indexOf("<AssistedMenuEditor");
  assert.ok(gate > 0 && gate < editor);
  assert.match(page, /<AssistedShopForm shop=\{shop\} readOnly=\{!isDraft\} \/>/);
  assert.match(page, /isDraft && \(\s*<Card[^>]*>\s*<CancelAssistedShop/);
  assert.match(page, /if \(!UUID\.test\(id\)\) return notFound;/);
});

test("the sidebar links to Assisted onboarding", () => {
  assert.match(file("components/ops/OpsSidebar.tsx"), /\{ label: "Assisted onboarding", href: "\/merchants\/assisted" \}/);
});
