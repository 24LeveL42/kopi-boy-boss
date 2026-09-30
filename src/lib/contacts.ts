import type { createClient } from "@/lib/supabase/server";

/**
 * Emails for the given users, via the admin_user_emails RPC (auth.users isn't
 * readable with the publishable key). The RPC returns nothing unless the
 * caller is HQ, so this is only meaningful on admin-gated pages. An RPC
 * error (e.g. the SQL not run yet) yields an empty map rather than failing
 * the page.
 */
export async function fetchEmailsById(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userIds: string[]
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await supabase.rpc("admin_user_emails", { user_ids: userIds });
  if (error || !data) return new Map();
  const rows = data as { id: string; email: string | null }[];
  return new Map(rows.filter((r) => r.email).map((r) => [r.id, r.email!]));
}
