/**
 * Complaint threads (customer <-> HQ) — shape + pure helpers for /complaints.
 *
 * The table is owned by the Customer app (kopi-boy-customer-v2,
 * docs/supabase-schema.sql §25–26, docs/support-chat.md): one thread per
 * order, readable/writable by that order's customer and by any admin via
 * complaint_thread_participant(), which checks public.user_has_role('admin').
 * Messages are immutable (SELECT + INSERT only) and a thread never closes.
 * RLS is the only thing enforcing access; nothing here duplicates it.
 */

export interface ComplaintMessageRow {
  id: string;
  order_id: string;
  sender_id: string;
  body: string;
  /** Key in the private `complaint-photos` bucket, not a URL — rendered through short-lived signed URLs. */
  photo_path: string | null;
  created_at: string;
}

export const COMPLAINT_PHOTO_BUCKET = "complaint-photos";

/** How long a rendered evidence photo link stays valid (same as the Customer app). */
export const COMPLAINT_PHOTO_URL_TTL_SECONDS = 60 * 60;

/** Matches the table's `length(body) <= 2000` check. */
export const COMPLAINT_BODY_MAX_LENGTH = 2000;

/** How many past messages an open thread loads (same as the Customer app's chats). */
export const COMPLAINT_THREAD_FETCH_LIMIT = 200;

/**
 * How many recent messages the thread list scans. The list is built from the
 * newest messages across all threads, so a thread whose last message is older
 * than this window drops off the list (it still opens by link from /orders).
 */
export const COMPLAINT_LIST_SCAN_LIMIT = 1000;

/**
 * Merges freshly-fetched rows into what's already in state. Realtime can
 * deliver a row before the initial fetch resolves (or the fetch can include a
 * row Realtime already delivered), so union by id and sort oldest-first.
 */
export function mergeMessages<T extends { id: string; created_at: string }>(existing: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1
  );
}

/** Trims a reply; null when there's nothing sendable (HQ replies are text-only). */
export function normalizeReply(raw: string): string | null {
  const body = raw.trim();
  if (!body || body.length > COMPLAINT_BODY_MAX_LENGTH) return null;
  return body;
}

export interface ThreadSummary {
  orderId: string;
  customerId: string | null;
  messageCount: number;
  photoCount: number;
  lastMessage: ComplaintMessageRow;
  /** The newest message came from the order's customer, so HQ owes a reply. */
  needsReply: boolean;
  /** HQ marked it settled and the customer hasn't written since. */
  resolved: boolean;
  /** HQ marked it settled, then the customer wrote again — back in the active list. */
  reopened: boolean;
}

export interface CustomerThreadGroup {
  customerId: string | null;
  threads: ThreadSummary[];
  needsReplyCount: number;
  lastActivity: string;
}

/**
 * Collapses messages (any order) into one summary per order thread, grouped by
 * the order's customer. Threads that need a reply sort first, then newest
 * activity; groups follow the same rule using their most urgent thread.
 * `customerByOrder` comes from public.orders; a missing entry (order not
 * readable) still gets a thread, under a null customer.
 * `resolvedAtByOrder` holds resolved_at for threads whose complaint_threads
 * status is 'resolved'. `include` picks which threads to keep (e.g. one tab)
 * before grouping, so group counts and ordering only reflect what's shown.
 */
export function groupThreads(
  messages: ComplaintMessageRow[],
  customerByOrder: Record<string, string>,
  resolvedAtByOrder: Record<string, string> = {},
  include: (t: ThreadSummary) => boolean = () => true
): CustomerThreadGroup[] {
  const byOrder = new Map<string, ComplaintMessageRow[]>();
  for (const m of messages) {
    const list = byOrder.get(m.order_id);
    if (list) list.push(m);
    else byOrder.set(m.order_id, [m]);
  }

  const threads: ThreadSummary[] = [];
  for (const [orderId, rows] of byOrder) {
    const sorted = mergeMessages([], rows);
    const lastMessage = sorted[sorted.length - 1];
    const customerId = customerByOrder[orderId] ?? null;
    const resolvedAt = resolvedAtByOrder[orderId];
    // resolved_at and created_at are both server timestamps, so this compare is safe.
    const customerWroteSince =
      resolvedAt !== undefined &&
      sorted.some((m) => m.sender_id === customerId && new Date(m.created_at) > new Date(resolvedAt));
    const thread: ThreadSummary = {
      orderId,
      customerId,
      messageCount: sorted.length,
      photoCount: sorted.filter((m) => m.photo_path).length,
      lastMessage,
      needsReply: false,
      resolved: resolvedAt !== undefined && !customerWroteSince,
      reopened: customerWroteSince,
    };
    thread.needsReply = !thread.resolved && customerId !== null && lastMessage.sender_id === customerId;
    if (include(thread)) threads.push(thread);
  }

  const byUrgency = (a: { needsReply: boolean; at: string }, b: { needsReply: boolean; at: string }) =>
    a.needsReply !== b.needsReply ? (a.needsReply ? -1 : 1) : a.at < b.at ? 1 : a.at > b.at ? -1 : 0;

  const groups = new Map<string | null, ThreadSummary[]>();
  for (const t of threads) {
    const list = groups.get(t.customerId);
    if (list) list.push(t);
    else groups.set(t.customerId, [t]);
  }

  return [...groups.entries()]
    .map(([customerId, list]) => {
      list.sort((a, b) =>
        byUrgency({ needsReply: a.needsReply, at: a.lastMessage.created_at }, { needsReply: b.needsReply, at: b.lastMessage.created_at })
      );
      return {
        customerId,
        threads: list,
        needsReplyCount: list.filter((t) => t.needsReply).length,
        lastActivity: list.reduce((max, t) => (t.lastMessage.created_at > max ? t.lastMessage.created_at : max), ""),
      };
    })
    .sort((a, b) =>
      byUrgency({ needsReply: a.needsReplyCount > 0, at: a.lastActivity }, { needsReply: b.needsReplyCount > 0, at: b.lastActivity })
    );
}

/** Short Singapore-time stamp for message and list timestamps. */
export function formatSgTime(iso: string): string {
  return new Date(iso).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
