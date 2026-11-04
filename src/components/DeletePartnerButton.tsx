"use client";

import { useState, useTransition } from "react";
import { deleteTestPartner } from "@/lib/actions";
import type { DeleteReport } from "@/lib/delete-partner";
import { Spinner } from "./Spinner";

/**
 * Delete a test cook/rider. The admin must type the partner's name (a cook's
 * kitchen business name; a rider's full name, or email when there's no
 * name). `confirmName` is only shown as a hint: the server reads the real
 * name and does the comparing. Shows the server's report of exactly what
 * was and wasn't deleted.
 */
export function DeletePartnerButton({
  partnerId,
  role,
  confirmName,
  background = "var(--oc-grey-bg)",
}: {
  partnerId: string;
  role: "cook" | "rider";
  /** What the admin should type; null when there's nothing on file (the server will refuse). */
  confirmName: string | null;
  background?: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [report, setReport] = useState<DeleteReport | null>(null);
  const [thrown, setThrown] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const what = role === "cook" ? "kitchen business name" : "rider's name (or email if there's no name)";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setReport(null);
    setThrown(null);
    startTransition(async () => {
      try {
        const result = await deleteTestPartner(partnerId, role, typed);
        setReport(result);
        if (result.ok) setOpen(false);
      } catch {
        // Only assertAdmin throws here: signed out, or not an admin.
        setThrown("Not allowed. Sign in again as an admin and retry. Nothing was deleted.");
      }
    });
  }

  return (
    // Stop clicks reaching a clickable table row underneath.
    <div className="text-left" onClick={(e) => e.stopPropagation()}>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setTyped("");
            setReport(null);
            setThrown(null);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"
          style={{ background, color: "var(--kb-danger)" }}
        >
          Delete
        </button>
      ) : (
        <form onSubmit={submit} className="w-[240px] space-y-1.5 rounded-lg border p-2" style={{ borderColor: "var(--oc-line)" }}>
          <p className="text-[11px] leading-snug" style={{ color: "var(--oc-text)" }}>
            Removes their profile, application{role === "cook" ? ", kitchen and menu" : ""}. Type the {what} to confirm
            {confirmName ? (
              <>
                : <strong className="break-words">{confirmName}</strong>
              </>
            ) : (
              ". (None on file, so this will be refused.)"
            )}
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            aria-label={`Type the ${what} to confirm`}
            className="w-full rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: "var(--oc-line)" }}
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="rounded-md px-2 py-1 text-xs"
              style={{ background: "var(--oc-grey-bg)" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || typed.trim() === ""}
              aria-busy={pending}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
              style={{ background: "var(--kb-danger)" }}
            >
              {pending && <Spinner className="size-3" />}
              {pending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </form>
      )}
      {thrown && <ReportText tone="error">{thrown}</ReportText>}
      {report && <DeleteReportView report={report} />}
    </div>
  );
}

function DeleteReportView({ report }: { report: DeleteReport }) {
  return (
    <div className="mt-1 max-w-[240px] space-y-0.5" role={report.ok ? "status" : "alert"}>
      <ReportText tone={report.ok ? "ok" : "error"}>{report.ok ? "Deleted." : report.error ?? "Not deleted."}</ReportText>
      {report.deleted.length > 0 && <ReportText tone="muted">Deleted: {report.deleted.join(", ")}</ReportText>}
      {report.notDeleted.length > 0 && <ReportText tone="muted">Not deleted: {report.notDeleted.join(", ")}</ReportText>}
    </div>
  );
}

function ReportText({ tone, children }: { tone: "ok" | "error" | "muted"; children: React.ReactNode }) {
  const color = tone === "error" ? "#DC2626" : tone === "ok" ? "var(--kb-green-deep)" : "var(--oc-text-soft)";
  return (
    <p className="text-[11px] leading-snug" style={{ color }}>
      {children}
    </p>
  );
}
