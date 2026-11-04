import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { Overview } from "@/components/ops/Overview";
import { getViewer, hasAdminRole } from "@/lib/require-admin";

export default async function Home() {
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  return <Overview />;
}
