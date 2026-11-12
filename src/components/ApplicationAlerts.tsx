"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  ALERT_FETCH_LIMIT,
  ALERT_POLL_MS,
  ALERT_TABLES,
  ALERT_TOAST_MS,
  createAlertTracker,
  mergeAlerts,
  pendingTotal,
  titleWithCount,
  type ApplicationAlert,
  type PendingCookRow,
  type PendingRiderRow,
} from "@/lib/application-alerts";
import { playChime } from "@/lib/alert-sound";

/**
 * Pop-ups (plus the chime) for new merchant and rider applications, and the
 * pending count in the browser tab title. Mounted once per admin page by the
 * sidebar. It re-reads the pending lists when Realtime reports a change to
 * either table, and every 60 s whatever Realtime is doing, so a failed or
 * missing live connection only makes alerts slower, never breaks the page.
 * Reads id + business name only; personal details are never fetched.
 */

// Module-level so a page change (which remounts the sidebar) neither repeats
// an alert nor treats every pending application as new.
const tracker = createAlertTracker();

function useTabTitleCount(count: number | null) {
  useEffect(() => {
    const apply = () => {
      const want = titleWithCount(document.title, count);
      if (document.title !== want) document.title = want;
    };
    apply();
    // Next.js rewrites the title on navigation; put the count back when it does.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = titleWithCount(document.title, 0);
    };
  }, [count]);
}

export function ApplicationAlerts() {
  const [alerts, setAlerts] = useState<ApplicationAlert[]>([]);
  const [count, setCount] = useState<number | null>(null);
  useTabTitleCount(count);

  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const [cooks, riders] = await Promise.all([
          supabase
            .from("cook_applications")
            .select("id, business_name", { count: "exact" })
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(ALERT_FETCH_LIMIT)
            .returns<PendingCookRow[]>(),
          supabase
            .from("rider_applications")
            .select("id", { count: "exact" })
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(ALERT_FETCH_LIMIT)
            .returns<PendingRiderRow[]>(),
        ]);
        if (disposed) return;
        const fresh = [
          ...tracker.take("merchant", cooks.error ? null : (cooks.data ?? [])),
          ...tracker.take("rider", riders.error ? null : (riders.data ?? [])),
        ];
        setCount(pendingTotal(cooks.error ? null : (cooks.count ?? 0), riders.error ? null : (riders.count ?? 0)));
        if (fresh.length > 0) {
          setAlerts((prev) => mergeAlerts(prev, fresh));
          playChime();
        }
      } catch {
        // network trouble: try again on the next change or poll
      }
    }

    void load();
    const poll = setInterval(() => void load(), ALERT_POLL_MS);

    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase.channel("ops:application-alerts");
      for (const table of ALERT_TABLES) {
        channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => void load(), 500);
        });
      }
      // On CHANNEL_ERROR / TIMED_OUT / CLOSED there's nothing to do: the poll keeps going.
      channel.subscribe();
    } catch {
      channel = null;
    }

    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (channel) void supabase.removeChannel(channel).catch(() => {});
    };
  }, []);

  const dismiss = useCallback((key: string) => setAlerts((prev) => prev.filter((a) => a.key !== key)), []);

  if (alerts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 left-4 z-[1300] flex flex-col items-stretch gap-2 sm:left-auto sm:w-80"
    >
      {alerts.map((a) => (
        <AlertToast key={a.key} alert={a} onClose={dismiss} />
      ))}
    </div>
  );
}

/** One pop-up; it closes itself after ALERT_TOAST_MS. */
function AlertToast({ alert, onClose }: { alert: ApplicationAlert; onClose: (key: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onClose(alert.key), ALERT_TOAST_MS);
    return () => clearTimeout(t);
  }, [alert.key, onClose]);

  return (
    <div
      className="rounded-xl border px-4 py-3 text-sm shadow-lg"
      style={{ background: "var(--oc-card)", borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-semibold break-words">{alert.title}</p>
        <button
          type="button"
          onClick={() => onClose(alert.key)}
          aria-label="Close"
          className="-mt-0.5 shrink-0 rounded px-1 text-base leading-none"
          style={{ color: "var(--oc-text-soft)" }}
        >
          ×
        </button>
      </div>
      <Link
        href={alert.href}
        onClick={() => onClose(alert.key)}
        className="mt-1 inline-block text-xs font-semibold underline"
        style={{ color: "var(--oc-accent)" }}
      >
        Review application
      </Link>
    </div>
  );
}
