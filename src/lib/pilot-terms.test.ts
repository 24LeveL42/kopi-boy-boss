import { test } from "node:test";
import assert from "node:assert/strict";
import { billingStateFrom } from "./pilot-terms.ts";

test("billing state: only an explicit false is OFF", () => {
  assert.deepEqual(billingStateFrom({ billing_enabled: false }, null), { kind: "off" });
  assert.deepEqual(billingStateFrom({ billing_enabled: true }, null), { kind: "on" });
});

test("billing state: a failed read, no row, or no column is an error, never shown as off", () => {
  assert.deepEqual(billingStateFrom(null, { message: "column billing_settings.billing_enabled does not exist" }), {
    kind: "error",
    message: "column billing_settings.billing_enabled does not exist",
  });
  assert.equal(billingStateFrom(null, null).kind, "error");
  assert.equal(billingStateFrom({}, null).kind, "error");
  assert.equal(billingStateFrom({ billing_enabled: null }, null).kind, "error");
});
