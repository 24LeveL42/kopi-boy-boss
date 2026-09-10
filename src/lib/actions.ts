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