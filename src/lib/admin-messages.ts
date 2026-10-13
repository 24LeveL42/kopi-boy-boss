/**
 * Partner -> HQ messages (public.admin_messages) — shape + pure helpers for
 * /messages and the nav badge. The table lives in the shared Supabase project
 * (owned by the Partner app): riders and cooks insert, admins read and update
 * every row. A DB trigger stamps replied_at and flips status to 'replied'
 * whenever admin_reply is written, so the Boss app never sets those itself.
 * No imports so `node --test` can load this file directly.
 */

export type AdminMessageStatus = "open" | "replied" | "closed";

export interface AdminMessageRow {
  id: string;
  sender_id: string;
  sender_role: string | null;
  message: string;
  admin_reply: string | null;
  replied_at: string | null;
  status: AdminMessageStatus;
  created_at: string;
}

export const ADMIN_REPLY_MAX_LENGTH = 500;

/** How many recent messages /messages loads. */
export const ADMIN_MESSAGES_FETCH_LIMIT = 500;

export type InboxView = AdminMessageStatus | "all";

export const INBOX_VIEWS: { view: InboxView; label: string }[] = [
  { view: "open", label: "Open" },
  { view: "replied", label: "Replied" },
  { view: "closed", label: "Closed" },
  { view: "all", label: "All" },
];

/** ?view= value -> tab; anything unknown lands on Open. */
export function parseInboxView(raw: string | string[] | undefined): InboxView {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return INBOX_VIEWS.some((t) => t.view === v) ? (v as InboxView) : "open";
}

export function countByStatus(messages: readonly Pick<AdminMessageRow, "status">[]): Record<InboxView, number> {
  const counts: Record<InboxView, number> = { open: 0, replied: 0, closed: 0, all: messages.length };
  for (const m of messages) if (m.status === "open" || m.status === "replied" || m.status === "closed") counts[m.status]++;
  return counts;
}

/** Newest first, narrowed to the tab. Returns a new array. */
export function messagesForView<T extends Pick<AdminMessageRow, "status" | "created_at">>(
  messages: readonly T[],
  view: InboxView
): T[] {
  return messages
    .filter((m) => view === "all" || m.status === view)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/** Text for the red nav badge: nothing at zero (or on a bad count), capped at "99+". */
export function badgeLabel(openCount: number | null | undefined): string | null {
  if (!openCount || !Number.isFinite(openCount) || openCount <= 0) return null;
  return openCount > 99 ? "99+" : String(Math.floor(openCount));
}

/** Trims a reply; null when there's nothing sendable or it's over the limit. */
export function normalizeAdminReply(raw: string): string | null {
  const body = raw.trim();
  if (!body || body.length > ADMIN_REPLY_MAX_LENGTH) return null;
  return body;
}
