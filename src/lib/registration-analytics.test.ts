import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFunnel,
  errorsByField,
  formatPct,
  normalizeReport,
  pct,
  rates,
  resolveRange,
  sgDay,
  signinRows,
  type RegistrationReport,
} from "./registration-analytics.ts";

const empty = (): RegistrationReport => ({
  from: "",
  to: "",
  generated_at: "",
  tracking_since: null,
  sessions: 0,
  test_sessions_excluded: 0,
  events: {},
  fields: [],
  validation_errors: [],
  signin_errors: [],
  abandon_last_field: [],
  started: 0,
  submitted: 0,
  abandoned: 0,
  in_progress: 0,
});

// 18 Nov 2026 10:00 SGT.
const NOW = Date.parse("2026-11-18T02:00:00Z");

test("pct: one decimal, and null (not 0%) when there is no base", () => {
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(2, 2), 100);
  assert.equal(pct(0, 5), 0);
  assert.equal(pct(3, 0), null);
  assert.equal(formatPct(null), "—");
  assert.equal(formatPct(33.3), "33.3%");
});

test("sgDay uses Singapore time", () => {
  assert.equal(sgDay(Date.parse("2026-11-17T15:59:59Z")), "2026-11-17");
  assert.equal(sgDay(Date.parse("2026-11-17T16:00:00Z")), "2026-11-18");
});

test("resolveRange: presets are whole SGT days ending today", () => {
  const today = resolveRange({ range: "today" }, NOW);
  assert.equal(today.fromIso, "2026-11-17T16:00:00.000Z");
  assert.equal(today.toIso, "2026-11-18T16:00:00.000Z");
  assert.equal(today.fromDay, "2026-11-18");

  const week = resolveRange({ range: "7d" }, NOW);
  assert.equal(week.fromIso, "2026-11-11T16:00:00.000Z");
  assert.equal(week.toIso, "2026-11-18T16:00:00.000Z");
  assert.equal(week.fromDay, "2026-11-12");
  assert.equal(week.toDay, "2026-11-18");

  const month = resolveRange({ range: "30d" }, NOW);
  assert.equal(month.fromDay, "2026-10-20");
  assert.equal(month.label, "Last 30 days");
});

test("resolveRange: defaults to 7 days", () => {
  assert.equal(resolveRange({}, NOW).preset, "7d");
  assert.equal(resolveRange({ range: "nonsense" }, NOW).preset, "7d");
  assert.equal(resolveRange({ range: ["today", "30d"] }, NOW).preset, "today");
});

test("resolveRange: custom days are inclusive SGT days", () => {
  const r = resolveRange({ range: "custom", from: "2026-11-01", to: "2026-11-03" }, NOW);
  assert.equal(r.preset, "custom");
  assert.equal(r.fromIso, "2026-10-31T16:00:00.000Z");
  assert.equal(r.toIso, "2026-11-03T16:00:00.000Z");
  assert.equal(r.error, undefined);
  const one = resolveRange({ range: "custom", from: "2026-11-05", to: "2026-11-05" }, NOW);
  assert.equal(one.toIso, "2026-11-05T16:00:00.000Z");
});

test("resolveRange: an unusable custom range falls back to 7 days and says why", () => {
  for (const [from, to, why] of [
    ["", "2026-11-03", /both a start and an end/],
    ["2026-02-30", "2026-03-01", /both a start and an end/],
    ["2026-11-05", "2026-11-01", /on or before/],
    ["2025-01-01", "2026-11-01", /at most 400 days/],
    ["2026-11-01'; drop", "2026-11-02", /both a start and an end/],
  ] as const) {
    const r = resolveRange({ range: "custom", from, to }, NOW);
    assert.equal(r.preset, "7d", `${from}..${to}`);
    assert.match(r.error ?? "", why);
  }
});

test("buildFunnel: form order, drop-off against the previous stage, counts kept", () => {
  const r = empty();
  r.events = { cook_form_view: 10, form_start: 8, submit_attempt: 3, submit_success: 2 };
  r.fields = [
    { field: "full_name", step: 1, sessions: 8 },
    { field: "contact_number", step: 2, sessions: 6 },
    { field: "business_name", step: 3, sessions: 5 },
    { field: "business_type", step: 4, sessions: 5 },
    { field: "business_uen", step: 5, sessions: 1 },
    { field: "business_address", step: 6, sessions: 4 },
  ];
  const f = buildFunnel(r);
  assert.deepEqual(
    f.map((s) => s.key),
    [
      "cook_form_view",
      "form_start",
      "field:full_name",
      "field:contact_number",
      "field:business_name",
      "field:business_type",
      "field:business_uen",
      "field:business_address",
      "field:postal_code",
      "field:paynow_mobile",
      "field:paynow_uen",
      "field:privacy_ack",
      "submit_attempt",
      "submit_success",
    ]
  );
  assert.equal(f[0].lost, null);
  assert.equal(f[0].ofStartPct, 100);
  assert.equal(f[1].lost, 2);
  assert.equal(f[1].dropPct, 20);
  assert.equal(f[3].lost, 2);
  assert.equal(f[3].dropPct, 25);

  // Business UEN: conditional, no drop-off; address is measured against business type, not UEN.
  const uen = f.find((s) => s.key === "field:business_uen")!;
  assert.equal(uen.conditional, true);
  assert.equal(uen.lost, null);
  assert.match(uen.note ?? "", /registered businesses/);
  const address = f.find((s) => s.key === "field:business_address")!;
  assert.equal(address.baseLabel, "Business type");
  assert.equal(address.baseSessions, 5);
  assert.equal(address.lost, 1);
  assert.equal(address.dropPct, 20);

  // A field nobody reached is 0 (not missing), and the next step measures against it.
  const postal = f.find((s) => s.key === "field:postal_code")!;
  assert.equal(postal.sessions, 0);
  assert.equal(postal.lost, 4);
  const attempt = f.find((s) => s.key === "submit_attempt")!;
  assert.equal(attempt.baseSessions, 0);
  assert.equal(attempt.lost, null);
  assert.match(attempt.note ?? "", /More sessions than the step before/);
});

test("buildFunnel: nothing yet gives zeros and no percentages", () => {
  const f = buildFunnel(empty());
  assert.ok(f.every((s) => s.sessions === 0));
  assert.ok(f.every((s) => s.ofStartPct === null && s.dropPct === null));
});

test("rates: conversion, completion and abandonment with their counts", () => {
  const r = empty();
  r.events = { cook_form_view: 4 };
  r.started = 3;
  r.submitted = 1;
  r.abandoned = 1;
  r.in_progress = 1;
  const x = rates(r);
  assert.deepEqual(x.conversion, { value: 25, n: 1, base: 4 });
  assert.deepEqual(x.completion, { value: 33.3, n: 1, base: 3 });
  assert.deepEqual(x.abandonment, { value: 33.3, n: 1, base: 3 });
  assert.equal(rates(empty()).conversion.value, null);
});

test("signinRows reads the counts, 0 when absent", () => {
  const r = empty();
  r.events = { signin_view: 5, in_app_browser: 2 };
  const rows = signinRows(r);
  assert.equal(rows.find((x) => x.key === "signin_view")!.sessions, 5);
  assert.equal(rows.find((x) => x.key === "in_app_browser")!.sessions, 2);
  assert.equal(rows.find((x) => x.key === "signin_click")!.sessions, 0);
});

test("errorsByField: grouped in form order, field total never over-counts", () => {
  const r = empty();
  r.validation_errors = [
    { field: "postal_code", code: "invalid_postal_code", sessions: 2 },
    { field: "full_name", code: "required", sessions: 1 },
    { field: "postal_code", code: "required", sessions: 1 },
  ];
  const g = errorsByField(r);
  assert.deepEqual(
    g.map((x) => [x.field, x.atLeast]),
    [
      ["full_name", 1],
      ["postal_code", 2],
    ]
  );
  assert.deepEqual(
    g[1].codes.map((c) => c.code),
    ["invalid_postal_code", "required"]
  );
  assert.equal(g[1].codes[0].label, "Invalid postal code");
});

test("normalizeReport: fills gaps with 0 / empty and rejects non-objects", () => {
  assert.equal(normalizeReport(null), null);
  assert.equal(normalizeReport("x"), null);
  const r = normalizeReport({ sessions: 3, events: { form_start: "2" }, fields: [{ field: "full_name", step: 1, sessions: 2 }] })!;
  assert.equal(r.sessions, 3);
  assert.equal(r.events.form_start, 2);
  assert.equal(r.started, 0);
  assert.deepEqual(r.validation_errors, []);
  assert.equal(r.tracking_since, null);
  assert.deepEqual(r.fields, [{ field: "full_name", step: 1, sessions: 2 }]);
});
