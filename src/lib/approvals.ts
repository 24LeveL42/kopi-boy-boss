/**
 * Approving a cook/rider application: the two database writes and their order.
 * Kept out of actions.ts (and free of runtime imports) so `node --test` can
 * load it directly with a fake client (see approvals.test.ts).
 *
 * Order matters: the applicant's role is changed FIRST and the application is
 * marked approved only after that succeeded. If the role write fails, the
 * application stays pending and HQ can simply press Approve again, instead of
 * ending up "approved" with the applicant still a customer.
 */
import type { createClient } from "@/lib/supabase/server";

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
) {
  await setRoleUnlessAdmin(supabase, applicantUserId, role);

  const { error } = await supabase
    .from(table)
    .update({ status: "approved", reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't approve application: ${error.message}`);
}
