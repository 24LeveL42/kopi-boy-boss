import { revalidatePath } from "next/cache";
import type { AnyClient } from "@/lib/admin-guard";

/**
 * Block / reinstate a partner. NOT a server action (no "use server"), so it
 * can't be called from the browser. Only call it with the client that
 * assertAdmin() returned: setPartnerActive and unblockMessageSender do.
 */
export async function setActiveWith(supabase: AnyClient, partnerId: string, isActive: boolean) {
  if (typeof isActive !== "boolean") throw new Error("Invalid status.");
  const { error } = await supabase.from("profiles").update({ is_active: isActive }).eq("id", partnerId);
  if (error) throw new Error(`Couldn't update status: ${error.message}`);

  revalidatePath("/partners");
  revalidatePath("/merchants");
  revalidatePath("/riders");
}
