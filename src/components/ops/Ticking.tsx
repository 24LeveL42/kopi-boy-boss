"use client";

import { useEffect, useState } from "react";
import { formatAge, formatCountdown, paymentMsLeft } from "@/lib/ops";
import { StatusPill } from "./StatusPill";

/**
 * Clock that starts at the server's render time (so server HTML and the first
 * client render agree) and then ticks in the browser.
 */
function useNow(serverNow: number, everyMs: number) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** "12m" since `since`, refreshed every 15 seconds. */
export function Age({ since, serverNow }: { since: string; serverNow: number }) {
  const now = useNow(serverNow, 15_000);
  return <span className="tabular-nums">{formatAge(since, now)}</span>;
}

/** The PayNow countdown for an accepted, unpaid order: amber while running, red once overdue. */
export function PaymentCountdown({ decidedAt, serverNow }: { decidedAt: string | null; serverNow: number }) {
  const now = useNow(serverNow, 1_000);
  const left = paymentMsLeft(decidedAt, now);
  if (left === null) return null;
  return (
    <StatusPill tone={left > 0 ? "amber" : "red"} title="Customer pays the merchant by PayNow within 5 minutes of the cook accepting">
      <span className="tabular-nums">{formatCountdown(left)}</span>
    </StatusPill>
  );
}
