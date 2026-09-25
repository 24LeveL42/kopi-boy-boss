import { ActionButton } from "@/components/ActionButton";
import { setComplaintThreadStatus } from "@/lib/actions";
import type { ThreadSummary } from "@/lib/complaints";

type ThreadState = Pick<ThreadSummary, "resolved" | "reopened" | "needsReply">;

/** Resolved / Needs reply / Reopened / Replied pill for a complaint thread. */
export function ThreadStatusBadge({ thread }: { thread: ThreadState }) {
  const [label, style] = thread.resolved
    ? ["Resolved", { background: "#D1FAE5", color: "#065F46" }]
    : thread.needsReply
      ? [thread.reopened ? "Reopened · needs reply" : "Needs reply", { background: "#FEF3C7", color: "#92400E" }]
      : [thread.reopened ? "Reopened" : "Replied", { background: "var(--kb-cream)", color: "var(--kb-ink-soft)" }];
  return (
    <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium" style={style}>
      {label}
    </span>
  );
}

/**
 * "Resolve" for an active thread, "Reopen" for a resolved one. Resolving while
 * the customer's last message is unanswered asks for confirmation first.
 */
export function ThreadStatusButton({ orderId, thread }: { orderId: string; thread: ThreadState }) {
  return thread.resolved ? (
    <ActionButton
      action={setComplaintThreadStatus.bind(null, orderId, "open")}
      label="Reopen"
      pendingLabel="Reopening…"
      background="var(--kb-cream)"
      color="var(--kb-ink)"
    />
  ) : (
    <ActionButton
      action={setComplaintThreadStatus.bind(null, orderId, "resolved")}
      label="Resolve"
      pendingLabel="Resolving…"
      background="var(--kb-green-deep)"
      confirmMessage={
        thread.needsReply ? "The customer's last message hasn't been answered yet. Mark this issue settled anyway?" : undefined
      }
    />
  );
}
