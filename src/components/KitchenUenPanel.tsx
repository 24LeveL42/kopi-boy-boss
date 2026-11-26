"use client";

import { useState, useTransition } from "react";
import { setKitchenBusinessUen } from "@/lib/actions";
import { UEN_PENDING_NOTE, type KitchenUenStatus } from "@/lib/kitchen-uen";
import { Spinner } from "./Spinner";

/**
 * HQ's "Business UEN" on the merchant page. Shows the UEN, "UEN pending" when
 * a kitchen that needs one (its approved application isn't Home Cook) has
 * none yet, or why none is needed. Setting or correcting it goes through the
 * setKitchenBusinessUen server action (admin_set_kitchen_business_uen): the
 * UEN, the kitchen's business name typed to confirm, and a reason, all
 * re-checked and logged by the database.
 */
export function KitchenUenPanel({
  kitchenId,
  businessName,
  status,
}: {
  kitchenId: string;
  businessName: string;
  status: KitchenUenStatus;
}) {
  const [open, setOpen] = useState(status.state === "pending");
  const [uen, setUen] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [reason, setReason] = useState("");
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const inputStyle = { borderColor: "var(--oc-line)", background: "var(--oc-card)", color: "var(--oc-text)" };
  const input = "w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-70";
  const canEdit = status.state === "set" || status.state === "pending";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    setNotice(null);
    startSaving(async () => {
      try {
        const result = await setKitchenBusinessUen(kitchenId, uen, confirmName, reason);
        if (result.ok) {
          setNotice(`Saved. The business UEN is now ${result.uen}; the change is recorded in the change history.`);
          setUen("");
          setConfirmName("");
          setReason("");
          setOpen(false);
        } else {
          setError(result.message);
        }
      } catch {
        // Only assertAdmin() throws (signed out, or not an admin).
        setError("Not saved: your admin session couldn't be confirmed. Please sign in again and retry.");
      }
    });
  }

  return (
    <div className="space-y-3 text-sm">
      {status.state === "set" && (
        <p style={{ color: "var(--oc-text)" }}>
          Business UEN <span className="font-mono font-semibold">{status.uen}</span>
        </p>
      )}
      {status.state === "pending" && (
        <div className="rounded-lg px-3 py-2" style={{ background: "var(--oc-amber-bg)", color: "var(--oc-amber-fg)" }}>
          <p className="font-semibold">UEN pending</p>
          <p className="mt-0.5 text-xs">{UEN_PENDING_NOTE}</p>
        </div>
      )}
      {status.state === "not-needed" && (
        <p style={{ color: "var(--oc-text-soft)" }}>
          {status.reason === "home-cook"
            ? "Home Cook: no business UEN needed."
            : "No approved application for this kitchen, so it has no business UEN to hold."}
        </p>
      )}
      {status.state === "unknown" && (
        <p role="alert" className="rounded-lg px-3 py-2" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          Couldn&apos;t check the business UEN: {status.message}. Reload the page to try again.
        </p>
      )}

      {notice && (
        <p role="status" className="rounded-lg px-3 py-2" style={{ background: "var(--oc-green-bg)", color: "var(--oc-green-fg)" }}>
          {notice}
        </p>
      )}

      {canEdit && !open && (
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setOpen(true);
          }}
          className="font-medium underline"
          style={{ color: "var(--oc-accent)" }}
        >
          {status.state === "pending" ? "Set the UEN" : "Correct the UEN"}
        </button>
      )}

      {canEdit && open && (
        <form onSubmit={handleSubmit} className="space-y-3">
          <fieldset className="space-y-3" disabled={saving}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Business UEN">
                <input
                  value={uen}
                  onChange={(e) => setUen(e.target.value)}
                  required
                  maxLength={10}
                  placeholder="53123456A"
                  className={`${input} uppercase`}
                  style={inputStyle}
                />
              </Field>
              <Field label={`Type the business name to confirm: ${businessName}`}>
                <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} required maxLength={80} className={input} style={inputStyle} />
              </Field>
            </div>
            <Field label="Reason (kept in the change history)">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                maxLength={200}
                placeholder="Owner sent their ACRA details on WhatsApp"
                className={input}
                style={inputStyle}
              />
            </Field>
          </fieldset>
          {error && (
            <p role="alert" className="rounded-lg px-3 py-2" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving || !uen.trim() || !confirmName.trim() || !reason.trim()}
              aria-busy={saving}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--oc-accent)" }}
            >
              {saving && <Spinner className="size-3.5" />}
              {saving ? "Saving…" : "Save business UEN"}
            </button>
            {status.state === "set" && (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setError(null);
                  setOpen(false);
                }}
                className="text-sm font-medium underline"
                style={{ color: "var(--oc-text-soft)" }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
