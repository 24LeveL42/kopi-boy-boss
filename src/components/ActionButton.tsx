"use client";

import { useState, useTransition } from "react";

export function ActionButton({
  action,
  label,
  pendingLabel,
  background,
  color,
  confirmMessage,
}: {
  action: (...args: never[]) => Promise<void>;
  label: string;
  pendingLabel?: string;
  background: string;
  color?: string;
  confirmMessage?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setError(null);
    startTransition(async () => {
      try {
        await action();
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
        className="rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-60"
        style={{ background, color: color ?? "white" }}
      >
        {pending ? pendingLabel ?? "Working…" : label}
      </button>
      {error && (
        <p className="mt-1 max-w-[180px] text-[11px] leading-snug" style={{ color: "#DC2626" }}>
          {error}
        </p>
      )}
    </div>
  );
}
