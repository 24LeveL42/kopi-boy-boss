import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types-auth";

/**
 * Shared server-side check used by every HQ page. Returns the current
 * user/profile (or nulls if not logged in / not an admin) so each page
 * can decide what to render (LoginForm / NotAuthorized / actual content).
 */
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
