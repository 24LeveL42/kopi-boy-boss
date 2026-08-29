import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { HqDashboard } from "@/components/HqDashboard";
import type { Profile } from "@/lib/types-auth";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <LoginForm />;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single<Profile>();

  if (!profile || profile.role !== "admin") {
    return <NotAuthorized />;
  }

  return <HqDashboard />;
}
