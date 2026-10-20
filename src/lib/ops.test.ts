import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countStages,
  currentDelivery,
  deliveredSince,
  formatAge,
  formatCountdown,
  formatDuration,
  formatSgd,
  isLiveStage,
  latestEvents,
  orderAttention,
  orderEvents,
  orderStage,
  ordersByCustomer,
  pastOutcome,
  paymentMsLeft,
  ridersOnDelivery,
  sgDayStartIso,
  sortAttention,
  type DeliveryFacts,
  type OrderFacts,
} from "./ops.ts";

const NOW = Date.parse("2026-10-21T04:00:00Z"); // 12:00 in Singapore
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({
  id: "o1",
  customer_id: "c1",
  kitchen_id: "k1",
  order_status: "placed",
  payment_status: "unpaid",
  preparation_status: "not_started",
  subtotal: "12.50",
  created_at: ago(1),
  decided_at: null,
  paid_at: null,
  ready_at: null,
  ...o,
});

const delivery = (d: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  id: "d1",
  order_id: "o1",
  rider_id: null,
  status: "open",
  created_at: ago(1),
  accepted_at: null,
  completed_at: null,
  ...d,
});

test("orderStage follows the order through every step", () => {
  assert.equal(orderStage(order(), null), "awaiting_cook");
  const accepted = order({ order_status: "accepted", decided_at: ago(1) });
  assert.equal(orderStage(accepted, null), "awaiting_payment");
  const paid = { ...accepted, payment_status: "paid", paid_at: ago(0) };
  assert.equal(orderStage(paid, null), "preparing");
  assert.equal(orderStage({ ...paid, preparation_status: "preparing" }, null), "preparing");
  assert.equal(orderStage({ ...paid, preparation_status: "ready" }, null), "awaiting_rider");
  assert.equal(orderStage(paid, delivery()), "awaiting_rider");
  assert.equal(orderStage(paid, delivery({ status: "release_requested" })), "awaiting_rider");
  assert.equal(orderStage(paid, delivery({ status: "accepted", rider_id: "r1" })), "with_rider");
  assert.equal(orderStage(paid, delivery({ status: "completed", rider_id: "r1" })), "delivered");
});

test("orderStage: rejected and cancelled win over everything", () => {
  assert.equal(orderStage(order({ order_status: "rejected" }), null), "rejected");
  assert.equal(orderStage(order({ order_status: "cancelled" }), delivery({ status: "completed" })), "cancelled");
});

test("isLiveStage: finished orders are not live", () => {
  assert.equal(isLiveStage("awaiting_payment"), true);
  assert.equal(isLiveStage("with_rider"), true);
  assert.equal(isLiveStage("delivered"), false);
  assert.equal(isLiveStage("rejected"), false);
  assert.equal(isLiveStage("cancelled"), false);
});

test("pastOutcome names who ended the order", () => {
  assert.equal(pastOutcome("delivered"), "Delivered");
  assert.equal(pastOutcome("rejected"), "Rejected by cook");
  assert.equal(pastOutcome("cancelled"), "Cancelled by customer");
});

test("currentDelivery prefers the most advanced request, ignores cancelled ones", () => {
  const cancelled = delivery({ id: "a", status: "cancelled", created_at: ago(1) });
  const open = delivery({ id: "b", status: "open", created_at: ago(5) });
  const accepted = delivery({ id: "c", status: "accepted", created_at: ago(10) });
  assert.equal(currentDelivery([cancelled]), null);
  assert.equal(currentDelivery([cancelled, open])?.id, "b");
  assert.equal(currentDelivery([open, accepted, cancelled])?.id, "c");
  const newerOpen = delivery({ id: "e", status: "open", created_at: ago(2) });
  assert.equal(currentDelivery([open, newerOpen])?.id, "e");
});

test("paymentMsLeft counts five minutes from the cook's accept", () => {
  assert.equal(paymentMsLeft(null, NOW), null);
  assert.equal(paymentMsLeft(ago(1), NOW), 4 * 60_000);
  assert.equal(paymentMsLeft(ago(5), NOW), 0);
  assert.equal(paymentMsLeft(ago(8), NOW), -3 * 60_000);
});

test("formatCountdown shows m:ss while running and Overdue afterwards", () => {
  assert.equal(formatCountdown(4 * 60_000 + 5_000), "4:05 left");
  assert.equal(formatCountdown(500), "0:01 left");
  assert.equal(formatCountdown(0), "Overdue 0s");
  assert.equal(formatCountdown(-3 * 60_000), "Overdue 3m");
});

test("formatDuration and formatAge", () => {
  assert.equal(formatDuration(40_000), "40s");
  assert.equal(formatDuration(-5_000), "0s");
  assert.equal(formatDuration(12 * 60_000), "12m");
  assert.equal(formatDuration(185 * 60_000), "3h 5m");
  assert.equal(formatDuration(120 * 60_000), "2h");
  assert.equal(formatDuration(52 * 3_600_000), "2d 4h");
  assert.equal(formatAge(ago(12), NOW), "12m");
});

test("sgDayStartIso is midnight in Singapore", () => {
  assert.equal(sgDayStartIso(NOW), "2026-10-20T16:00:00.000Z");
  // 23:30 UTC is already 07:30 the next day in Singapore.
  assert.equal(sgDayStartIso(Date.parse("2026-10-21T23:30:00Z")), "2026-10-21T16:00:00.000Z");
});

test("formatSgd handles numeric strings from Postgres and missing values", () => {
  assert.equal(formatSgd("12.5"), "S$12.50");
  assert.equal(formatSgd(29.9), "S$29.90");
  assert.equal(formatSgd(null), "—");
  assert.equal(formatSgd("abc"), "—");
});

test("countStages counts every stage, zero included", () => {
  const counts = countStages(["awaiting_cook", "awaiting_cook", "with_rider"]);
  assert.equal(counts.awaiting_cook, 2);
  assert.equal(counts.with_rider, 1);
  assert.equal(counts.delivered, 0);
});

test("ridersOnDelivery and deliveredSince", () => {
  const rows = [
    delivery({ id: "1", rider_id: "r1", status: "accepted" }),
    delivery({ id: "2", rider_id: "r2", status: "completed", completed_at: ago(30) }),
    delivery({ id: "3", rider_id: "r2", status: "completed", completed_at: ago(60 * 13) }), // yesterday in SG
    delivery({ id: "4", rider_id: "r1", status: "completed", completed_at: ago(5) }),
    delivery({ id: "5", rider_id: null, status: "open" }),
  ];
  assert.deepEqual([...ridersOnDelivery(rows)], ["r1"]);
  const today = deliveredSince(rows, sgDayStartIso(NOW));
  assert.equal(today.get("r1"), 1);
  assert.equal(today.get("r2"), 1);
});

test("orderAttention flags overdue payment, slow cook, missing and released riders", () => {
  const accepted = order({ order_status: "accepted", decided_at: ago(7) });
  assert.deepEqual(orderAttention(accepted, null, NOW), { kind: "payment_overdue", since: ago(7) });
  assert.equal(orderAttention({ ...accepted, decided_at: ago(2) }, null, NOW), null);

  assert.equal(orderAttention(order({ created_at: ago(6) }), null, NOW)?.kind, "cook_slow");
  assert.equal(orderAttention(order({ created_at: ago(2) }), null, NOW), null);

  const paid = order({ order_status: "accepted", payment_status: "paid", decided_at: ago(30), paid_at: ago(28) });
  assert.equal(orderAttention(paid, delivery({ created_at: ago(11) }), NOW)?.kind, "no_rider");
  assert.equal(orderAttention(paid, delivery({ created_at: ago(3) }), NOW), null);
  assert.equal(orderAttention(paid, delivery({ status: "release_requested", accepted_at: ago(4) }), NOW)?.kind, "rider_released");
  assert.equal(orderAttention(paid, delivery({ status: "accepted", rider_id: "r1" }), NOW), null);
});

test("sortAttention: most urgent kind first, then longest waiting", () => {
  const items = [
    { id: "a", kind: "merchant_application" as const, since: ago(600) },
    { id: "b", kind: "cook_slow" as const, since: ago(6) },
    { id: "c", kind: "payment_overdue" as const, since: ago(6) },
    { id: "d", kind: "cook_slow" as const, since: ago(20) },
    { id: "e", kind: "message_open" as const, since: ago(100) },
  ];
  assert.deepEqual(sortAttention(items).map((i) => i.id), ["c", "d", "b", "e", "a"]);
  assert.equal(items[0].id, "a", "input is not mutated");
});

test("orderEvents + latestEvents build a newest-first feed", () => {
  const o = order({
    order_status: "accepted",
    payment_status: "paid",
    created_at: ago(40),
    decided_at: ago(38),
    paid_at: ago(35),
    ready_at: ago(20),
  });
  const d = delivery({ status: "completed", rider_id: "r1", accepted_at: ago(15), completed_at: ago(5) });
  const feed = latestEvents(orderEvents(o, [d]), 10);
  assert.deepEqual(
    feed.map((e) => e.kind),
    ["delivered", "rider_assigned", "ready", "paid", "accepted", "placed"]
  );
  assert.equal(feed[0].riderId, "r1");
  assert.equal(latestEvents(orderEvents(o, [d]), 2).length, 2);
  assert.deepEqual(orderEvents(order({ created_at: ago(1) }), []).map((e) => e.kind), ["placed"]);
});

test("ordersByCustomer counts orders and keeps the newest", () => {
  const map = ordersByCustomer([
    { customer_id: "c1", created_at: ago(50) },
    { customer_id: "c2", created_at: ago(5) },
    { customer_id: "c1", created_at: ago(10) },
  ]);
  assert.deepEqual(map.get("c1"), { count: 2, last: ago(10) });
  assert.deepEqual(map.get("c2"), { count: 1, last: ago(5) });
});
