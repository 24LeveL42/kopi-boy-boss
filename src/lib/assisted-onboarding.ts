/**
 * Assisted onboarding (docs/supabase-assisted-onboarding.sql): HQ sets up a
 * draft shop for an owner who has no Google account or email, then sends a
 * one-time claim link on WhatsApp. The owner claims it in the Partner app.
 *
 * The ONLY place Boss writes assisted_shops / assisted_shop_items or calls
 * the admin_*_assisted_* functions. actions.ts calls these after
 * assertAdmin(); the browser never writes.
 *
 * Rules (the database enforces them too):
 * - Explicit columns, exactly DRAFT_SAVE_COLUMNS. Never status, the claim
 *   fields or anything the database fills in. pricing_plan is left alone:
 *   it is unused during the pilot (Kopi Boy is free for merchants) and must
 *   stay empty.
 * - Never PayNow: the owner enters it in the Partner app after claiming.
 * - Draft items: add, edit, hide/unhide. No delete.
 * - Stale-edit check: every update carries the updated_at HQ loaded.
 * - Claim token: 32 random bytes, base64url (43 characters). Only its
 *   SHA-256 hex goes to the database. The raw token is returned once, to the
 *   admin who issued it, and is never logged or stored.
 *
 * Nothing here throws: problems come back as a message for the form.
 * Pure module (type-only imports, Web Crypto) so `node --test` can load it
 * with a fake client, and client components can share its constants.
 */
import type { AnyClient } from "./admin-guard.ts";
import type { CuisineType, MenuItem, MerchantCategory } from "./types-kitchen.ts";
import { MERCHANT_CATEGORIES, PHOTO_MAX_BYTES, validateKitchenProfile, validateMenuItem } from "./kitchen-admin.ts";

// --- Types and column lists ---

export type AssistedShopStatus = "draft" | "claimed" | "cancelled";

export interface AssistedShop {
  id: string;
  status: AssistedShopStatus;
  business_name: string;
  category: MerchantCategory;
  cuisine_type: CuisineType;
  is_halal: boolean;
  description: string | null;
  hero_image: string | null;
  owner_name: string;
  owner_mobile: string;
  business_uen: string | null;
  business_address: string | null;
  postal_code: string | null;
  pricing_plan: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  claimed_user_id: string | null;
  claimed_at: string | null;
  acknowledged_at: string | null;
}

export type AssistedShopListRow = Pick<
  AssistedShop,
  "id" | "status" | "business_name" | "category" | "owner_name" | "owner_mobile" | "created_at" | "claimed_user_id" | "claimed_at" | "cancelled_at"
>;

export type ClaimLinkState = "live" | "expired" | "used" | "revoked";

export interface ClaimLink {
  id: string;
  state: ClaimLinkState;
  created_at: string;
  created_by: string;
  expires_at: string;
  sent_at: string | null;
  used_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface AssistedAuditRow {
  id: number;
  created_at: string;
  actor_id: string | null;
  actor_kind: "admin" | "owner";
  shop_id: string;
  shop_name: string | null;
  token_id: string | null;
  kitchen_id: string | null;
  action: string;
  details: Record<string, unknown>;
}

/** Assisted shops list. */
export const ASSISTED_SHOP_LIST_COLUMNS =
  "id, status, business_name, category, owner_name, owner_mobile, created_at, claimed_user_id, claimed_at, cancelled_at";

/** One draft: every AssistedShop field (granted to authenticated; RLS: admins only). */
export const ASSISTED_SHOP_COLUMNS =
  "id, status, business_name, category, cuisine_type, is_halal, description, hero_image, owner_name, owner_mobile, business_uen, business_address, postal_code, pricing_plan, created_by, created_at, updated_at, cancelled_at, claimed_user_id, claimed_at, acknowledged_at";

/** Draft menu items; read as MenuItem-shaped rows (kitchen_id = the shop id) by toDraftItem. */
export const ASSISTED_ITEM_COLUMNS = "id, shop_id, name, price, photo_url, is_hidden, created_at, updated_at";

export const ASSISTED_AUDIT_COLUMNS = "id, created_at, actor_id, actor_kind, shop_id, shop_name, token_id, kitchen_id, action, details";

/** Exactly the assisted_shops columns an HQ create or save sends. */
export const DRAFT_SAVE_COLUMNS = [
  "business_name",
  "category",
  "cuisine_type",
  "is_halal",
  "description",
  "hero_image",
  "owner_name",
  "owner_mobile",
  "business_uen",
  "business_address",
  "postal_code",
] as const;

export type DraftShopFields = {
  business_name: string;
  category: MerchantCategory;
  cuisine_type: CuisineType;
  is_halal: boolean;
  description: string | null;
  hero_image: string | null;
  owner_name: string;
  owner_mobile: string;
  business_uen: string | null;
  business_address: string | null;
  postal_code: string | null;
};

export type DraftSaveResult = { ok: true; id: string; updatedAt: string } | { ok: false; message: string; stale?: boolean };
export type DraftItemResult = { ok: true; item: MenuItem } | { ok: false; message: string; stale?: boolean };
export type IssueLinkResult =
  | { ok: true; tokenId: string; expiresAt: string; token: string; link: string }
  | { ok: false; message: string };
export type SimpleResult = { ok: true } | { ok: false; message: string };

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

export const OWNER_NAME_MAX = 80;
export const ADDRESS_MAX = 300;
export const REASON_MAX = 200;
export const CLAIM_LINK_HOURS = 48;
export const CLAIM_LINK_BASE = "https://partners.kopi-boy.com/claim";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same pattern as the assisted_shops.business_uen CHECK. */
const UEN = /^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const STALE_DRAFT_MESSAGE =
  "Not saved: this draft was changed after you opened it (by another admin), or it has been claimed or cancelled. Reload the page to see the latest version.";
export const STALE_DRAFT_ITEM_MESSAGE =
  "Not saved: this draft menu item was changed after you opened the page, or the shop has been claimed or cancelled. Reload the page and try again.";

// --- Validation (a direct POST can send anything) ---

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A Singapore mobile as the database stores it: 8 digits starting with 8 or
 * 9. Spaces, dashes and a +65 / 65 prefix are dropped. null if it isn't one.
 */
export function normalizeOwnerMobile(value: unknown): string | null {
  let digits = text(value).replace(/[\s\-()]/g, "");
  if (digits.startsWith("+65")) digits = digits.slice(3);
  else if (digits.length === 10 && digits.startsWith("65")) digits = digits.slice(2);
  return /^[89][0-9]{7}$/.test(digits) ? digits : null;
}

export function validateDraftShop(input: unknown): Checked<DraftShopFields> {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  // Same rules and messages as an HQ kitchen save; is_live doesn't apply to a draft.
  const profile = validateKitchenProfile({ ...p, is_live: false });
  if (!profile.ok) return profile;

  const owner_name = text(p.owner_name);
  if (!owner_name) return { ok: false, message: "Owner name is required." };
  if (owner_name.length > OWNER_NAME_MAX) return { ok: false, message: `Owner name can be at most ${OWNER_NAME_MAX} characters.` };

  const owner_mobile = normalizeOwnerMobile(p.owner_mobile);
  if (!owner_mobile) {
    return { ok: false, message: "Owner mobile must be a Singapore mobile number: 8 digits starting with 8 or 9." };
  }

  const business_uen = text(p.business_uen).toUpperCase() || null;
  if (business_uen && !UEN.test(business_uen)) {
    return { ok: false, message: "That UEN doesn't look right. It's 9 or 10 characters, like 53123456A or 201912345K." };
  }

  const business_address = text(p.business_address) || null;
  if (business_address && business_address.length > ADDRESS_MAX) {
    return { ok: false, message: `Pickup address can be at most ${ADDRESS_MAX} characters.` };
  }
  const postal_code = text(p.postal_code) || null;
  if (postal_code && !/^[0-9]{6}$/.test(postal_code)) return { ok: false, message: "Postal code must be 6 digits." };

  const { business_name, category, cuisine_type, is_halal, description, hero_image } = profile.value;
  return {
    ok: true,
    value: {
      business_name,
      category,
      cuisine_type,
      is_halal,
      description,
      hero_image,
      owner_name,
      owner_mobile,
      business_uen,
      business_address,
      postal_code,
    },
  };
}

/**
 * What's still missing before a claim link can be issued. Mirrors the
 * checks in admin_issue_assisted_claim_link (the database decides).
 */
export function claimReadiness(
  shop: Pick<AssistedShop, "status" | "category" | "business_uen" | "business_address" | "postal_code">,
  items: Pick<MenuItem, "is_hidden">[]
): string[] {
  if (shop.status !== "draft") return ["This shop is no longer a draft."];
  const missing: string[] = [];
  if (!shop.business_address) missing.push("Pickup address");
  if (!shop.postal_code) missing.push("Postal code");
  if (shop.category !== "home-cook" && !shop.business_uen) missing.push("Business UEN (needed for every category except Home Cook)");
  if (!items.some((i) => !i.is_hidden)) missing.push("At least one menu item that isn't hidden");
  return missing;
}

function checkIds(...ids: unknown[]): string | null {
  return ids.every((id) => typeof id === "string" && UUID.test(id)) ? null : "Not saved: invalid shop, item or link id.";
}

function checkStamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value))
    ? null
    : "Not saved: the page is missing the version it loaded. Reload the page and try again.";
}

function checkReason(value: unknown): Checked<string> {
  const reason = text(value);
  if (!reason) return { ok: false, message: "Give a reason." };
  if (reason.length > REASON_MAX) return { ok: false, message: `The reason can be at most ${REASON_MAX} characters.` };
  return { ok: true, value: reason };
}

// --- Claim token and link ---

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new raw claim token: 32 random bytes, base64url, 43 characters. */
export function newClaimToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** What the database stores and the Partner app looks up: lowercase hex SHA-256 of the token's UTF-8 bytes. */
export async function hashClaimToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** https://partners.kopi-boy.com/claim#<token>. The token is in the #fragment so it never reaches a server log. */
export function claimLinkFor(token: string): string {
  if (!TOKEN.test(token)) throw new Error("Invalid claim token.");
  return `${CLAIM_LINK_BASE}#${token}`;
}

const SGT = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function formatSgt(iso: string): string {
  return SGT.format(new Date(iso));
}

/** The WhatsApp message HQ sends with the link. */
export function claimMessage({
  ownerName,
  businessName,
  link,
  expiresAt,
}: {
  ownerName: string;
  businessName: string;
  link: string;
  expiresAt: string;
}): string {
  const name = ownerName.trim().replace(/\s+/g, " ");
  return [
    `Hi ${name}, this is Kopi Boy HQ.`,
    `We've set up ${businessName.trim()} on Kopi Boy for you. Tap this link to check your shop and claim it:`,
    link,
    `The link works once and expires on ${formatSgt(expiresAt)}. Please don't forward it to anyone.`,
    "After you claim it, add your PayNow details and your shop goes live.",
  ].join("\n\n");
}

/** wa.me link to the owner's Singapore mobile with the message filled in. */
export function whatsappUrl(ownerMobile: string, message: string): string {
  const mobile = normalizeOwnerMobile(ownerMobile);
  if (!mobile) throw new Error("Invalid owner mobile.");
  return `https://wa.me/65${mobile}?text=${encodeURIComponent(message)}`;
}

// --- Database errors -> words an admin can act on ---

export function friendlyAssistedError(message: string, prefix = "Not saved"): string {
  const m = message ?? "";
  if (/assisted_shops_open_mobile_idx/i.test(m)) {
    return `${prefix}: there's already an open draft for this owner's mobile number. Open that draft instead, or cancel it first.`;
  }
  if (/assisted_claim_tokens_one_open_idx/i.test(m)) {
    return `${prefix}: another link was issued for this shop at the same moment. Reload the page.`;
  }
  if (/check constraint/i.test(m)) {
    return `${prefix}: one of the values isn't allowed. Check the category, cuisine, mobile, UEN, postal code and prices.`;
  }
  if (/permission denied|row-level security/i.test(m)) {
    return `${prefix}: the database refused this change for your account.`;
  }
  return `${prefix}: ${m || "unknown error"}`;
}

// --- Draft shop writes ---

type Row = Record<string, unknown>;
const rowsOf = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : []);

function draftRow(v: DraftShopFields): Record<(typeof DRAFT_SAVE_COLUMNS)[number], unknown> {
  return {
    business_name: v.business_name,
    category: v.category,
    cuisine_type: v.cuisine_type,
    is_halal: v.is_halal,
    description: v.description,
    hero_image: v.hero_image,
    owner_name: v.owner_name,
    owner_mobile: v.owner_mobile,
    business_uen: v.business_uen,
    business_address: v.business_address,
    postal_code: v.postal_code,
  };
}

/** Creates a draft: INSERT assisted_shops (DRAFT_SAVE_COLUMNS). The database sets status, created_by and the dates. */
export async function createDraftShopWith(supabase: AnyClient, input: unknown): Promise<DraftSaveResult> {
  const checked = validateDraftShop(input);
  if (!checked.ok) return checked;
  try {
    const { data, error } = await supabase.from("assisted_shops").insert(draftRow(checked.value)).select("id, updated_at");
    if (error) return { ok: false, message: friendlyAssistedError(error.message) };
    const saved = rowsOf(data)[0];
    if (!saved || typeof saved.id !== "string") {
      return { ok: false, message: "Not saved: the database didn't return the new draft. Check the assisted shops list." };
    }
    return { ok: true, id: saved.id, updatedAt: String(saved.updated_at) };
  } catch (e) {
    return { ok: false, message: friendlyAssistedError(e instanceof Error ? e.message : String(e)) };
  }
}

/** Saves a draft: UPDATE assisted_shops SET <DRAFT_SAVE_COLUMNS> WHERE id AND updated_at AND status = 'draft'. */
export async function saveDraftShopWith(
  supabase: AnyClient,
  shopId: unknown,
  loadedUpdatedAt: unknown,
  input: unknown
): Promise<DraftSaveResult> {
  const bad = checkIds(shopId) ?? checkStamp(loadedUpdatedAt);
  if (bad) return { ok: false, message: bad };
  const checked = validateDraftShop(input);
  if (!checked.ok) return checked;
  try {
    const { data, error } = await supabase
      .from("assisted_shops")
      .update(draftRow(checked.value))
      .eq("id", shopId)
      .eq("updated_at", loadedUpdatedAt)
      .eq("status", "draft")
      .select("id, updated_at");
    if (error) return { ok: false, message: friendlyAssistedError(error.message) };
    const saved = rowsOf(data)[0];
    if (!saved) return { ok: false, message: STALE_DRAFT_MESSAGE, stale: true };
    return { ok: true, id: String(saved.id), updatedAt: String(saved.updated_at) };
  } catch (e) {
    return { ok: false, message: friendlyAssistedError(e instanceof Error ? e.message : String(e)) };
  }
}

// --- Draft menu items ---

/** A draft item in the shape MenuItemsEditor shows (kitchen_id = the shop id). */
export function toDraftItem(row: Row | undefined): MenuItem | null {
  if (!row || typeof row.id !== "string") return null;
  return {
    id: row.id,
    kitchen_id: String(row.shop_id),
    name: String(row.name ?? ""),
    price: Number(row.price),
    photo_url: (row.photo_url as string | null) ?? null,
    is_hidden: row.is_hidden === true,
    updated_at: String(row.updated_at),
    created_at: String(row.created_at),
  };
}

/** Adds a visible draft item: INSERT assisted_shop_items (shop_id, name, price, photo_url). */
export async function addDraftItemWith(supabase: AnyClient, shopId: unknown, input: unknown): Promise<DraftItemResult> {
  const bad = checkIds(shopId);
  if (bad) return { ok: false, message: bad };
  const checked = validateMenuItem(input);
  if (!checked.ok) return checked;
  try {
    const { data, error } = await supabase
      .from("assisted_shop_items")
      .insert({ shop_id: shopId, ...checked.value })
      .select(ASSISTED_ITEM_COLUMNS);
    if (error) return { ok: false, message: friendlyAssistedError(error.message) };
    const item = toDraftItem(rowsOf(data)[0]);
    if (!item) return { ok: false, message: "Not saved: the database didn't return the new item. Reload the page to check." };
    return { ok: true, item };
  } catch (e) {
    return { ok: false, message: friendlyAssistedError(e instanceof Error ? e.message : String(e)) };
  }
}

async function updateDraftItem(
  supabase: AnyClient,
  shopId: unknown,
  itemId: unknown,
  loadedUpdatedAt: unknown,
  values: { name?: string; price?: number; photo_url?: string | null; is_hidden?: boolean }
): Promise<DraftItemResult> {
  const bad = checkIds(shopId, itemId) ?? checkStamp(loadedUpdatedAt);
  if (bad) return { ok: false, message: bad };
  try {
    const { data, error } = await supabase
      .from("assisted_shop_items")
      .update(values)
      .eq("id", itemId)
      .eq("shop_id", shopId)
      .eq("updated_at", loadedUpdatedAt)
      .select(ASSISTED_ITEM_COLUMNS);
    if (error) return { ok: false, message: friendlyAssistedError(error.message) };
    const item = toDraftItem(rowsOf(data)[0]);
    if (!item) return { ok: false, message: STALE_DRAFT_ITEM_MESSAGE, stale: true };
    return { ok: true, item };
  } catch (e) {
    return { ok: false, message: friendlyAssistedError(e instanceof Error ? e.message : String(e)) };
  }
}

export async function updateDraftItemWith(
  supabase: AnyClient,
  shopId: unknown,
  itemId: unknown,
  loadedUpdatedAt: unknown,
  input: unknown
): Promise<DraftItemResult> {
  const checked = validateMenuItem(input);
  if (!checked.ok) return checked;
  return updateDraftItem(supabase, shopId, itemId, loadedUpdatedAt, checked.value);
}

/** Hides (or shows again) one draft item. Never deletes. Hidden items are not copied at claim. */
export async function setDraftItemHiddenWith(
  supabase: AnyClient,
  shopId: unknown,
  itemId: unknown,
  loadedUpdatedAt: unknown,
  hidden: unknown
): Promise<DraftItemResult> {
  if (typeof hidden !== "boolean") return { ok: false, message: "Not saved: hidden must be yes or no." };
  return updateDraftItem(supabase, shopId, itemId, loadedUpdatedAt, { is_hidden: hidden });
}

// --- Claim links (admin_* functions; each re-checks admin in the database) ---

/**
 * Issues a new claim link: makes a token, sends only its hash to
 * admin_issue_assisted_claim_link (which revokes any earlier open link of
 * the shop), and returns the raw token and link ONCE, for the admin's screen.
 */
export async function issueClaimLinkWith(supabase: AnyClient, shopId: unknown): Promise<IssueLinkResult> {
  const bad = checkIds(shopId);
  if (bad) return { ok: false, message: bad };
  const prefix = "Couldn't create the link";
  try {
    const token = newClaimToken();
    const { data, error } = await supabase.rpc("admin_issue_assisted_claim_link", {
      p_shop_id: shopId,
      p_token_hash: await hashClaimToken(token),
    });
    if (error) return { ok: false, message: friendlyAssistedError(error.message, prefix) };
    const row = rowsOf(data)[0];
    if (!row || typeof row.token_id !== "string" || typeof row.expires_at !== "string") {
      return { ok: false, message: `${prefix}: the database didn't confirm it. Reload the page and check the links list.` };
    }
    return { ok: true, tokenId: row.token_id, expiresAt: row.expires_at, token, link: claimLinkFor(token) };
  } catch (e) {
    return { ok: false, message: friendlyAssistedError(e instanceof Error ? e.message : String(e), prefix) };
  }
}

/** HQ tapped "Send on WhatsApp": recorded in the audit (and sent_at, the first time). */
export async function markClaimLinkSentWith(supabase: AnyClient, tokenId: unknown): Promise<SimpleResult> {
  const bad = checkIds(tokenId);
  if (bad) return { ok: false, message: bad };
  try {
    const { error } = await supabase.rpc("admin_mark_assisted_claim_link_sent", { p_token_id: tokenId });
    if (error) return { ok: false, message: friendlyAssistedError(error.message, "Couldn't record the send") };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendlyAssistedError(e instanceof Error ? e.message : String(e), "Couldn't record the send") };
  }
}

export async function revokeClaimLinkWith(supabase: AnyClient, tokenId: unknown, reason: unknown): Promise<SimpleResult> {
  const bad = checkIds(tokenId);
  if (bad) return { ok: false, message: bad };
  const why = checkReason(reason);
  if (!why.ok) return why;
  try {
    const { error } = await supabase.rpc("admin_revoke_assisted_claim_link", { p_token_id: tokenId, p_reason: why.value });
    if (error) return { ok: false, message: friendlyAssistedError(error.message, "Not revoked") };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendlyAssistedError(e instanceof Error ? e.message : String(e), "Not revoked") };
  }
}

/** Cancels a draft: its open link is revoked and the draft is frozen. */
export async function cancelDraftShopWith(supabase: AnyClient, shopId: unknown, reason: unknown): Promise<SimpleResult> {
  const bad = checkIds(shopId);
  if (bad) return { ok: false, message: bad };
  const why = checkReason(reason);
  if (!why.ok) return why;
  try {
    const { error } = await supabase.rpc("admin_cancel_assisted_shop", { p_shop_id: shopId, p_reason: why.value });
    if (error) return { ok: false, message: friendlyAssistedError(error.message, "Not cancelled") };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendlyAssistedError(e instanceof Error ? e.message : String(e), "Not cancelled") };
  }
}

/** HQ's list of a shop's links (never the hash). */
export async function loadClaimLinksWith(
  supabase: AnyClient,
  shopId: string
): Promise<{ ok: true; links: ClaimLink[] } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.rpc("admin_list_assisted_claim_links", { p_shop_id: shopId });
    if (error) return { ok: false, message: error.message };
    return { ok: true, links: rowsOf(data) as unknown as ClaimLink[] };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// --- Photos ---

const PHOTO_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Where HQ uploads a draft photo in the kitchen-photos bucket:
 * assisted/<shopId>/<uuid>.<ext> (the only path the "Admins can upload
 * assisted shop photos" policy allows, and only while the shop is a draft).
 */
export function assistedPhotoPath(
  shopId: string,
  file: { type: string; size: number },
  uuid: string
): { ok: true; path: string } | { ok: false; message: string } {
  if (!UUID.test(shopId)) return { ok: false, message: "Invalid shop id." };
  const ext = PHOTO_EXT[file.type];
  if (!ext) return { ok: false, message: "Use a JPG, PNG or WebP photo." };
  if (file.size > PHOTO_MAX_BYTES) return { ok: false, message: "That photo is over 5 MB. Pick a smaller one." };
  return { ok: true, path: `assisted/${shopId}/${uuid}.${ext}` };
}

// --- Labels ---

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(MERCHANT_CATEGORIES.map((c) => [c.id, c.label]));

export const SHOP_STATUS_LABEL: Record<AssistedShopStatus, string> = {
  draft: "Draft",
  claimed: "Claimed",
  cancelled: "Cancelled",
};

export const LINK_STATE_LABEL: Record<ClaimLinkState, string> = {
  live: "Live",
  expired: "Expired",
  used: "Used",
  revoked: "Revoked",
};

export const ASSISTED_AUDIT_LABEL: Record<string, string> = {
  shop_created: "Created the draft",
  shop_updated: "Edited the draft",
  shop_cancelled: "Cancelled the draft",
  item_added: "Added a draft menu item",
  item_updated: "Edited a draft menu item",
  item_hidden: "Hid a draft menu item",
  item_unhidden: "Showed a draft menu item again",
  link_issued: "Created a claim link",
  link_sent: "Opened WhatsApp to send the link",
  link_revoked: "Revoked a claim link",
  claimed: "Owner claimed the shop",
};

/** "8123 4567" for display. */
export function formatMobile(mobile: string): string {
  return /^[0-9]{8}$/.test(mobile) ? `${mobile.slice(0, 4)} ${mobile.slice(4)}` : mobile;
}
