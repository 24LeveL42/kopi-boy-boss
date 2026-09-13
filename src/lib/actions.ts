"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Approving an application always sets profiles.role to the new role.
 * If the admin happens to be testing with their own admin account (or
 * anyone else marked admin), this used to silently overwrite their
 * admin access. This guard skips the role change in that one case.
 */
async function setRoleUnlessAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  newRole: "cook" | "rider" | "picker"
) {
  const { data: existing, error: readError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (readError) throw new Error(`Couldn't check applicant's profile: ${readError.message}`);
  if (existing?.role === "admin") return;

  const { error } = await supabase.from("profiles").update({ role: newRole }).eq("id", userId);
  if (error) throw new Error(`Couldn't update role: ${error.message}`);
}

export async function approveCookApplication(applicationId: string, applicantUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase
    .from("cook_applications")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't approve application: ${error.message}`);

  await setRoleUnlessAdmin(supabase, applicantUserId, "cook");

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
}

export async function approveRiderApplication(applicationId: string, applicantUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase
    .from("rider_applications")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't approve application: ${error.message}`);

  await setRoleUnlessAdmin(supabase, applicantUserId, "rider");

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
}

export async function approvePickerApplication(applicationId: string, applicantUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase
    .from("picker_applications")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't approve application: ${error.message}`);

  await setRoleUnlessAdmin(supabase, applicantUserId, "picker");

  revalidatePath("/");
}

export async function rejectPickerApplication(applicationId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { error } = await supabase
    .from("picker_applications")
    .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);
  if (error) throw new Error(`Couldn't reject application: ${error.message}`);

  revalidatePath("/");
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
 * Fully removes a test cook/rider/picker: their profile row plus any
 * application, kitchen, and menu records tied to them, so they can go
 * through apply -> approve from scratch. For testing only — this does
 * not delete their actual Supabase Auth login, so they can sign back in
 * and will land back on the sign-up flow.
 */
export async function deleteTestPartner(partnerId: string, role: "cook" | "rider" | "picker") {
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
  } else if (role === "picker") {
    const { error } = await supabase.from("picker_applications").delete().eq("user_id", partnerId);
    if (error) throw new Error(`Couldn't delete application: ${error.message}`);
  }

  const { error: profileError } = await supabase.from("profiles").delete().eq("id", partnerId);
  if (profileError) throw new Error(`Couldn't delete profile: ${profileError.message}`);

  revalidatePath("/partners");
  revalidatePath("/merchants");
  revalidatePath("/riders");
}
