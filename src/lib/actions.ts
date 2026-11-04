"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/require-admin";
import { approveApplication } from "@/lib/approvals";
import { deletePartnerWith, type DeleteReport } from "@/lib/delete-partner";
import { setActiveWith } from "@/lib/partner-status";

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

export async function approveCookApplication(applicationId: string, applicantUserId: string) {
  const { supabase, user } = await assertAdmin();

  // Role first, then status: see approvals.ts. Throws before revalidating.
  await approveApplication(supabase, {
    table: "cook_applications",
    role: "cook",
    applicationId,
    applicantUserId,
    reviewerId: user.id,
  });

  revalidatePath("/");
  revalidatePath("/merchants");
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

export async function approveRiderApplication(applicationId: string, applicantUserId: string) {
  const { supabase, user } = await assertAdmin();

  // Role first, then status: see approvals.ts. Throws before revalidating.
  await approveApplication(supabase, {
    table: "rider_applications",
    role: "rider",
    applicationId,
    applicantUserId,
    reviewerId: user.id,
  });

  revalidatePath("/");
  revalidatePath("/riders");
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
