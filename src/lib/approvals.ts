/**
 * Approving a cook/rider application: the two database writes and their order.
 * Kept out of actions.ts (its only runtime imports are the pure contacts.ts
 * and approval-email.ts) so `node --test` can load it directly with a fake
 * client (see approvals.test.ts and approval-email.test.ts).
 *
 * Order matters: the applicant's role is changed FIRST and the application is
 * marked approved only after that succeeded. If the role write fails, the
 * application stays pending and HQ can simply press Approve again, instead of
 * ending up "approved" with the applicant still a customer.
 */
import type { createClient } from "@/lib/supabase/server";
import { fetchEmailsById } from "./contacts.ts";
import { sendApprovalEmail, type EmailDeps, type EmailOutcome } from "./approval-email.ts";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Approving an application always sets profiles.role to the new role.
 * If the admin happens to be testing with their own admin account (or
 * anyone else marked admin), this used to silently overwrite their
 * admin access. This guard skips the role change in that one case.
 *
 * A plain update, not an upsert: every user already has a profile row (the
 * on_auth_user_created trigger makes it), and profiles has no INSERT policy,
 * so an upsert is refused by RLS even when the row exists.
 */
export async function setRoleUnlessAdmin(supabase: Supabase, userId: string, newRole: "cook" | "rider") {
  const { data: existing, error: readError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (readError) throw new Error(`Couldn't check applicant's profile: ${readError.message}`);
  if (existing?.role === "admin") return;

  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ role: newRole })
    .eq("id", userId)
    .select("id");
  if (error) throw new Error(`Couldn't update role: ${error.message}`);
  if (!updated || updated.length === 0) throw new Error("Applicant profile not found.");
}

export async function approveApplication(
  supabase: Supabase,
  {
    table,
    role,
    applicationId,
    applicantUserId,
    reviewerId,
  }: {
    table: "cook_applications" | "rider_applications";
    role: "cook" | "rider";
    applicationId: string;
    applicantUserId: string;
    reviewerId: string;
  }
): Promise<{ justApproved: boolean }> {
  await setRoleUnlessAdmin(supabase, applicantUserId, role);

  // Only a row that is not approved yet changes (pending, or rejected and now
  // approved after all). Postgres locks the row, so of two clicks at the same
  // moment only one sees it as not approved: justApproved is true exactly
  // once per application, which is what keeps the email from going twice.
  const { data, error } = await supabase
    .from(table)
    .update({ status: "approved", reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId)
    .neq("status", "approved")
    .select("id");
  if (error) throw new Error(`Couldn't approve application: ${error.message}`);
  return { justApproved: Array.isArray(data) && data.length > 0 };
}

/** What an approve action returns to the button: a short line for the admin. */
export type ApprovalResult = { tone: "ok" | "warn"; notice: string; email: EmailOutcome["status"] };

export function approvalNotice(outcome: EmailOutcome): ApprovalResult {
  if (outcome.status === "sent") return { tone: "ok", notice: "Approved. Welcome email sent.", email: "sent" };
  return { tone: "warn", notice: `Approved. Email not sent: ${outcome.reason}.`, email: outcome.status };
}

/**
 * Approve, then (only when this call did the approving) email the applicant.
 * The DB writes throw exactly as before; nothing after them throws, so an
 * email problem can never undo or fail an approval.
 */
export async function approveAndNotify(
  supabase: Supabase,
  args: Parameters<typeof approveApplication>[1],
  emailDeps?: EmailDeps
): Promise<ApprovalResult> {
  const { justApproved } = await approveApplication(supabase, args);
  if (!justApproved) {
    return { tone: "ok", notice: "Already approved earlier. No new email sent.", email: "skipped" };
  }

  const ref = `${args.role} app=${args.applicationId}`;
  try {
    const [emailById, profile, application] = await Promise.all([
      fetchEmailsById(supabase, [args.applicantUserId]),
      supabase.from("profiles").select("full_name").eq("id", args.applicantUserId).maybeSingle(),
      args.table === "cook_applications"
        ? supabase.from("cook_applications").select("business_name").eq("id", args.applicationId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const outcome = await sendApprovalEmail(
      {
        kind: args.role === "cook" ? "merchant" : "rider",
        to: emailById.get(args.applicantUserId),
        name: (profile.data as { full_name?: string | null } | null)?.full_name ?? null,
        businessName: (application.data as { business_name?: string | null } | null)?.business_name ?? null,
        idempotencyKey: `approval/${args.table}/${args.applicationId}`,
        ref,
      },
      emailDeps
    );
    return approvalNotice(outcome);
  } catch {
    (emailDeps?.log ?? console).error(`[approval-email] failed ${ref} lookup error`);
    return approvalNotice({ status: "failed", reason: "couldn't look up the applicant's details" });
  }
}
