/**
 * HQ edits a merchant's kitchen and menu (docs/supabase-kitchen-admin-edit.sql).
 *
 * The ONLY place Boss writes to kitchens or menu_items for this feature.
 * actions.ts calls these after assertAdmin(); the browser never writes.
 *
 * Rules the database also enforces (a_kitchen_admin_guard, a_menu_item_admin_guard):
 * - kitchens: UPDATE only, never insert/upsert (an upsert is an INSERT first,
 *   which trips the partner terms trigger). Explicit columns, exactly
 *   KITCHEN_SAVE_COLUMNS. Never the terms acknowledgement, PayNow, opening
 *   hours, is_blocked, business_uen or anything the database derives.
 * - menu_items: insert a new item, update name/price/photo, hide/unhide.
 *   No delete: hiding keeps the row and its history.
 * - Stale-edit check: every update carries the updated_at the admin loaded.
 *   0 rows back = someone changed it since; nothing is overwritten.
 *
 * Nothing here throws: problems come back as a message for the form.
 * Pure module (type-only imports) so `node --test` can load it with a fake client.
 */
import type { AnyClient } from "./admin-guard.ts";
import type { CuisineType, MenuItem, MerchantCategory } from "./types-kitchen.ts";
import { NO_UEN_MESSAGE } from "./kitchen-uen.ts";

export const MERCHANT_CATEGORIES: readonly { id: MerchantCategory; label: string }[] = [
  { id: "home-cook", label: "Home Cook" },
  { id: "hawker", label: "Hawker" },
  { id: "bakery", label: "Bakery" },
  { id: "vegetarian", label: "Vegetarian" },
  { id: "drinks-desserts", label: "Drinks & Desserts" },
];

export const CUISINE_TYPES: readonly { id: CuisineType; label: string }[] = [
  { id: "chinese", label: "Chinese" },
  { id: "halal", label: "Halal" },
  { id: "indian", label: "Indian" },
  { id: "western", label: "Western" },
];

/** Exactly the kitchens columns an HQ profile save sends. */
export const KITCHEN_SAVE_COLUMNS = [
  "business_name",
  "category",
  "cuisine_type",
  "is_halal",
  "description",
  "hero_image",
  "is_live",
] as const;

/** What a menu item write returns (same as MERCHANT_EDIT_MENU_COLUMNS). */
const MENU_RETURN_COLUMNS = "id, kitchen_id, name, price, photo_url, is_hidden, updated_at, created_at";

export const BUSINESS_NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
export const ITEM_NAME_MAX = 80;
/** menu_items.price is numeric(6,2). */
export const PRICE_MAX = 9999.99;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export type KitchenProfile = {
  business_name: string;
  category: MerchantCategory;
  cuisine_type: CuisineType;
  is_halal: boolean;
  description: string | null;
  hero_image: string | null;
  is_live: boolean;
};

export type MenuItemFields = { name: string; price: number; photo_url: string | null };
/** What the form sends: price as typed ("4.50"); validateMenuItem turns it into MenuItemFields. */
export type MenuItemInput = { name: string; price: number | string; photo_url: string | null; /** Assisted drafts only; the live menu has no category. */ category?: string | null; /** Assisted drafts only. */ owner_note?: string | null };

export type KitchenSaveResult = { ok: true; updatedAt: string } | { ok: false; message: string; stale?: boolean };
export type MenuItemResult = { ok: true; item: MenuItem } | { ok: false; message: string; stale?: boolean };

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STALE_KITCHEN_MESSAGE =
  "Not saved: this kitchen was changed after you opened it (by the cook, another admin, or a block/reinstate). Reload the page to see the latest version, then make your change again.";
export const STALE_ITEM_MESSAGE =
  "Not saved: this menu item was changed after you opened the page (by the cook or another admin). Reload the page to see the latest version, then try again.";

// --- Validation (a direct POST can send anything) ---

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** '' or missing -> null; otherwise an http(s) URL, or an error. */
export function optionalUrl(value: unknown, what: string): Checked<string | null> {
  const v = text(value);
  if (!v) return { ok: true, value: null };
  if (v.length > 2000) return { ok: false, message: `The ${what} link is too long.` };
  try {
    const url = new URL(v);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    return { ok: false, message: `The ${what} must be an uploaded photo or a web link starting with https://.` };
  }
  return { ok: true, value: v };
}

export function validateKitchenProfile(input: unknown): Checked<KitchenProfile> {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const business_name = text(p.business_name);
  if (!business_name) return { ok: false, message: "Business name is required." };
  if (business_name.length > BUSINESS_NAME_MAX) {
    return { ok: false, message: `Business name can be at most ${BUSINESS_NAME_MAX} characters.` };
  }
  const category = MERCHANT_CATEGORIES.find((c) => c.id === p.category)?.id;
  if (!category) return { ok: false, message: "Pick a category." };
  const cuisine_type = CUISINE_TYPES.find((c) => c.id === p.cuisine_type)?.id;
  if (!cuisine_type) return { ok: false, message: "Pick a cuisine." };
  if (typeof p.is_halal !== "boolean") return { ok: false, message: "Halal must be yes or no." };
  if (typeof p.is_live !== "boolean") return { ok: false, message: "Live must be yes or no." };
  const description = text(p.description);
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, message: `Description can be at most ${DESCRIPTION_MAX} characters.` };
  }
  const hero = optionalUrl(p.hero_image, "kitchen photo");
  if (!hero.ok) return hero;
  return {
    ok: true,
    value: {
      business_name,
      category,
      cuisine_type,
      is_halal: p.is_halal,
      description: description || null,
      hero_image: hero.value,
      is_live: p.is_live,
    },
  };
}

export function validateMenuItem(input: unknown): Checked<MenuItemFields> {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = text(p.name);
  if (!name) return { ok: false, message: "Item name is required." };
  if (name.length > ITEM_NAME_MAX) return { ok: false, message: `Item name can be at most ${ITEM_NAME_MAX} characters.` };
  const raw = typeof p.price === "number" ? p.price : typeof p.price === "string" ? Number(p.price.trim().replace(/^\$/, "")) : NaN;
  if (!Number.isFinite(raw)) return { ok: false, message: "Price must be a number, like 4.50." };
  const price = Math.round(raw * 100) / 100;
  if (price <= 0) return { ok: false, message: "Price must be more than $0." };
  if (price > PRICE_MAX) return { ok: false, message: `Price can be at most $${PRICE_MAX}.` };
  const photo = optionalUrl(p.photo_url, "item photo");
  if (!photo.ok) return photo;
  return { ok: true, value: { name, price, photo_url: photo.value } };
}

function checkIds(...ids: unknown[]): string | null {
  return ids.every((id) => typeof id === "string" && UUID.test(id)) ? null : "Not saved: invalid kitchen or item id.";
}

function checkStamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value))
    ? null
    : "Not saved: the page is missing the version it loaded. Reload the page and try again.";
}

// --- Database errors -> words an admin can act on ---

/** Turns a database refusal (guard, terms trigger, constraint, RLS) into a message for the form. */
export function friendlyKitchenError(message: string): string {
  const m = message ?? "";
  if (/Please acknowledge the Kopi Boy partner terms/i.test(m)) {
    return "Not saved: the cook hasn't accepted the Kopi Boy partner terms. Only the cook can do that, in the Partner app.";
  }
  if (/HQ cannot set or change the partner terms/i.test(m)) {
    return "Not saved: only the cook can accept the Kopi Boy partner terms, in the Partner app. HQ can't change that.";
  }
  if (/can't go live until the cook accepts the partner terms/i.test(m)) {
    return "Can't put this kitchen live yet: the cook hasn't accepted the Kopi Boy partner terms in the Partner app. Untick Live to save your other changes.";
  }
  if (/can't go live until the cook has saved a pickup address/i.test(m)) {
    return "Can't put this kitchen live yet: the cook hasn't saved a pickup address in the Partner app. Untick Live to save your other changes.";
  }
  if (/can't go live without at least one visible menu item/i.test(m)) {
    return "Can't put this kitchen live yet: it needs at least one menu item that isn't hidden. Untick Live to save your other changes.";
  }
  if (/Add your business UEN/i.test(m)) return NO_UEN_MESSAGE;  // y_kitchen_live_needs_uen
  if (/kitchen is blocked/i.test(m)) {
    return "Can't put this kitchen live: the merchant is blocked. Reinstate them on the Merchants page first.";
  }
  if (/HQ cannot create or upsert a kitchen/i.test(m)) {
    return "Not saved: HQ can only edit an existing kitchen, not create one.";
  }
  const field = /HQ cannot change (.+) on a (kitchen|menu item)/i.exec(m);
  if (field) return `Not saved: HQ can't change ${field[1]} from this screen.`;
  if (/check constraint/i.test(m)) {
    return "Not saved: one of the values isn't allowed. Check the category, cuisine and prices.";
  }
  if (/permission denied|row-level security/i.test(m)) {
    return "Not saved: the database refused this change for your account.";
  }
  return `Not saved: ${m || "unknown error"}`;
}

// --- Writes ---

type Row = Record<string, unknown>;
const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : []);

/**
 * Saves the kitchen profile: UPDATE kitchens SET <KITCHEN_SAVE_COLUMNS>
 * WHERE id = kitchenId AND updated_at = loadedUpdatedAt.
 */
export async function saveKitchenProfileWith(
  supabase: AnyClient,
  kitchenId: unknown,
  loadedUpdatedAt: unknown,
  input: unknown
): Promise<KitchenSaveResult> {
  const badId = checkIds(kitchenId) ?? checkStamp(loadedUpdatedAt);
  if (badId) return { ok: false, message: badId };
  const checked = validateKitchenProfile(input);
  if (!checked.ok) return checked;

  const row: Record<(typeof KITCHEN_SAVE_COLUMNS)[number], unknown> = {
    business_name: checked.value.business_name,
    category: checked.value.category,
    cuisine_type: checked.value.cuisine_type,
    is_halal: checked.value.is_halal,
    description: checked.value.description,
    hero_image: checked.value.hero_image,
    is_live: checked.value.is_live,
  };

  try {
    const { data, error } = await supabase
      .from("kitchens")
      .update(row)
      .eq("id", kitchenId)
      .eq("updated_at", loadedUpdatedAt)
      .select("id, updated_at");
    if (error) return { ok: false, message: friendlyKitchenError(error.message) };
    const saved = rowsOf(data)[0];
    if (!saved) return { ok: false, message: STALE_KITCHEN_MESSAGE, stale: true };
    return { ok: true, updatedAt: String(saved.updated_at) };
  } catch (e) {
    return { ok: false, message: friendlyKitchenError(e instanceof Error ? e.message : String(e)) };
  }
}

function toItem(row: Row | undefined): MenuItem | null {
  if (!row || typeof row.id !== "string") return null;
  return {
    id: row.id,
    kitchen_id: String(row.kitchen_id),
    name: String(row.name ?? ""),
    price: Number(row.price),
    photo_url: (row.photo_url as string | null) ?? null,
    is_hidden: row.is_hidden === true,
    updated_at: String(row.updated_at),
    created_at: String(row.created_at),
  };
}

/** Adds a visible item: INSERT menu_items (kitchen_id, name, price, photo_url). Never sends an id. */
export async function addMenuItemWith(supabase: AnyClient, kitchenId: unknown, input: unknown): Promise<MenuItemResult> {
  const badId = checkIds(kitchenId);
  if (badId) return { ok: false, message: badId };
  const checked = validateMenuItem(input);
  if (!checked.ok) return checked;
  try {
    const { data, error } = await supabase
      .from("menu_items")
      .insert({ kitchen_id: kitchenId, ...checked.value })
      .select(MENU_RETURN_COLUMNS);
    if (error) return { ok: false, message: friendlyKitchenError(error.message) };
    const item = toItem(rowsOf(data)[0]);
    if (!item) return { ok: false, message: "Not saved: the database didn't return the new item. Reload the page to check." };
    return { ok: true, item };
  } catch (e) {
    return { ok: false, message: friendlyKitchenError(e instanceof Error ? e.message : String(e)) };
  }
}

async function updateItem(
  supabase: AnyClient,
  kitchenId: unknown,
  itemId: unknown,
  loadedUpdatedAt: unknown,
  values: Partial<MenuItemFields> & { is_hidden?: boolean }
): Promise<MenuItemResult> {
  const badId = checkIds(kitchenId, itemId) ?? checkStamp(loadedUpdatedAt);
  if (badId) return { ok: false, message: badId };
  try {
    const { data, error } = await supabase
      .from("menu_items")
      .update(values)
      .eq("id", itemId)
      .eq("kitchen_id", kitchenId)
      .eq("updated_at", loadedUpdatedAt)
      .select(MENU_RETURN_COLUMNS);
    if (error) return { ok: false, message: friendlyKitchenError(error.message) };
    const item = toItem(rowsOf(data)[0]);
    if (!item) return { ok: false, message: STALE_ITEM_MESSAGE, stale: true };
    return { ok: true, item };
  } catch (e) {
    return { ok: false, message: friendlyKitchenError(e instanceof Error ? e.message : String(e)) };
  }
}

/** Edits name, price and photo of one item of this kitchen. */
export async function updateMenuItemWith(
  supabase: AnyClient,
  kitchenId: unknown,
  itemId: unknown,
  loadedUpdatedAt: unknown,
  input: unknown
): Promise<MenuItemResult> {
  const checked = validateMenuItem(input);
  if (!checked.ok) return checked;
  return updateItem(supabase, kitchenId, itemId, loadedUpdatedAt, checked.value);
}

/** Hides (or shows again) one item of this kitchen. Never deletes. */
export async function setMenuItemHiddenWith(
  supabase: AnyClient,
  kitchenId: unknown,
  itemId: unknown,
  loadedUpdatedAt: unknown,
  hidden: unknown
): Promise<MenuItemResult> {
  if (typeof hidden !== "boolean") return { ok: false, message: "Not saved: hidden must be yes or no." };
  return updateItem(supabase, kitchenId, itemId, loadedUpdatedAt, { is_hidden: hidden });
}

// --- Photos ---

const PHOTO_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Where HQ uploads a photo in the kitchen-photos bucket: <kitchenId>/hq/<uuid>.<ext>
 * (the only path the "Admins can upload kitchen photos for any kitchen" policy allows).
 */
export function hqPhotoPath(
  kitchenId: string,
  file: { type: string; size: number },
  uuid: string
): { ok: true; path: string } | { ok: false; message: string } {
  if (!UUID.test(kitchenId)) return { ok: false, message: "Invalid kitchen id." };
  const ext = PHOTO_EXT[file.type];
  if (!ext) return { ok: false, message: "Use a JPG, PNG or WebP photo." };
  if (file.size > PHOTO_MAX_BYTES) return { ok: false, message: "That photo is over 5 MB. Pick a smaller one." };
  return { ok: true, path: `${kitchenId}/hq/${uuid}.${ext}` };
}

// --- Change history ---

export type AuditRow = {
  id: number;
  created_at: string;
  admin_id: string;
  target_table: "kitchens" | "menu_items";
  target_id: string;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }>;
  reason: string | null;
};

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  update: "Edited the kitchen",
  paynow_update: "Changed PayNow details",
  menu_item_added: "Added a menu item",
  menu_item_updated: "Edited a menu item",
  menu_item_hidden: "Hid a menu item",
  menu_item_unhidden: "Showed a menu item again",
};

/** One audit value for display. PayNow is already masked by the database. */
export function auditValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (value === true) return "yes";
  if (value === false) return "no";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
