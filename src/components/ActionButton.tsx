"use client";

import { useState, useTransition } from "react";
import { Spinner } from "./Spinner";

/** An action may hand back a short line for the admin (e.g. "Email not sent: ..."). */
export type ActionNotice = { tone: "ok" | "warn"; notice: string };

function isNotice(value: unknown): value is ActionNotice {
  return typeof value === "object" && value !== null && typeof (value as ActionNotice).notice === "string";
}

export function ActionButton({
  action,
  label,
  pendingLabel,
  background,
  color,
  confirmMessage,
  onResult,
}: {
  action: (...args: never[]) => Promise<void | ActionNotice>;
  label: string;
  pendingLabel?: string;
  background: string;
  color?: string;
  confirmMessage?: string;
  /** Receives the action's notice. Without it, the notice shows under the button. */
  onResult?: (notice: ActionNotice) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);

  function handleClick() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (isNotice(result)) {
          if (onResult) onResult(result);
          else setNotice(result);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong — please try again.");
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-60"
        style={{ background, color: color ?? "white" }}
      >
        {pending && <Spinner className="size-3" />}
        {pending ? pendingLabel ?? "Working…" : label}
      </button>
      {error && (
        <p className="mt-1 max-w-[180px] text-[11px] leading-snug" style={{ color: "#DC2626" }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-1 max-w-[180px] text-[11px] leading-snug" style={{ color: notice.tone === "warn" ? "#B45309" : "var(--kb-green-deep)" }}>
          {notice.notice}
        </p>
      )}
    </div>
  );
}
