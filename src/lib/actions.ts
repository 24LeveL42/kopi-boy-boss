"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { approveApplication } from "@/lib/approvals";

export async function approveCookApplication(applicationId: string, applicantUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase
    .from("cook_applications")
    .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't reject application: ${error.message}`);

  revalidatePath("/");
  revalidatePath("/merchants");
}

export async function approveRiderApplication(applicationId: string, applicantUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase
    .from("rider_applications")
    .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't reject application: ${error.message}`);

  revalidatePath("/");
  revalidatePath("/riders");
}

export async function setPartnerActive(partnerId: string, isActive: boolean) {
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ is_active: isActive }).eq("id", partnerId);
  if (error) throw new Error(`Couldn't update status: ${error.message}`);

  revalidatePath("/partners");
  revalidatePath("/merchants");
  revalidatePath("/riders");
}

/**
 * Fully removes a test cook/rider: their profile row plus any
 * application, kitchen, and menu records tied to them, so they can go
 * through apply -> approve from scratch. For testing only — this does
 * not delete their actual Supabase Auth login, so they can sign back in
 * and will land back on the sign-up flow.
 */
export async function deleteTestPartner(partnerId: string, role: "cook" | "rider") {
  const supabase = await createClient();

  if (role === "cook") {
    const { error: e1 } = await supabase.from("menu_items").delete().eq("kitchen_id", partnerId);
    if (e1) throw new Error(`Couldn't delete menu items: ${e1.message}`);
    const { error: e2 } = await supabase.from("kitchens").delete().eq("id", partnerId);
    if (e2) throw new Error(`Couldn't delete kitchen: ${e2.message}`);
    const { error: e3 } = await supabase.from("cook_applications").delete().eq("user_id", partnerId);
    if (e3) throw new Error(`Couldn't delete application: ${e3.message}`);
  } else if (role === "rider") {
    const { error } = await supabase.from("rider_applications").delete().eq("user_id", partnerId);
    if (error) throw new Error(`Couldn't delete application: ${error.message}`);
  }

  const { error: profileError } = await supabase.from("profiles").delete().eq("id", partnerId);
  if (profileError) throw new Error(`Couldn't delete profile: ${profileError.message}`);

  revalidatePath("/partners");
  revalidatePath("/merchants");
  revalidatePath("/riders");
}

/**
 * Marks a complaint thread settled ("resolved") or puts it back in the active
 * list ("open"). resolved_at/resolved_by are stamped by a DB trigger from the
 * server clock and auth.uid(); RLS (user_has_role('admin')) is what stops
 * non-admins, this only surfaces its error.
 */
export async function setComplaintThreadStatus(orderId: string, status: "open" | "resolved") {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase
    .from("complaint_threads")
    .upsert({ order_id: orderId, status }, { onConflict: "order_id" });
  if (error) throw new Error(`Couldn't update thread: ${error.message}`);

  revalidatePath("/complaints");
  revalidatePath(`/complaints/${orderId}`);
}
