"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function approveCookApplication(applicationId: string, applicantUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("cook_applications")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);

  await supabase.from("profiles").update({ role: "cook" }).eq("id", applicantUserId);

  revalidatePath("/");
  revalidatePath("/applications");
}

export async function rejectCookApplication(applicationId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("cook_applications")
    .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);

  revalidatePath("/");
  revalidatePath("/applications");
}

export async function approveRiderApplication(applicationId: string, applicantUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("rider_applications")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);

  await supabase.from("profiles").update({ role: "rider" }).eq("id", applicantUserId);

  revalidatePath("/");
  revalidatePath("/applications");
}

export async function rejectRiderApplication(applicationId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("rider_applications")
    .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);

  revalidatePath("/");
  revalidatePath("/applications");
}

export async function approvePickerApplication(applicationId: string, applicantUserId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("picker_applications")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);

  await supabase.from("profiles").update({ role: "picker" }).eq("id", applicantUserId);

  revalidatePath("/");
  revalidatePath("/applications");
}

export async function rejectPickerApplication(applicationId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await supabase
    .from("picker_applications")
    .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId);

  revalidatePath("/");
  revalidatePath("/applications");
}

export async function setPartnerActive(partnerId: string, isActive: boolean) {
  const supabase = await createClient();
  await supabase.from("profiles").update({ is_active: isActive }).eq("id", partnerId);
  revalidatePath("/partners");
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
    await supabase.from("menu_items").delete().eq("kitchen_id", partnerId);
    await supabase.from("kitchens").delete().eq("id", partnerId);
    await supabase.from("cook_applications").delete().eq("user_id", partnerId);
  } else if (role === "rider") {
    await supabase.from("rider_applications").delete().eq("user_id", partnerId);
  } else if (role === "picker") {
    await supabase.from("picker_applications").delete().eq("user_id", partnerId);
  }

  await supabase.from("profiles").delete().eq("id", partnerId);

  revalidatePath("/partners");
  revalidatePath("/merchants");
  revalidatePath("/riders");
}
