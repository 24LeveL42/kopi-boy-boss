import { createClient } from "@/lib/supabase/server";
import { assertAdminWith, isAdminWith } from "@/lib/admin-guard";
import type { Profile } from "@/lib/types-auth";

/**
 * Who is signed in, for pages. NOT an admin check: a page must still call
 * hasAdminRole() and show <NotAuthorized/> when it returns false.
 */
export async function getViewer() {
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
 * user is HQ. The same check assertAdmin() and the RLS policies use, so the
 * page gate and the data gate can't disagree. Any error counts as "not admin".
 */
export async function hasAdminRole(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  return isAdminWith(supabase);
}

/**
 * First line of every server action. Throws unless a user is signed in and
 * the database confirms they are an admin; returns that verified client and
 * user so the action doesn't build a second one.
 */
export async function assertAdmin() {
  return assertAdminWith(await createClient());
}
