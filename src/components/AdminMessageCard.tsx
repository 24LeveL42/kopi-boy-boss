"use client";

import { useState, useTransition } from "react";
import { ActionButton } from "@/components/ActionButton";
import { Spinner } from "@/components/Spinner";
import { replyToAdminMessage, setAdminMessageStatus, unblockMessageSender } from "@/lib/message-actions";
import { ADMIN_REPLY_MAX_LENGTH, normalizeAdminReply, type AdminMessageRow } from "@/lib/admin-messages";

const STATUS_STYLE: Record<AdminMessageRow["status"], { label: string; background: string; color: string }> = {
  open: { label: "Open", background: "#FEF3C7", color: "#92400E" },
  replied: { label: "Replied", background: "#D1FAE5", color: "#065F46" },
  closed: { label: "Closed", background: "var(--kb-cream)", color: "var(--kb-ink-soft)" },
};

export function AdminMessageCard({
  message,
  senderName,
  senderRole,
  senderBlocked,
  sentAt,
  repliedAt,
}: {
  message: AdminMessageRow;
  senderName: string;
  senderRole: string;
  senderBlocked: boolean;
  /** Pre-formatted on the server so SSR and hydration agree. */
  sentAt: string;
  repliedAt: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [sending, startSending] = useTransition();
  const [sendError, setSendError] = useState<string | null>(null);
  const status = STATUS_STYLE[message.status] ?? STATUS_STYLE.open;
  const canSend = !sending && normalizeAdminReply(draft) !== null;

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    setSendError(null);
    startSending(async () => {
      try {
        await replyToAdminMessage(message.id, draft);
        setDraft("");
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Reply couldn't be sent — please try again.");
      }
    });
  }

  return (
    <article className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {senderName}
            <span className="ml-2 font-normal capitalize" style={{ color: "var(--kb-ink-soft)" }}>
              {senderRole}
            </span>
          </p>
          <p className="text-[11px]" style={{ color: "var(--kb-ink-soft)" }}>
            {sentAt}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {senderBlocked && (
            <span
              className="rounded-full px-2.5 py-1 text-xs font-medium"
              style={{ background: "rgba(239,68,68,0.15)", color: "#DC2626" }}
            >
              Blocked
            </span>
          )}
          <span className="rounded-full px-2.5 py-1 text-xs font-medium" style={status}>
            {status.label}
          </span>
        </div>
      </header>

      <p className="mt-3 whitespace-pre-wrap rounded-xl px-3 py-2 text-sm break-words" style={{ background: "var(--kb-cream)" }}>
        {message.message}
      </p>

      {message.admin_reply && (
        <div className="mt-2 flex flex-col items-end">
          <span className="mb-0.5 text-[11px] font-semibold" style={{ color: "var(--kb-ink-soft)" }}>
            HQ reply{repliedAt && ` · ${repliedAt}`}
          </span>
          <p
            className="max-w-[80%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm break-words text-white"
            style={{ background: "var(--kb-green-deep)" }}
          >
            {message.admin_reply}
          </p>
        </div>
      )}

      <form onSubmit={handleSend} className="mt-3 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <textarea
            value={draft}
            onChange={(e) => {
              setSendError(null);
              setDraft(e.target.value);
            }}
            rows={2}
            maxLength={ADMIN_REPLY_MAX_LENGTH}
            placeholder={message.admin_reply ? "Send a new reply (replaces the one above)…" : `Reply to ${senderName}…`}
            aria-label={`Reply to ${senderName}`}
            className="w-full resize-y rounded-xl border px-3 py-2 text-sm outline-none"
            style={{ borderColor: "#E5E7EB", color: "var(--kb-ink)" }}
          />
          <p className="text-right text-[11px]" style={{ color: "var(--kb-ink-soft)" }}>
            {draft.length}/{ADMIN_REPLY_MAX_LENGTH}
          </p>
        </div>
        <button
          type="submit"
          disabled={!canSend}
          aria-busy={sending}
          className="mb-5 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          style={{ background: "var(--kb-green-deep)" }}
        >
          {sending && <Spinner className="size-3" />}
          {sending ? "Sending…" : "Send reply"}
        </button>
      </form>
      {sendError && (
        <p className="text-xs" style={{ color: "var(--kb-danger)" }}>
          {sendError}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-start gap-2">
        {message.status === "closed" ? (
          <ActionButton
            action={setAdminMessageStatus.bind(null, message.id, "open")}
            label="Reopen"
            pendingLabel="Reopening…"
            background="var(--kb-cream)"
            color="var(--kb-ink)"
          />
        ) : (
          <ActionButton
            action={setAdminMessageStatus.bind(null, message.id, "closed")}
            label="Close"
            pendingLabel="Closing…"
            background="var(--kb-cream)"
            color="var(--kb-ink)"
          />
        )}
        {senderBlocked && (
          <ActionButton
            action={unblockMessageSender.bind(null, message.sender_id)}
            label="Unblock this account"
            pendingLabel="Unblocking…"
            background="var(--kb-green-deep)"
            confirmMessage={`Unblock ${senderName}? They'll be able to sign in and take orders again.`}
          />
        )}
      </div>
    </article>
  );
}
