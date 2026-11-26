/**
 * HQ may only put a kitchen live once the owner has PayNow details, because
 * customers pay the merchant directly by PayNow. The database guard
 * (a_kitchen_admin_guard, unchanged) checks terms, address and menu but not
 * PayNow, so Boss checks it here before a save that turns Live on.
 *
 * A kitchen that needs a business UEN (kitchen-uen.ts) also needs it to go
 * live. The database refuses that itself (y_kitchen_live_needs_uen); Boss
 * checks first only to say so in plain words. If the UEN can't be read, the
 * save goes ahead and the database decides.
 *
 * Reads PayNow through admin_get_kitchen_private (admins only) and keeps
 * only a yes/no: the values never leave this module. A kitchen that is
 * already live is left alone (unticking Live is always allowed), and a
 * failed check refuses only the switch to live, never other edits.
 *
 * Pure module (type-only imports) so `node --test` can load it with a fake client.
 */
import type { AnyClient } from "./admin-guard.ts";
import { kitchenUenStatusWith, NO_UEN_MESSAGE } from "./kitchen-uen.ts";

export { NO_UEN_MESSAGE };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NO_PAYNOW_MESSAGE =
  "Can't put this kitchen live yet: the owner hasn't added PayNow details in the Partner app. Untick Live to save your other changes.";
export const PAYNOW_CHECK_FAILED_MESSAGE =
  "Can't put this kitchen live right now: Boss couldn't check its PayNow details. Try again, or untick Live to save your other changes.";

/** true / false, or null when it couldn't be checked. */
export async function kitchenHasPaynowWith(supabase: AnyClient, kitchenId: unknown): Promise<boolean | null> {
  if (typeof kitchenId !== "string" || !UUID.test(kitchenId)) return null;
  try {
    const { data, error } = await supabase.rpc("admin_get_kitchen_private", { p_kitchen_id: kitchenId });
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!row) return null;
    const type = typeof row.paynow_type === "string" ? row.paynow_type.trim() : "";
    const value = typeof row.paynow_value === "string" ? row.paynow_value.trim() : "";
    return type !== "" && value !== "";
  } catch {
    return null;
  }
}

/**
 * Why a save asking for Live must be refused, or null to go ahead. Only a
 * switch from not live to live is checked.
 */
export async function goLiveProblemWith(supabase: AnyClient, kitchenId: unknown, wantsLive: boolean): Promise<string | null> {
  if (!wantsLive) return null;
  if (typeof kitchenId !== "string" || !UUID.test(kitchenId)) return null; // the save itself rejects a bad id
  try {
    const { data, error } = await supabase.from("kitchens").select("id, is_live").eq("id", kitchenId).maybeSingle();
    if (error) return PAYNOW_CHECK_FAILED_MESSAGE;
    if ((data as { is_live?: unknown } | null)?.is_live === true) return null;
  } catch {
    return PAYNOW_CHECK_FAILED_MESSAGE;
  }
  const has = await kitchenHasPaynowWith(supabase, kitchenId);
  if (has === null) return PAYNOW_CHECK_FAILED_MESSAGE;
  if (!has) return NO_PAYNOW_MESSAGE;
  const uen = await kitchenUenStatusWith(supabase, kitchenId);
  return uen.state === "pending" ? NO_UEN_MESSAGE : null;
}
