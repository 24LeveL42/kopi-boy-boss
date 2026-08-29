"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Every action here relies on Row Level Security to enforce that only an
 * admin can actually make the write succeed (see docs/supabase-schema.sql —
 * "Admins can update every X" policies). A non-admin calling these gets a
 * silent no-op from Postgres, not a crash — that's RLS doing its job.
 */

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

export async function setPartnerActive(partnerId: string, isActive: boolean) {
  const supabase = await createClient();
  await supabase.from("profiles").update({ is_active: isActive }).eq("id", partnerId);
  revalidatePath("/partners");
}
