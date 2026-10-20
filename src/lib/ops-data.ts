import type { SupabaseClient } from "@supabase/supabase-js";
import {
  currentDelivery,
  isLiveStage,
  orderStage,
  type DeliveryFacts,
  type OrderFacts,
  type OrderStage,
} from "@/lib/ops";

/**
 * Read-only loaders for the Operations Centre. Every query runs with the
 * signed-in admin's session, so RLS ("Admins can read every …") decides what
 * comes back; nothing here writes. Works with the server and browser clients.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = SupabaseClient<any, any, any>;

/** Long `in (…)` lists go in the URL, so ids are sent in batches. */
const ID_BATCH = 150;

/** How many orders a screen loads at most. */
export const LIVE_ORDER_LIMIT = 500;
export const PAST_ORDER_LIMIT = 300;

export const LIVE_ORDER_STATUSES = ["placed", "accepted"] as const;

export async function selectIn<T>(
  supabase: Client,
  table: string,
  columns: string,
  column: string,
  ids: readonly string[]
): Promise<{ data: T[]; error: string | null }> {
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const { data, error } = await supabase.from(table).select(columns).in(column, unique.slice(i, i + ID_BATCH));
    if (error) return { data: out, error: error.message };
    out.push(...((data ?? []) as T[]));
  }
  return { data: out, error: null };
}

export interface OrderRow {
  order: OrderFacts;
  delivery: DeliveryFacts | null;
  deliveries: DeliveryFacts[];
  stage: OrderStage;
  merchant: string;
  customer: string;
  customerPhone: string | null;
  rider: string | null;
}

type NameRow = { id: string; full_name: string | null; phone: string | null };

/** Names for display: kitchens by id, and any profile (customers, riders) by id. */
export async function loadNames(supabase: Client, kitchenIds: string[], profileIds: string[]) {
  const [kitchens, profiles] = await Promise.all([
    selectIn<{ id: string; business_name: string | null }>(supabase, "kitchens", "id, business_name", "id", kitchenIds),
    selectIn<NameRow>(supabase, "profiles", "id, full_name, phone", "id", profileIds),
  ]);
  return {
    kitchenName: new Map(kitchens.data.map((k) => [k.id, k.business_name])),
    profile: new Map(profiles.data.map((p) => [p.id, p])),
  };
}

type OrderWithDelivery = Pick<OrderRow, "order" | "delivery" | "deliveries" | "stage">;

/**
 * Orders with their delivery requests and stage.
 * "live" = every placed/accepted order (an accepted order whose delivery is
 * completed still comes back here and is filtered out by its stage);
 * "recent" = the newest orders of any status.
 */
async function loadOrdersWithDeliveries(
  supabase: Client,
  scope: "live" | "recent"
): Promise<{ rows: OrderWithDelivery[]; error: string | null }> {
  let query = supabase.from("orders").select("*").order("created_at", { ascending: false });
  query =
    scope === "live"
      ? query.in("order_status", [...LIVE_ORDER_STATUSES]).limit(LIVE_ORDER_LIMIT)
      : query.limit(PAST_ORDER_LIMIT);
  const { data, error } = await query;
  if (error) return { rows: [], error: error.message };
  const orders = (data ?? []) as OrderFacts[];

  const deliveries = await selectIn<DeliveryFacts>(
    supabase,
    "delivery_requests",
    "id, order_id, rider_id, status, created_at, accepted_at, completed_at",
    "order_id",
    orders.map((o) => o.id)
  );
  const byOrder = new Map<string, DeliveryFacts[]>();
  for (const d of deliveries.data) {
    const list = byOrder.get(d.order_id);
    if (list) list.push(d);
    else byOrder.set(d.order_id, [d]);
  }

  const rows = orders.map((order) => {
    const all = byOrder.get(order.id) ?? [];
    const delivery = currentDelivery(all);
    return { order, deliveries: all, delivery, stage: orderStage(order, delivery) };
  });
  return { rows, error: deliveries.error };
}

/** How many orders are live right now (for the sidebar badge); null on error. */
export async function countLiveOrders(supabase: Client): Promise<number | null> {
  const { rows, error } = await loadOrdersWithDeliveries(supabase, "live");
  return error ? null : rows.filter((r) => isLiveStage(r.stage)).length;
}

/** loadOrdersWithDeliveries plus merchant, customer and rider names. */
export async function loadOrderRows(
  supabase: Client,
  scope: "live" | "recent"
): Promise<{ rows: OrderRow[]; error: string | null }> {
  const { rows: withDelivery, error } = await loadOrdersWithDeliveries(supabase, scope);
  const orders = withDelivery.map((r) => r.order);

  const names = await loadNames(
    supabase,
    orders.map((o) => o.kitchen_id),
    [
      ...orders.map((o) => o.customer_id),
      ...withDelivery.flatMap((r) => (r.delivery?.rider_id ? [r.delivery.rider_id] : [])),
    ]
  );

  const rows = withDelivery.map((r): OrderRow => {
    const customer = names.profile.get(r.order.customer_id);
    const riderId = r.delivery?.rider_id;
    return {
      ...r,
      merchant: names.kitchenName.get(r.order.kitchen_id) || `Kitchen ${r.order.kitchen_id.slice(0, 8)}`,
      customer: customer?.full_name || `Customer ${r.order.customer_id.slice(0, 8)}`,
      customerPhone: customer?.phone ?? null,
      rider: riderId ? names.profile.get(riderId)?.full_name || `Rider ${riderId.slice(0, 8)}` : null,
    };
  });

  return { rows, error };
}

/** Rows in `table` where `column` = `value`; null when the count fails (RLS, missing table). */
export async function countWhere(supabase: Client, table: string, column: string, value: string): Promise<number | null> {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).eq(column, value);
  return error ? null : count;
}

/** The time a server page renders at; passed down so ticking client clocks start from the same instant. */
export function renderTime(): number {
  return Date.now();
}
