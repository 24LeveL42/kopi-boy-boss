"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Spinner } from "../Spinner";

/**
 * Re-runs the current server page when any of `tables` changes (bursts
 * coalesced), and once a minute regardless, so ages and stages stay current.
 * Realtime only delivers for tables in the supabase_realtime publication,
 * hence also the timer and the manual Refresh button.
 */
export function LiveRefresher({ tables, channel }: { tables: string[]; channel: string }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const tableKey = tables.join(",");

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sub = supabase.channel(`ops:${channel}`);
    for (const table of tableKey.split(",")) {
      sub = sub.on("postgres_changes", { event: "*", schema: "public", table }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => router.refresh(), 500);
      });
    }
    sub.subscribe();
    const poll = setInterval(() => router.refresh(), 60_000);

    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      supabase.removeChannel(sub);
    };
  }, [router, channel, tableKey]);

  return (
    <button
      type="button"
      onClick={() => startRefresh(() => router.refresh())}
      disabled={refreshing}
      aria-busy={refreshing}
      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60"
      style={{ borderColor: "var(--oc-line)", background: "var(--oc-card)", color: "var(--oc-text)" }}
    >
      {refreshing && <Spinner className="size-3" />}
      Refresh
    </button>
  );
}
