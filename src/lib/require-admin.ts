import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types-auth";

export async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { supabase, user: null, profile: null };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single<Profile>();

  return { supabase, user, profile: profile ?? null };
}

/**
 * Asks the database, via public.user_has_role('admin'), whether the signed-in
 * user is HQ. Same check the complaint-thread RLS uses, so the page gate and
 * the data gate can't disagree. An RPC error counts as "not admin".
 */
export async function hasAdminRole(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  const { data, error } = await supabase.rpc("user_has_role", { check_role: "admin" });
  return !error && data === true;
}
