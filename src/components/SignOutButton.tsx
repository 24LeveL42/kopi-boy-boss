"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const supabase = createClient();
  const router = useRouter();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <button
      onClick={handleSignOut}
      className="w-full rounded-xl py-2.5 text-sm font-medium"
      style={{ background: "var(--kb-cream)", color: "var(--kb-ink)" }}
    >
      Sign out
    </button>
  );
}
