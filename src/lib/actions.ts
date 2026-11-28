"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/require-admin";
import { approveAndNotify, type ApprovalResult } from "@/lib/approvals";
import { deletePartnerWith, type DeleteReport } from "@/lib/delete-partner";
import { setActiveWith } from "@/lib/partner-status";
import { setRiderRegionsWith, type SaveResult } from "@/lib/regions";
import {
  addMenuItemWith,
  saveKitchenProfileWith,
  setMenuItemHiddenWith,
  updateMenuItemWith,
  type KitchenProfile,
  type KitchenSaveResult,
  type MenuItemInput,
  type MenuItemResult,
} from "@/lib/kitchen-admin";
import { goLiveProblemWith } from "@/lib/kitchen-go-live";
import { setKitchenBusinessUenWith, type SetUenResult } from "@/lib/kitchen-uen";
import {
  addDraftItemWith,
  cancelDraftShopWith,
  createDraftShopWith,
  issueClaimLinkWith,
  issueSigninLinkWith,
  markClaimLinkSentWith,
  revokeClaimLinkWith,
  importDraftMenuWith,
  saveDraftShopWith,
  setCategoryPhotoWith,
  setDraftItemHiddenWith,
  setDraftItemPhotosWith,
  updateDraftItemWith,
  type BulkPhotoResult,
  type CategoryPhotoResult,
  type DraftItemResult,
  type ImportResult,
  type DraftSaveResult,
  type IssueLinkResult,
  type IssueSigninLinkResult,
  type SimpleResult,
} from "@/lib/assisted-onboarding";

/*
 * Every export here is a server action: reachable by a direct POST, not just
 * from the UI. So each one starts with assertAdmin(), which throws unless the
 * caller is signed in AND the database confirms they are an admin. Arguments
 * are re-checked because a direct POST can send anything.
 * server-actions.test.ts fails if an action skips assertAdmin().
 */

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Invalid ${what}.`);
  return value as T;
}

export async function approveCookApplication(applicationId: string, applicantUserId: string): Promise<ApprovalResult> {
  const { supabase, user } = await assertAdmin();

  // Role first, then status: see approvals.ts. Throws before revalidating.
  // The welcome email goes out only if this call did the approving, and
  // never throws: its outcome comes back as the notice for the admin.
  const result = await approveAndNotify(supabase, {
    table: "cook_applications",
    role: "cook",
    applicationId,
    applicantUserId,
    reviewerId: user.id,
  });

  revalidatePath("/");
  revalidatePath("/merchants");
  return result;
}

export async function rejectCookApplication(applicationId: string) {
  const { supabase, user } = await assertAdmin();

  const { error } = await supabase
    .from("cook_applications")
    .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't reject application: ${error.message}`);

  revalidatePath("/");
  revalidatePath("/merchants");
}

export async function approveRiderApplication(applicationId: string, applicantUserId: string): Promise<ApprovalResult> {
  const { supabase, user } = await assertAdmin();

  // Role first, then status: see approvals.ts. Throws before revalidating.
  // The welcome email goes out only if this call did the approving, and
  // never throws: its outcome comes back as the notice for the admin.
  const result = await approveAndNotify(supabase, {
    table: "rider_applications",
    role: "rider",
    applicationId,
    applicantUserId,
    reviewerId: user.id,
  });

  revalidatePath("/");
  revalidatePath("/riders");
  return result;
}

export async function rejectRiderApplication(applicationId: string) {
  const { supabase, user } = await assertAdmin();

  const { error } = await supabase
    .from("rider_applications")
    .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't reject application: ${error.message}`);

  revalidatePath("/");
  revalidatePath("/riders");
}

export async function setPartnerActive(partnerId: string, isActive: boolean) {
  const { supabase } = await assertAdmin();
  await setActiveWith(supabase, partnerId, isActive);
}

/**
 * Fully removes a test cook/rider (profile, application, kitchen, menu), so
 * they can go through apply -> approve from scratch. Testing only: it does
 * not delete their Supabase Auth login.
 *
 * Admins only (assertAdmin throws otherwise). Everything else is RETURNED as
 * a report, never thrown: refusals (admin target, wrong role, wrong typed
 * name) delete nothing, and a failed step stops the rest. See delete-partner.ts.
 */
export async function deleteTestPartner(partnerId: string, role: "cook" | "rider", typedName: string): Promise<DeleteReport> {
  const { supabase, user } = await assertAdmin();

  const report = await deletePartnerWith(supabase, user.id, { partnerId, claimedRole: role, typedName });

  if (report.deleted.length > 0) {
    revalidatePath("/partners");
    revalidatePath("/merchants");
    revalidatePath("/riders");
  }
  return report;
}

/**
 * Marks a complaint thread settled ("resolved") or puts it back in the active
 * list ("open"). resolved_at/resolved_by are stamped by a DB trigger from the
 * server clock and auth.uid().
 */
export async function setComplaintThreadStatus(orderId: string, status: "open" | "resolved") {
  const { supabase } = await assertAdmin();
  const checked = requireOneOf(status, ["open", "resolved"] as const, "thread status");

  const { error } = await supabase
    .from("complaint_threads")
    .upsert({ order_id: orderId, status: checked }, { onConflict: "order_id" });
  if (error) throw new Error(`Couldn't update thread: ${error.message}`);

  revalidatePath("/complaints");
  revalidatePath(`/complaints/${orderId}`);
}

/**
 * Replaces a rider's regions (at least one of north/south/east/west) through
 * the admin_set_rider_regions RPC, which re-checks admin, rider and regions in
 * the database. Problems come back as a message to show, never thrown, so the
 * form can say exactly what went wrong.
 */
export async function setRiderRegions(riderId: string, regions: string[]): Promise<SaveResult> {
  const { supabase } = await assertAdmin();

  const result = await setRiderRegionsWith(supabase, riderId, regions);

  if (result.ok) {
    revalidatePath("/riders");
    revalidatePath(`/riders/${riderId}/edit`);
  }
  return result;
}

/*
 * HQ edits a merchant's kitchen and menu. All the database work is in
 * kitchen-admin.ts (UPDATE only on kitchens, explicit columns, stale-edit
 * check on updated_at, no deletes); these only check admin, call it and
 * refresh the pages. Problems come back as a message, never thrown.
 */
function revalidateKitchen(kitchenId: string) {
  revalidatePath("/merchants");
  revalidatePath(`/merchants/${kitchenId}/edit`);
}

export async function saveKitchenProfile(
  kitchenId: string,
  loadedUpdatedAt: string,
  profile: KitchenProfile
): Promise<KitchenSaveResult> {
  const { supabase } = await assertAdmin();
  // No switch to Live without PayNow (the database guard doesn't check it), and a plain-words
  // refusal when a UEN is missing (the database refuses that too): see kitchen-go-live.ts.
  const wantsLive = (profile as { is_live?: unknown } | null)?.is_live === true;
  const blocked = await goLiveProblemWith(supabase, kitchenId, wantsLive);
  if (blocked) return { ok: false, message: blocked };
  const result = await saveKitchenProfileWith(supabase, kitchenId, loadedUpdatedAt, profile);
  if (result.ok) revalidateKitchen(kitchenId);
  return result;
}

/*
 * HQ sets or corrects a kitchen's business UEN: one call to
 * admin_set_kitchen_business_uen (admins only; it re-checks the format, the
 * typed business name and the reason, and logs it in kitchen_admin_audit).
 */
export async function setKitchenBusinessUen(
  kitchenId: string,
  uen: string,
  confirmBusinessName: string,
  reason: string
): Promise<SetUenResult> {
  const { supabase } = await assertAdmin();
  const result = await setKitchenBusinessUenWith(supabase, kitchenId, uen, confirmBusinessName, reason);
  if (result.ok) revalidateKitchen(kitchenId);
  return result;
}

export async function addMenuItem(kitchenId: string, item: MenuItemInput): Promise<MenuItemResult> {
  const { supabase } = await assertAdmin();
  const result = await addMenuItemWith(supabase, kitchenId, item);
  if (result.ok) revalidateKitchen(kitchenId);
  return result;
}

export async function updateMenuItem(
  kitchenId: string,
  itemId: string,
  loadedUpdatedAt: string,
  item: MenuItemInput
): Promise<MenuItemResult> {
  const { supabase } = await assertAdmin();
  const result = await updateMenuItemWith(supabase, kitchenId, itemId, loadedUpdatedAt, item);
  if (result.ok) revalidateKitchen(kitchenId);
  return result;
}

export async function setMenuItemHidden(
  kitchenId: string,
  itemId: string,
  loadedUpdatedAt: string,
  hidden: boolean
): Promise<MenuItemResult> {
  const { supabase } = await assertAdmin();
  const result = await setMenuItemHiddenWith(supabase, kitchenId, itemId, loadedUpdatedAt, hidden);
  if (result.ok) revalidateKitchen(kitchenId);
  return result;
}

/*
 * Assisted onboarding: HQ sets up a draft shop and sends the owner a
 * one-time claim link. All the database work is in assisted-onboarding.ts
 * (explicit columns, stale-edit checks, no deletes, token hash only); these
 * only check admin, call it and refresh the pages. Problems come back as a
 * message, never thrown. issueAssistedClaimLink returns the raw token once,
 * for the admin's screen; it is never logged or stored.
 */
function revalidateAssisted(shopId?: string) {
  revalidatePath("/merchants/assisted");
  if (shopId) revalidatePath(`/merchants/assisted/${shopId}`);
}

export async function createAssistedShop(shop: unknown): Promise<DraftSaveResult> {
  const { supabase } = await assertAdmin();
  const result = await createDraftShopWith(supabase, shop);
  if (result.ok) revalidateAssisted();
  return result;
}

export async function saveAssistedShop(shopId: string, loadedUpdatedAt: string, shop: unknown): Promise<DraftSaveResult> {
  const { supabase } = await assertAdmin();
  const result = await saveDraftShopWith(supabase, shopId, loadedUpdatedAt, shop);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

export async function addAssistedShopItem(shopId: string, item: MenuItemInput): Promise<DraftItemResult> {
  const { supabase } = await assertAdmin();
  const result = await addDraftItemWith(supabase, shopId, item);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

export async function updateAssistedShopItem(
  shopId: string,
  itemId: string,
  loadedUpdatedAt: string,
  item: MenuItemInput
): Promise<DraftItemResult> {
  const { supabase } = await assertAdmin();
  const result = await updateDraftItemWith(supabase, shopId, itemId, loadedUpdatedAt, item);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

export async function setAssistedShopItemHidden(
  shopId: string,
  itemId: string,
  loadedUpdatedAt: string,
  hidden: boolean
): Promise<DraftItemResult> {
  const { supabase } = await assertAdmin();
  const result = await setDraftItemHiddenWith(supabase, shopId, itemId, loadedUpdatedAt, hidden);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

/** CSV import into a draft: checked again on the server, then one database call (see importDraftMenuWith). */
export async function importAssistedMenu(shopId: string, csvText: string, mode: "add" | "replace"): Promise<ImportResult> {
  const { supabase } = await assertAdmin();
  const result = await importDraftMenuWith(supabase, shopId, csvText, mode);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

/** "Set photo for all [Category] items" on a draft (see setCategoryPhotoWith). */
export async function setAssistedCategoryPhoto(
  shopId: string,
  category: string | null,
  photoUrl: string,
  replaceExisting: boolean
): Promise<CategoryPhotoResult> {
  const { supabase } = await assertAdmin();
  const result = await setCategoryPhotoWith(supabase, shopId, category, photoUrl, replaceExisting);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

/** "Bulk photos" on a draft: one item update per photo, own-folder URLs only (see setDraftItemPhotosWith). */
export async function setAssistedItemPhotos(
  shopId: string,
  assignments: { itemId: string; photoUrl: string }[],
  replaceExisting: boolean
): Promise<BulkPhotoResult> {
  const { supabase } = await assertAdmin();
  const result = await setDraftItemPhotosWith(supabase, shopId, assignments, replaceExisting);
  if (result.ok && result.updated > 0) revalidateAssisted(shopId);
  return result;
}

export async function issueAssistedClaimLink(shopId: string): Promise<IssueLinkResult> {
  const { supabase } = await assertAdmin();
  const result = await issueClaimLinkWith(supabase, shopId);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

export async function markAssistedClaimLinkSent(shopId: string, tokenId: string): Promise<SimpleResult> {
  const { supabase } = await assertAdmin();
  const result = await markClaimLinkSentWith(supabase, tokenId);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

export async function revokeAssistedClaimLink(shopId: string, tokenId: string, reason: string): Promise<SimpleResult> {
  const { supabase } = await assertAdmin();
  const result = await revokeClaimLinkWith(supabase, tokenId, reason);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}

/**
 * A one-time sign-in link back into a CLAIMED shop owner's existing account
 * (docs/supabase-assisted-signin-link.sql). Returns the link once, for the
 * admin's screen; it is never logged or stored. Nothing to revalidate: the
 * page shows no sign-in link state.
 */
export async function issueAssistedSigninLink(shopId: string): Promise<IssueSigninLinkResult> {
  const { supabase } = await assertAdmin();
  return issueSigninLinkWith(supabase, shopId);
}

export async function cancelAssistedShop(shopId: string, reason: string): Promise<SimpleResult> {
  const { supabase } = await assertAdmin();
  const result = await cancelDraftShopWith(supabase, shopId, reason);
  if (result.ok) revalidateAssisted(shopId);
  return result;
}
