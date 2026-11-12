import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_ALERTS,
  MUTE_STORAGE_KEY,
  alertFor,
  applicationAnchor,
  cleanBusinessName,
  createAlertTracker,
  mergeAlerts,
  pendingTotal,
  readMuted,
  titleWithCount,
  writeMuted,
} from "./application-alerts.ts";

test("alert text: merchant shows the business name only, rider shows no name", () => {
  assert.deepEqual(alertFor("merchant", { id: "c1", business_name: "Ah Seng Kopi" }), {
    key: "merchant:c1",
    kind: "merchant",
    title: "New merchant application: Ah Seng Kopi",
    href: "/merchants#application-c1",
  });
  assert.deepEqual(alertFor("rider", { id: "r1" }), {
    key: "rider:r1",
    kind: "rider",
    title: "New rider application",
    href: "/riders#application-r1",
  });
  assert.equal(applicationAnchor("x"), "application-x");
});

test("business names are cleaned and capped for a one-line pop-up", () => {
  assert.equal(cleanBusinessName("  Ah\n Seng\t\u0007Kopi  "), "Ah Seng Kopi");
  assert.equal(cleanBusinessName(""), "(no business name)");
  assert.equal(cleanBusinessName(null), "(no business name)");
  const long = cleanBusinessName("x".repeat(200));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});

test("tracker: first read seeds silently, later reads alert once per new id", () => {
  const t = createAlertTracker();
  assert.deepEqual(t.take("merchant", [{ id: "a", business_name: "A" }]), []);
  assert.deepEqual(t.take("rider", [{ id: "r" }]), []);
  const next = t.take("merchant", [
    { id: "b", business_name: "B" },
    { id: "a", business_name: "A" },
  ]);
  assert.deepEqual(next.map((x) => x.key), ["merchant:b"]);
  assert.deepEqual(t.take("merchant", [{ id: "b", business_name: "B" }]), [], "no repeat");
  assert.deepEqual(t.take("rider", [{ id: "r2" }, { id: "r" }]).map((x) => x.key), ["rider:r2"]);
});

test("tracker: a failed read changes nothing and doesn't count as the seed", () => {
  const t = createAlertTracker();
  assert.deepEqual(t.take("merchant", null), []);
  // First good read after an error is still the silent seed (no flood of old sign-ups).
  assert.deepEqual(t.take("merchant", [{ id: "a", business_name: "A" }, { id: "b", business_name: "B" }]), []);
  assert.deepEqual(t.take("merchant", null), []);
  assert.equal(t.take("merchant", [{ id: "c", business_name: "C" }]).length, 1);
});

test("tracker: merchant and rider ids never collide", () => {
  const t = createAlertTracker();
  t.take("merchant", []);
  t.take("rider", []);
  assert.equal(t.take("merchant", [{ id: "same", business_name: "S" }]).length, 1);
  assert.equal(t.take("rider", [{ id: "same" }]).length, 1);
});

test("mergeAlerts: new on top, no duplicates, capped", () => {
  const a = (id: string) => alertFor("rider", { id });
  const merged = mergeAlerts([a("1"), a("2")], [a("3"), a("1")]);
  assert.deepEqual(merged.map((x) => x.key), ["rider:3", "rider:1", "rider:2"]);
  const many = mergeAlerts([], Array.from({ length: 10 }, (_, i) => a(String(i))));
  assert.equal(many.length, MAX_ALERTS);
  assert.equal(many[0].key, "rider:0");
});

test("pendingTotal: adds what could be read; null only when both failed", () => {
  assert.equal(pendingTotal(2, 3), 5);
  assert.equal(pendingTotal(null, 3), 3);
  assert.equal(pendingTotal(0, 0), 0);
  assert.equal(pendingTotal(null, null), null);
});

test("titleWithCount: prefixes, replaces an old count, and clears at zero", () => {
  const base = "Kopi Boy Operations Centre";
  assert.equal(titleWithCount(base, 2), `(2) ${base}`);
  assert.equal(titleWithCount(`(2) ${base}`, 5), `(5) ${base}`);
  assert.equal(titleWithCount(`(99+) ${base}`, 3), `(3) ${base}`);
  assert.equal(titleWithCount(`(2) ${base}`, 0), base);
  assert.equal(titleWithCount(`(2) ${base}`, null), base);
  assert.equal(titleWithCount(base, 150), `(99+) ${base}`);
  assert.equal(titleWithCount(titleWithCount(base, 4), 4), `(4) ${base}`, "idempotent");
});

test("mute: remembered when storage works", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  assert.equal(readMuted(() => storage), false);
  writeMuted(() => storage, true);
  assert.equal(map.get(MUTE_STORAGE_KEY), "1");
  assert.equal(readMuted(() => storage), true);
  writeMuted(() => storage, false);
  assert.equal(readMuted(() => storage), false);
});

test("mute: missing or throwing storage never throws and reads as not muted", () => {
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceeded");
    },
  };
  assert.equal(readMuted(() => throwing), false);
  assert.doesNotThrow(() => writeMuted(() => throwing, true));
  assert.equal(readMuted(() => null), false);
  assert.doesNotThrow(() => writeMuted(() => undefined, true));
  const getterThrows = () => {
    throw new Error("localStorage blocked");
  };
  assert.equal(readMuted(getterThrows), false);
  assert.doesNotThrow(() => writeMuted(getterThrows, true));
});

test("the alerts component reads no personal details and keeps the 60 s fallback", () => {
  const src = readFileSync(new URL("../components/ApplicationAlerts.tsx", import.meta.url), "utf8");
  const selects = [...src.matchAll(/\.select\("([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(selects, ["id, business_name", "id"]);
  assert.doesNotMatch(src, /phone|address|paynow|uen|email|photo|license|postal/i);
  assert.match(src, /setInterval\(\(\) => void load\(\), ALERT_POLL_MS\)/);
  // A Realtime failure is caught; load() swallows network errors.
  assert.match(src, /channel\.subscribe\(\);\s*\n\s*\} catch \{/);
});
