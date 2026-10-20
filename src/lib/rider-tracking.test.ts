import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLocationChange,
  dotState,
  formatAccuracy,
  isShown,
  orderRoute,
  timeAgo,
  toLatLng,
  visibleRiders,
  type LiveLocation,
} from "./rider-tracking.ts";

const NOW = Date.parse("2026-10-21T04:00:00Z");
const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

const loc = (l: Partial<LiveLocation> = {}): LiveLocation => ({
  rider_id: "r1",
  lat: 1.3826189,
  lng: 103.900632,
  accuracy_m: "6.56",
  heading: 90,
  speed_mps: null,
  delivery_request_id: null,
  updated_at: secondsAgo(10),
  ...l,
});

test("dotState: purple on a delivery, blue with no job, grey after 2 minutes", () => {
  assert.equal(dotState(loc({ delivery_request_id: "d1" }), NOW), "delivery");
  assert.equal(dotState(loc(), NOW), "idle");
  assert.equal(dotState(loc({ delivery_request_id: "d1", updated_at: secondsAgo(120) }), NOW), "delivery");
  assert.equal(dotState(loc({ delivery_request_id: "d1", updated_at: secondsAgo(121) }), NOW), "stale");
  assert.equal(dotState(loc({ updated_at: "not a date" }), NOW), "stale");
});

test("the 15-minute rule hides riders silent for longer", () => {
  assert.equal(isShown(loc({ updated_at: secondsAgo(15 * 60) }), NOW), true);
  assert.equal(isShown(loc({ updated_at: secondsAgo(15 * 60 + 1) }), NOW), false);
  assert.equal(isShown(loc({ updated_at: "garbage" }), NOW), false);
});

test("visibleRiders drops hidden and positionless riders, newest first", () => {
  const rows = [
    loc({ rider_id: "old", updated_at: secondsAgo(16 * 60) }),
    loc({ rider_id: "a", updated_at: secondsAgo(90) }),
    loc({ rider_id: "b", updated_at: secondsAgo(5) }),
    loc({ rider_id: "nopos", lat: null as unknown as number }),
  ];
  assert.deepEqual(visibleRiders(rows, NOW).map((r) => r.rider_id), ["b", "a"]);
});

test("timeAgo reads naturally", () => {
  assert.equal(timeAgo(secondsAgo(0), NOW), "just now");
  assert.equal(timeAgo(secondsAgo(1), NOW), "1 second ago");
  assert.equal(timeAgo(secondsAgo(12), NOW), "12 seconds ago");
  assert.equal(timeAgo(secondsAgo(60), NOW), "1 minute ago");
  assert.equal(timeAgo(secondsAgo(185), NOW), "3 minutes ago");
  assert.equal(timeAgo(secondsAgo(2 * 3600), NOW), "2 hours ago");
  assert.equal(timeAgo(secondsAgo(4 * 86400), NOW), "4 days ago");
  assert.equal(timeAgo(new Date(NOW + 5000).toISOString(), NOW), "just now");
  assert.equal(timeAgo("nope", NOW), "unknown");
});

test("formatAccuracy rounds metres and handles missing values", () => {
  assert.equal(formatAccuracy("6.56"), "±7 m");
  assert.equal(formatAccuracy(12), "±12 m");
  assert.equal(formatAccuracy(null), "Unknown");
  assert.equal(formatAccuracy("x"), "Unknown");
});

test("toLatLng accepts numeric strings and rejects junk and 0,0", () => {
  assert.deepEqual(toLatLng("1.38", "103.9"), [1.38, 103.9]);
  assert.equal(toLatLng(null, 103), null);
  assert.equal(toLatLng("", ""), null);
  assert.equal(toLatLng(0, 0), null);
  assert.equal(toLatLng(91, 103), null);
  assert.equal(toLatLng("a", "b"), null);
});

test("orderRoute sorts by recorded_at, then id, and drops unusable points", () => {
  const p = (id: number, s: number, lat: number | null = 1.38) => ({
    id,
    lat: lat as number,
    lng: 103.9,
    accuracy_m: null,
    recorded_at: secondsAgo(s),
  });
  const route = orderRoute([p(3, 10), p(1, 30), p(5, 10), p(2, 20), p(9, 15, null)]);
  assert.deepEqual(route.map((r) => r.id), [1, 2, 3, 5]);
  assert.deepEqual(orderRoute([]), []);
});

test("applyLocationChange upserts by rider and removes on delete", () => {
  const start = [loc({ rider_id: "a" }), loc({ rider_id: "b" })];
  const updated = applyLocationChange(start, { eventType: "UPDATE", row: loc({ rider_id: "a", lat: 1.4 }) });
  assert.equal(updated.length, 2);
  assert.equal(updated.find((l) => l.rider_id === "a")?.lat, 1.4);
  assert.equal(applyLocationChange(start, { eventType: "INSERT", row: loc({ rider_id: "c" }) }).length, 3);
  assert.deepEqual(applyLocationChange(start, { eventType: "DELETE", row: { rider_id: "a" } }).map((l) => l.rider_id), ["b"]);
  assert.equal(applyLocationChange(start, { eventType: "DELETE", row: {} }).length, 2);
});
