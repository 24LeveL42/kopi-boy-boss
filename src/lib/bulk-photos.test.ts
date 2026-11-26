import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FAKE_STORAGE_PUBLIC, fakeSupabase, fail, ok } from "./testing/fake-supabase.ts";
import {
  bulkApplyNotice,
  isOwnAssistedPhotoUrl,
  jpegName,
  matchByName,
  menuOrder,
  naturalCompare,
  needsResize,
  normalizeFileName,
  normalizeName,
  pairInMenuOrder,
  planBulkPhotos,
  resizedSize,
  runPool,
} from "./bulk-photos.ts";
import { setDraftItemPhotosWith } from "./assisted-onboarding.ts";

const SHOP = "7b0c1a52-3f1e-4d9a-9c11-2a4b5c6d7e8f";
const OTHER_SHOP = "0a0b0c0d-1111-4222-8333-444455556666";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LOADED = "2026-11-25T06:39:12.123456+00:00";
const BASE = `${FAKE_STORAGE_PUBLIC}kitchen-photos/`;
const photoUrl = (n: number, shop = SHOP, ext = "jpg") => `${BASE}assisted/${shop}/${ID(100 + n)}.${ext}`;

const item = (n: number, name: string, category: string | null = null, photo: string | null = null, hidden = false) => ({
  id: ID(n),
  name,
  category,
  photo_url: photo,
  is_hidden: hidden,
});
const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  shop_id: SHOP,
  name: `Item ${n}`,
  price: 5,
  photo_url: null,
  category: null,
  owner_note: null,
  is_hidden: false,
  created_at: LOADED,
  updated_at: LOADED,
  ...over,
});

// --- Names ---

test("name normalisation: egg-prata, Egg Prata and egg_prata.WEBP are the same", () => {
  assert.equal(normalizeName("Egg Prata"), "eggprata");
  assert.equal(normalizeFileName("egg-prata.jpg"), "eggprata");
  assert.equal(normalizeFileName("Egg Prata.png"), "eggprata");
  assert.equal(normalizeFileName("egg_prata.WEBP"), "eggprata");
  // only the last extension goes; digits stay; other scripts are letters too
  assert.equal(normalizeFileName("Kopi O.Kosong.jpg"), "kopiokosong");
  assert.equal(normalizeFileName("Set 2 (large).jpeg"), "set2large");
  assert.equal(normalizeFileName("叉烧饭.jpg"), "叉烧饭");
  assert.equal(normalizeFileName(".jpg"), "jpg");
});

test("matching by file name: exact normalised equality only", () => {
  const items = [item(1, "Egg Prata"), item(2, "Egg Prata Special"), item(3, "Teh-C")];
  assert.deepEqual(matchByName("egg-prata.jpg", items), { itemId: ID(1), ambiguous: false });
  assert.deepEqual(matchByName("egg_prata.WEBP", items), { itemId: ID(1), ambiguous: false });
  assert.deepEqual(matchByName("TEH C.png", items), { itemId: ID(3), ambiguous: false });
  assert.deepEqual(matchByName("egg.jpg", items), { itemId: null, ambiguous: false }); // no prefix matching
  assert.deepEqual(matchByName("eggprataspecialx.jpg", items), { itemId: null, ambiguous: false });
  assert.deepEqual(matchByName("___.jpg", items), { itemId: null, ambiguous: false });
});

test("matching by file name: the same name in two categories is ambiguous, left unmatched", () => {
  const items = [item(1, "Kopi", "Hot drinks"), item(2, "kopi", "Cold drinks", null, true), item(3, "Teh")];
  assert.deepEqual(matchByName("Kopi.jpg", items), { itemId: null, ambiguous: true });
  assert.deepEqual(matchByName("teh.jpg", items), { itemId: ID(3), ambiguous: false });
});

test("natural order: IMG_2 before IMG_10, case ignored, stable", () => {
  const names = ["IMG_10.jpg", "img_2.jpg", "IMG_1.jpg", "IMG_100.jpg", "IMG_9.png", "a.jpg"];
  assert.deepEqual([...names].sort(naturalCompare), ["a.jpg", "IMG_1.jpg", "img_2.jpg", "IMG_9.png", "IMG_10.jpg", "IMG_100.jpg"]);
  assert.ok(naturalCompare("x.jpg", "X.jpg") !== 0, "exact text breaks ties");
});

// --- Pair in menu order ---

const MENU = [
  item(1, "Plain Prata", "Prata", "https://x/old.jpg"),
  item(2, "Egg Prata", "Prata"),
  item(3, "Teh", "Drinks"),
  item(4, "Cheese Prata", " prata "), // same group as Prata
  item(5, "Loose Item", null),
  item(6, "Kopi", "Drinks", null, true), // hidden items count too
];
const photos = (...names: string[]) => names.map((fileName, n) => ({ key: `k${n}`, fileName }));

test("menu order is the editor's: by category group, no category last", () => {
  assert.deepEqual(menuOrder(MENU).map((i) => i.id), [ID(1), ID(2), ID(4), ID(3), ID(6), ID(5)]);
});

test("pair in menu order: sorted by file name, one per item, starting at the first item with no photo", () => {
  const pairs = pairInMenuOrder(photos("IMG_10.jpg", "IMG_2.jpg", "IMG_1.jpg"), MENU, { replaceExisting: false });
  // IMG_1 -> Egg Prata (Plain Prata has a photo), IMG_2 -> Cheese Prata, IMG_10 -> Teh
  assert.deepEqual(Object.fromEntries(pairs), { k2: ID(2), k1: ID(4), k0: ID(3) });
  assert.equal(new Set(pairs.values()).size, 3, "never two photos on one item");
});

test("pair in menu order: more photos than items leaves the rest unassigned", () => {
  const pairs = pairInMenuOrder(photos("1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg", "6.jpg"), MENU, { replaceExisting: false });
  assert.deepEqual([...pairs.values()], [ID(2), ID(4), ID(3), ID(6), ID(5), null]);
});

test("pair in menu order with a category limit (matched like the editor's groups)", () => {
  const prata = pairInMenuOrder(photos("b.jpg", "a.jpg", "c.jpg"), MENU, { category: "PRATA", replaceExisting: false });
  assert.deepEqual(Object.fromEntries(prata), { k1: ID(2), k0: ID(4), k2: null });
  const none = pairInMenuOrder(photos("a.jpg"), MENU, { category: null, replaceExisting: false });
  assert.deepEqual(Object.fromEntries(none), { k0: ID(5) });
  const replace = pairInMenuOrder(photos("a.jpg", "b.jpg"), MENU, { category: "Prata", replaceExisting: true });
  assert.deepEqual(Object.fromEntries(replace), { k0: ID(1), k1: ID(2) });
});

// --- Preview plan: skip existing, replace, conflicts ---

test("preview: items with a photo are skipped unless replace is ticked; unmatched counted; failed uploads left out", () => {
  const items = [item(1, "A", null, "https://x/old.jpg"), item(2, "B"), item(3, "C", null, photoUrl(3))];
  const rows = [
    { key: "a", fileName: "a.jpg", url: photoUrl(1), itemId: ID(1) },
    { key: "b", fileName: "b.jpg", url: photoUrl(2), itemId: ID(2) },
    { key: "c", fileName: "c.jpg", url: photoUrl(3), itemId: ID(3) }, // already this photo
    { key: "x", fileName: "x.jpg", url: photoUrl(4), itemId: null },
    { key: "f", fileName: "failed.jpg", url: null, itemId: null },
  ];
  const skip = planBulkPhotos(rows, items, false);
  assert.deepEqual([skip.toUpdate, skip.skipped, skip.unmatched, skip.conflicts], [1, 1, 1, 0]);
  assert.deepEqual(skip.updates, [{ itemId: ID(2), photoUrl: photoUrl(2) }]);
  assert.deepEqual(Object.fromEntries(skip.rows), { a: "skipped", b: "update", c: "unchanged", x: "unassigned" });

  const replace = planBulkPhotos(rows, items, true);
  assert.deepEqual([replace.toUpdate, replace.skipped, replace.unmatched], [2, 0, 1]);
  assert.deepEqual(replace.updates.map((u) => u.itemId), [ID(1), ID(2)]);
});

test("preview: two photos on one item are a conflict and neither is applied", () => {
  const plan = planBulkPhotos(
    [
      { key: "a", fileName: "egg-prata.jpg", url: photoUrl(1), itemId: ID(2) },
      { key: "b", fileName: "Egg Prata.png", url: photoUrl(2), itemId: ID(2) },
    ],
    MENU,
    false
  );
  assert.equal(plan.conflicts, 2);
  assert.deepEqual(plan.updates, []);
});

// --- Resize ---

test("resize decision: over 5 MB or over 1600 px on the long side", () => {
  const MB = 1024 * 1024;
  assert.equal(needsResize({ size: 5 * MB, width: 1600, height: 1200 }), false);
  assert.equal(needsResize({ size: 5 * MB + 1, width: 800, height: 600 }), true);
  assert.equal(needsResize({ size: 1 * MB, width: 1601, height: 900 }), true);
  assert.equal(needsResize({ size: 1 * MB, width: 900, height: 4000 }), true); // tall phone photo
  assert.deepEqual(resizedSize(4032, 3024), { width: 1600, height: 1200 });
  assert.deepEqual(resizedSize(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(resizedSize(800, 600), { width: 800, height: 600 }); // never upscaled
  assert.equal(jpegName("IMG_2.PNG"), "IMG_2.jpg");
  assert.equal(normalizeFileName(jpegName("egg_prata.WEBP")), "eggprata");
});

// --- Upload pool ---

test("uploads: 3 at a time, a failed upload doesn't stop the rest", async () => {
  let running = 0;
  let peak = 0;
  const done: number[] = [];
  const results = await runPool(
    [1, 2, 3, 4, 5, 6, 7],
    3,
    async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5 * (8 - n)));
      running--;
      if (n === 2) throw new Error("Upload failed: The object exceeded the maximum allowed size");
      return `url-${n}`;
    },
    (i) => done.push(i)
  );
  assert.equal(peak, 3);
  assert.equal(done.length, 7);
  assert.deepEqual(results[1], { ok: false, message: "Upload failed: The object exceeded the maximum allowed size" });
  assert.deepEqual(
    results.filter((r) => r.ok).map((r) => (r as { value: string }).value),
    ["url-1", "url-3", "url-4", "url-5", "url-6", "url-7"]
  );
  assert.deepEqual(await runPool([], 3, async () => 1), []);
});

// --- Server: setDraftItemPhotosWith ---

test("own-folder URL check: only kitchen-photos/assisted/<this shop>/<uuid>.<jpg|png|webp>", () => {
  assert.equal(isOwnAssistedPhotoUrl(photoUrl(1), SHOP, BASE), true);
  assert.equal(isOwnAssistedPhotoUrl(photoUrl(1, SHOP, "webp"), SHOP, BASE), true);
  for (const bad of [
    photoUrl(1, OTHER_SHOP),
    photoUrl(1, SHOP, "gif"),
    `${BASE}${SHOP}/hq/${ID(1)}.jpg`,
    `${BASE}assisted/${SHOP}/../${OTHER_SHOP}/${ID(1)}.jpg`,
    `${BASE}assisted/${SHOP}/sub/${ID(1)}.jpg`,
    `${photoUrl(1)}?x=1`,
    `https://evil.example/storage/v1/object/public/kitchen-photos/assisted/${SHOP}/${ID(1)}.jpg`,
    "javascript:alert(1)",
    "",
    null,
  ]) {
    assert.equal(isOwnAssistedPhotoUrl(bad, SHOP, BASE), false, String(bad));
  }
});

const draftShop = { "assisted_shops.select": ok({ id: SHOP, status: "draft" }) };

test("apply: sets photo_url one item at a time with the stale check; skips existing; one failure doesn't stop the rest", async () => {
  const { calls, client } = fakeSupabase({
    ...draftShop,
    "assisted_shop_items.select": ok([row(1), row(2, { photo_url: "https://x/old.jpg" }), row(3)]),
    "assisted_shop_items.update": [fail("new row violates row-level security policy"), ok([row(3, { photo_url: photoUrl(3) })])],
  });
  const result = await setDraftItemPhotosWith(
    client,
    SHOP,
    [
      { itemId: ID(1), photoUrl: photoUrl(1) },
      { itemId: ID(2), photoUrl: photoUrl(2) },
      { itemId: ID(3), photoUrl: photoUrl(3) },
    ],
    false
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].itemId, ID(1));
  assert.match(result.failed[0].message, /refused this change/);

  const updates = calls.filter((c) => c.op === "update");
  assert.equal(updates.length, 2, "item 2 (has a photo) is never sent");
  for (const u of updates) {
    assert.deepEqual(Object.keys(u.values as object), ["photo_url"], "photo_url only");
    assert.deepEqual(u.filters.map((f) => f[0]), ["id", "shop_id", "updated_at"]);
    assert.equal(u.filters[2][1], LOADED);
  }
  assert.deepEqual(updates.map((u) => (u.values as { photo_url: string }).photo_url), [photoUrl(1), photoUrl(3)]);
});

test("apply with replace: items that already have a photo get the new one", async () => {
  const { calls, client } = fakeSupabase({
    ...draftShop,
    "assisted_shop_items.select": ok([row(2, { photo_url: "https://x/old.jpg" })]),
    "assisted_shop_items.update": ok([row(2, { photo_url: photoUrl(2) })]),
  });
  const result = await setDraftItemPhotosWith(client, SHOP, [{ itemId: ID(2), photoUrl: photoUrl(2) }], true);
  assert.deepEqual(result.ok && [result.updated, result.skipped, result.failed.length], [1, 0, 0]);
  assert.equal(calls.filter((c) => c.op === "update").length, 1);
});

test("apply: a claimed or cancelled shop is refused before any item is touched", async () => {
  for (const status of ["claimed", "cancelled"]) {
    const { calls, client } = fakeSupabase({
      "assisted_shops.select": ok({ id: SHOP, status }),
      "assisted_shop_items.select": ok([row(1)]),
    });
    const result = await setDraftItemPhotosWith(client, SHOP, [{ itemId: ID(1), photoUrl: photoUrl(1) }], false);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /claimed or cancelled/);
    assert.deepEqual(calls.filter((c) => c.name === "assisted_shop_items"), []);
  }
  const missing = fakeSupabase({ "assisted_shops.select": ok(null) });
  const r = await setDraftItemPhotosWith(missing.client, SHOP, [{ itemId: ID(1), photoUrl: photoUrl(1) }], false);
  assert.equal(r.ok, false);
});

test("apply: refuses another shop's photo, an outside link, a repeated item, an item not in the draft, bad input", async () => {
  const cases: [unknown, unknown, RegExp][] = [
    [[{ itemId: ID(1), photoUrl: photoUrl(1, OTHER_SHOP) }], false, /only photos uploaded to this draft shop/],
    [[{ itemId: ID(1), photoUrl: "https://example.com/a.jpg" }], false, /only photos uploaded to this draft shop/],
    [[{ itemId: ID(1), photoUrl: photoUrl(1) }, { itemId: ID(1), photoUrl: photoUrl(2) }], false, /same item is paired with two photos/],
    [[{ itemId: "nope", photoUrl: photoUrl(1) }], false, /invalid item id/],
    [[], false, /no photos are paired/],
    ["x", false, /no photos are paired/],
    [[{ itemId: ID(1), photoUrl: photoUrl(1) }], "yes", /choose whether to replace/],
  ];
  for (const [assignments, replace, message] of cases) {
    const { calls, client } = fakeSupabase(draftShop);
    const result = await setDraftItemPhotosWith(client, SHOP, assignments, replace);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", message);
    assert.deepEqual(calls.filter((c) => c.op === "update"), []);
  }
  const notInDraft = fakeSupabase({ ...draftShop, "assisted_shop_items.select": ok([row(2)]) });
  const r = await setDraftItemPhotosWith(notInDraft.client, SHOP, [{ itemId: ID(1), photoUrl: photoUrl(1) }], false);
  assert.match(!r.ok ? r.message : "", /isn't in this draft menu/);
  assert.deepEqual(notInDraft.calls.filter((c) => c.op === "update"), []);
  const badShop = await setDraftItemPhotosWith(fakeSupabase({}).client, "not-a-uuid", [], false);
  assert.equal(badShop.ok, false);
});

test("bulk apply notice", () => {
  assert.equal(bulkApplyNotice(3, 0, 0), "Photo set on 3 items.");
  assert.equal(bulkApplyNotice(1, 2, 1), "Photo set on 1 item · 2 items skipped (already had a photo) · 1 item not saved.");
  assert.equal(bulkApplyNotice(0, 0, 0), "No photos set.");
});

// --- Wiring ---

const SRC = fileURLToPath(new URL("..", import.meta.url));
const file = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

test("the panel is only inside the draft menu editor; it uploads to assisted/<shopId>/ and saves only through setAssistedItemPhotos", () => {
  const editor = file("components/AssistedMenuEditor.tsx");
  assert.match(editor, /<AssistedBulkPhotos shopId=\{shopId\}/);
  const page = file("app/merchants/assisted/[id]/page.tsx");
  assert.doesNotMatch(page, /AssistedBulkPhotos/, "the page only shows AssistedMenuEditor for drafts");
  assert.match(page, /isDraft \? \(\s*<AssistedMenuEditor/);
  const panel = file("components/AssistedBulkPhotos.tsx");
  assert.match(panel, /assistedPhotoPath\(shopId, photo, crypto\.randomUUID\(\)\)/);
  assert.match(panel, /upsert: false/);
  assert.match(panel, /setAssistedItemPhotos\(shopId, plan\.updates, replaceExisting\)/);
  assert.match(panel, /BULK_UPLOAD_CONCURRENCY/);
  assert.doesNotMatch(panel, /\.from\("assisted_shop_items"\)|\.rpc\(/, "no direct table writes from the browser");
});
