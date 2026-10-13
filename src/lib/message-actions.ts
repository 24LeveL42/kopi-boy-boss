"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { setPartnerActive } from "@/lib/actions";
import { ADMIN_REPLY_MAX_LENGTH, normalizeAdminReply } from "@/lib/admin-messages";

/**
 * Admin inbox (public.admin_messages). RLS (user_has_role('admin')) is what
 * stops non-admins; these only surface its error. Writing admin_reply is
 * enough — a DB trigger stamps replied_at and sets status to 'replied'.
 */
async function signedInClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");
  return supabase;
}

export async function replyToAdminMessage(messageId: string, reply: string) {
  const body = normalizeAdminReply(reply);
  if (body === null) throw new Error(`Reply must be 1–${ADMIN_REPLY_MAX_LENGTH} characters.`);

  const supabase = await signedInClient();
  const { error } = await supabase.from("admin_messages").update({ admin_reply: body }).eq("id", messageId);
  if (error) throw new Error(`Couldn't send reply: ${error.message}`);

  revalidatePath("/messages");
}

export async function setAdminMessageStatus(messageId: string, status: "open" | "closed") {
  const supabase = await signedInClient();
  const { error } = await supabase.from("admin_messages").update({ status }).eq("id", messageId);
  if (error) throw new Error(`Couldn't update message: ${error.message}`);

  revalidatePath("/messages");
}

/** Same unblock as Merchants/Riders/Manage Partners, plus a refresh of the inbox. */
export async function unblockMessageSender(senderId: string) {
  await setPartnerActive(senderId, true);
  revalidatePath("/messages");
}
