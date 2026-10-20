/**
 * Operations Centre — pure helpers that turn rows from public.orders and
 * public.delivery_requests into what the admin screens show: one stage per
 * order, the payment countdown, ages, the "needs your attention" order, the
 * pipeline counts and the activity feed. No imports so `node --test` can load
 * this file directly (see ops.test.ts).
 *
 * order_status, payment_status, preparation_status and the delivery request's
 * status are separate columns by design (Customer schema §12/§15, Partner
 * schema §18/§21). The stage here is a display summary only; nothing writes it.
 */

/** The window the customer has to pay by PayNow once the cook accepts (counted from orders.decided_at). */
export const PAYMENT_WINDOW_MINUTES = 5;

/** Same thresholds as the Partner app's timed reminders (supabase-notifications.sql §11). */
export const COOK_RESPONSE_MINUTES = 5;
export const RIDER_WAIT_MINUTES = 10;

const MINUTE = 60_000;

export interface OrderFacts {
  id: string;
  customer_id: string;
  kitchen_id: string;
  order_status: string;
  payment_status: string;
  preparation_status?: string | null;
  subtotal: number | string;
  delivery_fee_estimate?: number | string | null;
  created_at: string;
  decided_at: string | null;
  paid_at: string | null;
  ready_at?: string | null;
}

export interface DeliveryFacts {
  id: string;
  order_id: string;
  rider_id: string | null;
  status: string;
  created_at: string;
  accepted_at: string | null;
  completed_at: string | null;
}

export type OrderStage =
  | "awaiting_cook"
  | "awaiting_payment"
  | "preparing"
  | "awaiting_rider"
  | "with_rider"
  | "delivered"
  | "rejected"
  | "cancelled";

/** Live stages in pipeline order. */
export const LIVE_STAGES: readonly OrderStage[] = [
  "awaiting_cook",
  "awaiting_payment",
  "preparing",
  "awaiting_rider",
  "with_rider",
];

export const STAGE_LABEL: Record<OrderStage, string> = {
  awaiting_cook: "Waiting for cook",
  awaiting_payment: "Waiting for payment",
  preparing: "Cooking",
  awaiting_rider: "Waiting for rider",
  with_rider: "With rider",
  delivered: "Delivered",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export type Tone = "green" | "amber" | "red" | "blue" | "purple" | "grey";

export const STAGE_TONE: Record<OrderStage, Tone> = {
  awaiting_cook: "amber",
  awaiting_payment: "amber",
  preparing: "purple",
  awaiting_rider: "purple",
  with_rider: "purple",
  delivered: "green",
  rejected: "red",
  cancelled: "red",
};

export function isLiveStage(stage: OrderStage): boolean {
  return LIVE_STAGES.includes(stage);
}

const DELIVERY_PRIORITY: Record<string, number> = { completed: 4, accepted: 3, release_requested: 2, open: 1 };

/**
 * The delivery request that speaks for an order. An order can collect several
 * (a rider releases it, the cook cancels and re-requests), so the most
 * advanced one wins, newest first among equals. Cancelled ones never count.
 */
export function currentDelivery<T extends DeliveryFacts>(deliveries: readonly T[]): T | null {
  let best: T | null = null;
  for (const d of deliveries) {
    const rank = DELIVERY_PRIORITY[d.status] ?? 0;
    if (rank === 0) continue;
    const bestRank = best ? DELIVERY_PRIORITY[best.status] : 0;
    if (!best || rank > bestRank || (rank === bestRank && d.created_at > best.created_at)) best = d;
  }
  return best;
}

export function orderStage(order: OrderFacts, delivery: DeliveryFacts | null): OrderStage {
  if (order.order_status === "rejected") return "rejected";
  if (order.order_status === "cancelled") return "cancelled";
  if (delivery?.status === "completed") return "delivered";
  if (order.order_status === "placed") return "awaiting_cook";
  if (delivery?.status === "accepted") return "with_rider";
  if (order.payment_status !== "paid") return "awaiting_payment";
  if (delivery || order.preparation_status === "ready") return "awaiting_rider";
  return "preparing";
}

/** Why a finished order ended. Only customers cancel (while 'placed'); only cooks reject. */
export function pastOutcome(stage: OrderStage): string {
  if (stage === "delivered") return "Delivered";
  if (stage === "rejected") return "Rejected by cook";
  if (stage === "cancelled") return "Cancelled by customer";
  return STAGE_LABEL[stage];
}

/** Milliseconds left to pay (negative once overdue), or null when there's no accept time. */
export function paymentMsLeft(decidedAt: string | null, nowMs: number): number | null {
  if (!decidedAt) return null;
  const decided = Date.parse(decidedAt);
  if (Number.isNaN(decided)) return null;
  return decided + PAYMENT_WINDOW_MINUTES * MINUTE - nowMs;
}

/** "4:05 left", or "Overdue 3m" once the window has passed. */
export function formatCountdown(msLeft: number): string {
  if (msLeft > 0) {
    const total = Math.ceil(msLeft / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} left`;
  }
  return `Overdue ${formatDuration(-msLeft)}`;
}

/** Compact duration: "40s", "12m", "3h 5m", "2d 4h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function formatAge(sinceIso: string, nowMs: number): string {
  return formatDuration(nowMs - Date.parse(sinceIso));
}

/** Start of "today" in Singapore (UTC+8, no daylight saving) as an ISO timestamp. */
export function sgDayStartIso(nowMs: number): string {
  const offset = 8 * 60 * MINUTE;
  const day = 24 * 60 * MINUTE;
  return new Date(Math.floor((nowMs + offset) / day) * day - offset).toISOString();
}

export function formatSgd(amount: number | string | null | undefined): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `S$${n.toFixed(2)}`;
}

export function shortId(id: string): string {
  return `#${id.slice(0, 8)}`;
}

export function countStages(stages: readonly OrderStage[]): Record<OrderStage, number> {
  const counts = Object.fromEntries(Object.keys(STAGE_LABEL).map((k) => [k, 0])) as Record<OrderStage, number>;
  for (const s of stages) counts[s]++;
  return counts;
}

/** Riders holding an accepted (not yet completed) delivery. */
export function ridersOnDelivery(deliveries: readonly DeliveryFacts[]): Set<string> {
  return new Set(deliveries.filter((d) => d.status === "accepted" && d.rider_id).map((d) => d.rider_id!));
}

/** Completed deliveries per rider since `sinceIso`. */
export function deliveredSince(deliveries: readonly DeliveryFacts[], sinceIso: string): Map<string, number> {
  const since = Date.parse(sinceIso);
  const counts = new Map<string, number>();
  for (const d of deliveries) {
    if (d.status !== "completed" || !d.rider_id || !d.completed_at || Date.parse(d.completed_at) < since) continue;
    counts.set(d.rider_id, (counts.get(d.rider_id) ?? 0) + 1);
  }
  return counts;
}

/* ---------------------------------------------------------------- attention */

export type AttentionKind =
  | "payment_overdue"
  | "no_rider"
  | "rider_released"
  | "complaint_reply"
  | "cook_slow"
  | "message_open"
  | "merchant_application"
  | "rider_application";

/** Lower is more urgent. Money and food going cold first, then people waiting on HQ, then paperwork. */
export const ATTENTION_RANK: Record<AttentionKind, number> = {
  payment_overdue: 0,
  no_rider: 1,
  rider_released: 2,
  complaint_reply: 3,
  cook_slow: 4,
  message_open: 5,
  merchant_application: 6,
  rider_application: 6,
};

export const ATTENTION_TONE: Record<AttentionKind, Tone> = {
  payment_overdue: "red",
  no_rider: "red",
  rider_released: "amber",
  complaint_reply: "amber",
  cook_slow: "amber",
  message_open: "amber",
  merchant_application: "blue",
  rider_application: "blue",
};

/** The order-related problem worth flagging, if any, and since when. */
export function orderAttention(
  order: OrderFacts,
  delivery: DeliveryFacts | null,
  nowMs: number
): { kind: AttentionKind; since: string } | null {
  const stage = orderStage(order, delivery);
  if (stage === "awaiting_payment") {
    const left = paymentMsLeft(order.decided_at, nowMs);
    if (left !== null && left <= 0) return { kind: "payment_overdue", since: order.decided_at! };
  }
  if (stage === "awaiting_cook" && nowMs - Date.parse(order.created_at) >= COOK_RESPONSE_MINUTES * MINUTE) {
    return { kind: "cook_slow", since: order.created_at };
  }
  if (stage === "awaiting_rider" && delivery) {
    if (delivery.status === "release_requested") return { kind: "rider_released", since: delivery.accepted_at ?? delivery.created_at };
    if (delivery.status === "open" && nowMs - Date.parse(delivery.created_at) >= RIDER_WAIT_MINUTES * MINUTE) {
      return { kind: "no_rider", since: delivery.created_at };
    }
  }
  return null;
}

/** Most urgent kind first; inside a kind, whoever has waited longest first. Returns a new array. */
export function sortAttention<T extends { kind: AttentionKind; since: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind] || Date.parse(a.since) - Date.parse(b.since)
  );
}

/* --------------------------------------------------------------------- feed */

export type FeedKind = "placed" | "accepted" | "rejected" | "cancelled" | "paid" | "ready" | "rider_assigned" | "delivered";

export interface FeedEvent {
  key: string;
  orderId: string;
  kind: FeedKind;
  at: string;
  riderId: string | null;
}

export const FEED_TONE: Record<FeedKind, Tone> = {
  placed: "blue",
  accepted: "purple",
  rejected: "red",
  cancelled: "red",
  paid: "green",
  ready: "purple",
  rider_assigned: "purple",
  delivered: "green",
};

/** Every timestamped step of an order and its delivery requests. */
export function orderEvents(order: OrderFacts, deliveries: readonly DeliveryFacts[]): FeedEvent[] {
  const events: FeedEvent[] = [];
  const add = (kind: FeedKind, at: string | null | undefined, riderId: string | null = null, suffix = "") => {
    if (at) events.push({ key: `${order.id}:${kind}${suffix}`, orderId: order.id, kind, at, riderId });
  };
  add("placed", order.created_at);
  if (order.order_status === "accepted" || order.order_status === "rejected" || order.order_status === "cancelled") {
    add(order.order_status, order.decided_at);
  }
  add("paid", order.paid_at);
  add("ready", order.ready_at);
  for (const d of deliveries) {
    add("rider_assigned", d.accepted_at, d.rider_id, `:${d.id}`);
    if (d.status === "completed") add("delivered", d.completed_at, d.rider_id, `:${d.id}`);
  }
  return events;
}

/** Newest first, capped. Returns a new array. */
export function latestEvents(events: readonly FeedEvent[], limit: number): FeedEvent[] {
  return [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

/* ---------------------------------------------------------------- customers */

/** Number of orders and the newest order time per customer. */
export function ordersByCustomer(
  orders: readonly { customer_id: string; created_at: string }[]
): Map<string, { count: number; last: string }> {
  const out = new Map<string, { count: number; last: string }>();
  for (const o of orders) {
    const cur = out.get(o.customer_id);
    if (!cur) out.set(o.customer_id, { count: 1, last: o.created_at });
    else {
      cur.count++;
      if (o.created_at > cur.last) cur.last = o.created_at;
    }
  }
  return out;
}
