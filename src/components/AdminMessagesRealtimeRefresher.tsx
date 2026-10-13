"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Spinner } from "./Spinner";

/**
 * Keeps /messages live: any insert/update on admin_messages re-runs the server
 * component (bursts coalesced). Realtime only delivers if the table is in the
 * supabase_realtime publication, so there's also a manual Refresh button.
 */
export function AdminMessagesRealtimeRefresher() {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel("admin_messages:admin-inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "admin_messages" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => router.refresh(), 300);
      })
      .subscribe();

    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [router]);

  return (
    <button
      type="button"
      onClick={() => startRefresh(() => router.refresh())}
      disabled={refreshing}
      aria-busy={refreshing}
      className="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium disabled:opacity-60"
      style={{ background: "var(--kb-navy-raised)", color: "var(--kb-on-navy-soft)" }}
    >
      {refreshing && <Spinner className="size-3" />}
      Refresh
    </button>
  );
}
