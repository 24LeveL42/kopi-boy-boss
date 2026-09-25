"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Keeps the /complaints list live: any new complaint message (RLS lets admins
 * see every thread) re-runs the server component. Bursts are coalesced so a
 * photo + text pair only refreshes once.
 */
export function ComplaintsRealtimeRefresher() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel("complaint_messages:admin-list")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "complaint_messages" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => router.refresh(), 300);
      })
      .subscribe();

    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
