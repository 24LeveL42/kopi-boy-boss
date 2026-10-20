"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Spinner } from "./Spinner";

export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleSignOut() {
    startTransition(async () => {
      // On failure the button just re-enables so they can try again.
      try {
        // Created on click, not render: the button also sits in prerendered loading skeletons.
        const { error } = await createClient().auth.signOut();
        if (error) return;
        router.push("/");
        router.refresh();
      } catch {}
    });
  }

  return (
    <button
      onClick={handleSignOut}
      disabled={pending}
      aria-busy={pending}
      className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium disabled:opacity-60"
      style={{ background: "var(--kb-cream)", color: "var(--kb-ink)" }}
    >
      {pending && <Spinner />}
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
