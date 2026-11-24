"use client";

import { useState, useTransition } from "react";
import { cancelAssistedShop } from "@/lib/actions";
import { REASON_MAX } from "@/lib/assisted-onboarding";
import { Spinner } from "./Spinner";

/**
 * Cancels a draft (with a reason): its live link stops working and the draft
 * is frozen. Nothing is deleted; the draft and its history stay.
 */
export function CancelAssistedShop({ shopId }: { shopId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function cancel(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      try {
        const r = await cancelAssistedShop(shopId, reason);
        if (r.ok) setOpen(false);
        else setError(r.message);
      } catch {
        setError("Not cancelled: your admin session couldn't be confirmed. Please sign in again and retry.");
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border px-4 py-2 text-sm"
        style={{ borderColor: "var(--oc-line)", color: "var(--oc-red-fg)" }}
      >
        Cancel this draft
      </button>
    );
  }

  return (
    <form onSubmit={cancel} className="space-y-2">
      <p className="text-sm" style={{ color: "var(--oc-text)" }}>
        Cancelling stops any live claim link and freezes the draft. It can&apos;t be undone; you can set up a new draft later.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          maxLength={REASON_MAX}
          placeholder="Reason, e.g. owner changed their mind"
          aria-label="Reason for cancelling"
          disabled={pending}
          className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: "var(--oc-line)", background: "var(--oc-card)", color: "var(--oc-text)" }}
        />
        <button
          type="submit"
          disabled={pending || !reason.trim()}
          aria-busy={pending}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--oc-red-fg)" }}
        >
          {pending && <Spinner className="size-3.5" />}
          Cancel draft
        </button>
        <button type="button" disabled={pending} onClick={() => setOpen(false)} className="text-sm underline" style={{ color: "var(--oc-text-soft)" }}>
          Keep it
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm" style={{ color: "var(--oc-red-fg)" }}>
          {error}
        </p>
      )}
    </form>
  );
}
