/**
 * A live kitchen's business UEN, for HQ (merchant edit page).
 *
 * Whether a kitchen needs one is decided exactly as the database decides it
 * (y_kitchen_live_needs_uen, docs/supabase-assisted-uen-later.sql): by the
 * owner's latest APPROVED cook application. Its type isn't "Home Cook" =
 * needs a UEN. No approved application = no requirement. Not by
 * kitchens.category, which the owner picks in Kitchen Setup.
 *
 * kitchens.business_uen is public and derived (always copied from that
 * application); HQ never writes it directly. Setting or correcting it goes
 * through admin_set_kitchen_business_uen (admins only, the typed business
 * name and a reason, logged in kitchen_admin_audit).
 *
 * Nothing here throws. Pure module (type-only imports) so `node --test` can
 * load it with a fake client.
 */
import type { AnyClient } from "./admin-guard.ts";
import { BUSINESS_UEN_PATTERN, normalizeBusinessUen, UEN_FORMAT_MESSAGE } from "./business-uen.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KitchenUenStatus =
  | { state: "set"; uen: string; applicationType: string | null }
  | { state: "pending"; applicationType: string | null }
  | { state: "not-needed"; reason: "home-cook" | "no-application" }
  | { state: "unknown"; message: string };

export type SetUenResult = { ok: true; uen: string } | { ok: false; message: string };

/** What HQ sees when Live is refused for a missing UEN (Boss's check, or the database's). */
export const NO_UEN_MESSAGE =
  "Can't put this kitchen live yet: it needs a business UEN. The owner adds it in Kitchen Setup, or set it under Business UEN on this page. Untick Live to save your other changes.";

export const UEN_PENDING_NOTE = "UEN pending: the owner adds it in Kitchen Setup. The shop can't go live until it's in.";

/** The kitchen's UEN and whether it needs one. "unknown" when it couldn't be read. */
export async function kitchenUenStatusWith(supabase: AnyClient, kitchenId: unknown): Promise<KitchenUenStatus> {
  if (typeof kitchenId !== "string" || !UUID.test(kitchenId)) return { state: "unknown", message: "Invalid kitchen id." };
  try {
    const [kitchen, app] = await Promise.all([
      supabase.from("kitchens").select("id, business_uen").eq("id", kitchenId).maybeSingle(),
      // Same order as approved_business_uen(): the application the kitchen's UEN comes from.
      supabase
        .from("cook_applications")
        .select("business_type")
        .eq("user_id", kitchenId)
        .eq("status", "approved")
        .order("reviewed_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (kitchen.error) return { state: "unknown", message: kitchen.error.message };
    if (app.error) return { state: "unknown", message: app.error.message };
    const uen = (kitchen.data as { business_uen?: unknown } | null)?.business_uen;
    const row = app.data as { business_type?: unknown } | null;
    const applicationType = typeof row?.business_type === "string" ? row.business_type : null;
    if (typeof uen === "string" && uen) return { state: "set", uen, applicationType };
    if (!row) return { state: "not-needed", reason: "no-application" };
    if (applicationType === "Home Cook") return { state: "not-needed", reason: "home-cook" };
    return { state: "pending", applicationType };
  } catch (e) {
    return { state: "unknown", message: e instanceof Error ? e.message : String(e) };
  }
}

/** The database's refusals are already in plain words; these get a "Not saved:" in front. */
function friendlyUenError(message: string): string {
  const m = message ?? "";
  if (/Not allowed: admins only/i.test(m)) return "Not saved: only an admin can change a kitchen's business UEN.";
  if (/permission denied/i.test(m)) return "Not saved: the database refused this change for your account.";
  if (/function .*admin_set_kitchen_business_uen.* does not exist/i.test(m)) {
    return "Not saved: the database doesn't have the UEN function yet (docs/supabase-assisted-uen-later.sql).";
  }
  return `Not saved: ${m || "unknown error"}`;
}

/**
 * HQ sets or corrects a kitchen's UEN: one call to
 * admin_set_kitchen_business_uen, which re-checks admin, the format, the
 * typed business name, the reason and the application, and logs it.
 */
export async function setKitchenBusinessUenWith(
  supabase: AnyClient,
  kitchenId: unknown,
  uen: unknown,
  confirmBusinessName: unknown,
  reason: unknown
): Promise<SetUenResult> {
  if (typeof kitchenId !== "string" || !UUID.test(kitchenId)) return { ok: false, message: "Not saved: invalid kitchen id." };
  const value = normalizeBusinessUen(uen);
  if (!value) return { ok: false, message: "Not saved: enter the business UEN." };
  if (!BUSINESS_UEN_PATTERN.test(value)) return { ok: false, message: `Not saved: ${UEN_FORMAT_MESSAGE}` };
  const name = typeof confirmBusinessName === "string" ? confirmBusinessName.trim() : "";
  if (!name) return { ok: false, message: "Not saved: type the kitchen's business name to confirm." };
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) return { ok: false, message: "Not saved: give a reason for changing the business UEN." };
  if (why.length > 200) return { ok: false, message: "Not saved: the reason can be at most 200 characters." };
  try {
    const { data, error } = await supabase.rpc("admin_set_kitchen_business_uen", {
      p_kitchen_id: kitchenId,
      p_uen: value,
      p_confirm_business_name: name,
      p_reason: why,
    });
    if (error) return { ok: false, message: friendlyUenError(error.message) };
    return { ok: true, uen: typeof data === "string" && data ? data : value };
  } catch (e) {
    return { ok: false, message: friendlyUenError(e instanceof Error ? e.message : String(e)) };
  }
}
