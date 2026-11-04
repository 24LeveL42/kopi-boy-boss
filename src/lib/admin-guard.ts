/**
 * The one admin check shared by pages and server actions.
 *
 * Admin = the database says so: public.user_has_role('admin'), the same
 * function the RLS policies use. It runs as the signed-in user, so it checks
 * profiles.role for auth.uid() server-side. Nothing the browser sends is
 * trusted. Any error counts as "not admin" (fail closed).
 *
 * Pure module (type-only imports) so `node --test` can load it with a fake
 * client; require-admin.ts wires in the real one.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyClient = SupabaseClient<any, any, any>;

export class NotAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAdminError";
  }
}

/** True only when the database confirms the signed-in user is an admin. */
export async function isAdminWith(supabase: AnyClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("user_has_role", { check_role: "admin" });
    return !error && data === true;
  } catch {
    return false;
  }
}

/**
 * Throws NotAdminError unless someone is signed in AND the database confirms
 * they are an admin. Does nothing else on failure. getUser() (not getSession)
 * so the token is verified with Supabase Auth, not just read from the cookie.
 */
export async function assertAdminWith<C extends AnyClient>(supabase: C): Promise<{ supabase: C; user: User }> {
  let user: User | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error) user = data.user;
  } catch {
    user = null;
  }
  if (!user) throw new NotAdminError("Not signed in.");
  if (!(await isAdminWith(supabase))) throw new NotAdminError("Not allowed: admins only.");
  return { supabase, user };
}
