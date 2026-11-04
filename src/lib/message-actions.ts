"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/require-admin";
import { setActiveWith } from "@/lib/partner-status";
import { ADMIN_REPLY_MAX_LENGTH, normalizeAdminReply } from "@/lib/admin-messages";

/**
 * Admin inbox (public.admin_messages). Server actions: each starts with
 * assertAdmin() (signed in + database-confirmed admin); RLS
 * (user_has_role('admin')) still guards the rows underneath. Writing
 * admin_reply is enough: a DB trigger stamps replied_at and sets status
 * to 'replied'.
 */

export async function replyToAdminMessage(messageId: string, reply: string) {
  const { supabase } = await assertAdmin();
  const body = normalizeAdminReply(reply);
  if (body === null) throw new Error(`Reply must be 1–${ADMIN_REPLY_MAX_LENGTH} characters.`);

  const { error } = await supabase.from("admin_messages").update({ admin_reply: body }).eq("id", messageId);
  if (error) throw new Error(`Couldn't send reply: ${error.message}`);

  revalidatePath("/messages");
}

export async function setAdminMessageStatus(messageId: string, status: "open" | "closed") {
  const { supabase } = await assertAdmin();
  if (status !== "open" && status !== "closed") throw new Error("Invalid message status.");

  const { error } = await supabase.from("admin_messages").update({ status }).eq("id", messageId);
  if (error) throw new Error(`Couldn't update message: ${error.message}`);

  revalidatePath("/messages");
}

/** Same unblock as Merchants/Riders/Manage Partners, plus a refresh of the inbox. */
export async function unblockMessageSender(senderId: string) {
  const { supabase } = await assertAdmin();
  await setActiveWith(supabase, senderId, true);
  revalidatePath("/messages");
}
