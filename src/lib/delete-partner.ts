/**
 * Deleting a test cook/rider, with safeguards. Pure module (type-only
 * imports) so `node --test` can run it with a fake client; the server action
 * deleteTestPartner in actions.ts calls assertAdmin() first, then this.
 *
 * Safeguards, all checked on the server before anything is deleted:
 *  - the target exists, is not an admin, and is not the admin doing it
 *  - the target's real role matches the role the screen claimed
 *  - the admin typed the partner's name: a cook's kitchen business name, a
 *    rider's full name (or email when there is no name). Compared after
 *    trimming, ignoring case. The expected name is read here, never taken
 *    from the browser.
 *  - a cook with any subscription payment record is refused (billing
 *    history is kept); their unpaid subscription row, if they have one
 *    (only cooks approved before billing was switched off do), is removed
 *    through admin_remove_unpaid_subscription just before the profile row.
 * Then the rows are deleted one table at a time, stopping at the first
 * failure. The result always says what was and wasn't deleted. It never
 * throws for an expected failure (Next hides thrown messages in production).
 */
import type { AnyClient } from "./admin-guard.ts";

export type PartnerRole = "cook" | "rider";

export interface DeleteStep {
  table: string;
  column: string;
  /**
   * Done through this admin RPC instead of a plain delete. Billing tables
   * have no browser write grant; the SECURITY DEFINER function checks the
   * admin role, refuses when payments exist and logs the removal.
   */
  rpc?: string;
}

export interface DeleteReport {
  ok: boolean;
  /** Human-readable, e.g. "menu_items: 3 rows". */
  deleted: string[];
  /** Steps not done (the failed one and everything after it). Empty when ok. */
  notDeleted: string[];
  /** The step that failed, when one did. */
  failedStep?: string;
  /** Why it stopped or was refused. */
  error?: string;
}

/**
 * Order matters: children before the profile row they hang off.
 * merchant_subscriptions references profiles ON DELETE RESTRICT, so its row
 * goes right before profiles (late on purpose: if an earlier step fails, the
 * merchant still has its billing row). docs/supabase-subscriptions-step2.sql.
 */
export const DELETE_STEPS: Record<PartnerRole, DeleteStep[]> = {
  cook: [
    { table: "menu_items", column: "kitchen_id" },
    { table: "kitchens", column: "id" },
    { table: "cook_applications", column: "user_id" },
    { table: "merchant_subscriptions", column: "merchant_id", rpc: "admin_remove_unpaid_subscription" },
    { table: "profiles", column: "id" },
  ],
  rider: [
    { table: "rider_applications", column: "user_id" },
    { table: "profiles", column: "id" },
  ],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Q2: trim, ignore case. */
export function normalizeConfirmName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function refused(error: string, role: PartnerRole | null): DeleteReport {
  return {
    ok: false,
    deleted: [],
    notDeleted: role ? DELETE_STEPS[role].map((s) => s.table) : [],
    error: `${error} Nothing was deleted.`,
  };
}

/** The name the admin must type, read from the database. Null when there is none on file. */
export async function expectedConfirmName(
  supabase: AnyClient,
  partnerId: string,
  role: PartnerRole,
  fullName: string | null
): Promise<{ name: string | null; error?: string }> {
  if (role === "cook") {
    const { data, error } = await supabase.from("kitchens").select("business_name").eq("id", partnerId).maybeSingle();
    if (error) return { name: null, error: `Couldn't read the kitchen: ${error.message}` };
    const name = (data as { business_name?: string | null } | null)?.business_name?.trim();
    return { name: name || null };
  }
  if (fullName?.trim()) return { name: fullName.trim() };
  const { data, error } = await supabase.rpc("admin_user_emails", { user_ids: [partnerId] });
  if (error) return { name: null, error: `Couldn't read the rider's email: ${error.message}` };
  const email = ((data as { id: string; email: string | null }[] | null) ?? []).find((r) => r.id === partnerId)?.email?.trim();
  return { name: email || null };
}

export async function deletePartnerWith(
  supabase: AnyClient,
  adminUserId: string,
  input: { partnerId: unknown; claimedRole: unknown; typedName: unknown }
): Promise<DeleteReport> {
  const { partnerId, claimedRole, typedName } = input;

  // 1. Shape of the request (a direct POST can send anything).
  if (claimedRole !== "cook" && claimedRole !== "rider") return refused("Unknown partner type.", null);
  const role: PartnerRole = claimedRole;
  if (typeof partnerId !== "string" || !UUID_RE.test(partnerId)) return refused("Invalid partner id.", role);
  if (partnerId === adminUserId) return refused("You can't delete your own account.", role);

  // 2. Who the target really is.
  const { data: target, error: targetError } = await supabase
    .from("profiles")
    .select("id, role, full_name")
    .eq("id", partnerId)
    .maybeSingle();
  if (targetError) return refused(`Couldn't read the partner's profile: ${targetError.message}`, role);
  const profile = target as { id: string; role: string; full_name: string | null } | null;
  if (!profile) return refused("No partner found with this id.", role);
  if (profile.role === "admin") return refused("This account is an admin and can't be deleted here.", role);
  if (profile.role !== role) return refused(`This account is a ${profile.role}, not a ${role}.`, role);

  // 3. The typed confirmation.
  const expected = await expectedConfirmName(supabase, partnerId, role, profile.full_name);
  if (expected.error) return refused(expected.error, role);
  if (!expected.name) {
    return refused(
      role === "cook"
        ? "This cook has no kitchen business name on file to confirm with."
        : "This rider has no name or email on file to confirm with.",
      role
    );
  }
  const typed = normalizeConfirmName(typedName);
  if (!typed || typed !== normalizeConfirmName(expected.name)) {
    return refused("The name you typed doesn't match.", role);
  }

  // 4. A merchant with payment records keeps their billing history: refuse
  //    before anything is deleted. A failed read refuses too (fail closed).
  if (role === "cook") {
    const { data, error } = await supabase.from("subscription_payments").select("id").eq("merchant_id", partnerId);
    if (error) return refused(`Couldn't check the merchant's billing records: ${error.message}`, role);
    const n = Array.isArray(data) ? data.length : 0;
    if (n > 0) {
      return refused(
        `This merchant has ${n} payment record${n === 1 ? "" : "s"}, so their billing history must be kept and they can't be deleted.`,
        role
      );
    }
  }

  // 5. Delete step by step; stop at the first failure.
  const steps = DELETE_STEPS[role];
  const deleted: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const { table, column, rpc } = steps[i];
    const rest = steps.slice(i).map((s) => s.table);
    let rows: unknown[] | null = null;
    let message: string | null = null;
    try {
      if (rpc) {
        // Returns true when it removed the row, false when there was none.
        const { data, error } = await supabase.rpc(rpc, { p_merchant_id: partnerId, p_reason: "Boss: delete test partner" });
        if (error) message = error.message;
        else rows = data === true ? [partnerId] : [];
      } else {
        const { data, error } = await supabase.from(table).delete().eq(column, partnerId).select("id");
        if (error) message = error.message;
        else rows = (data as unknown[] | null) ?? [];
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    if (message === null && table === "profiles" && rows?.length !== 1) {
      // RLS can refuse a delete silently (0 rows, no error).
      message = "the profile row was not deleted (0 rows affected; possibly refused by database permissions)";
    }
    if (message !== null) {
      return { ok: false, deleted, notDeleted: rest, failedStep: table, error: `Stopped at ${table}: ${message}` };
    }
    const n = rows!.length;
    deleted.push(`${table}: ${n} row${n === 1 ? "" : "s"}`);
  }
  return { ok: true, deleted, notDeleted: [] };
}
