import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  kitchenLoadProblem,
  MERCHANT_EDIT_KITCHEN_COLUMNS,
  MERCHANT_LIST_KITCHEN_COLUMNS,
} from "./kitchen-columns.ts";

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const LIST_PAGE = src("../app/merchants/page.tsx");
const EDIT_PAGE = src("../app/merchants/[id]/edit/page.tsx");
const EDIT_FORM = src("../components/MerchantEditForm.tsx");

const PRIVATE = ["paynow_type", "paynow_value", "latitude", "longitude", "acknowledged_terms_at"];
const cols = (list: string) => list.split(",").map((c) => c.trim());

// --- The edit page never shows the form for a kitchen that didn't load ---

test("kitchenLoadProblem blocks the form when the query errors", () => {
  const problem = kitchenLoadProblem({ data: null, error: { message: "permission denied for table kitchens" } });
  assert.match(problem ?? "", /permission denied for table kitchens/);
});

test("kitchenLoadProblem blocks the form when the error comes with data", () => {
  assert.notEqual(kitchenLoadProblem({ data: { id: "k1" }, error: { message: "boom" } }), null);
});

test("kitchenLoadProblem blocks the form when there is no kitchen row", () => {
  assert.notEqual(kitchenLoadProblem({ data: null, error: null }), null);
});

test("kitchenLoadProblem allows the form only for a loaded kitchen", () => {
  assert.equal(kitchenLoadProblem({ data: { id: "k1" }, error: null }), null);
});

test("edit page returns the error screen before it can reach MerchantEditForm", () => {
  const gate = EDIT_PAGE.indexOf("if (problem || !kitchen)");
  const form = EDIT_PAGE.indexOf("<MerchantEditForm");
  assert.ok(gate > 0, "edit page must check kitchenLoadProblem");
  assert.ok(gate < form, "the check must come before the form is rendered");
  assert.match(EDIT_PAGE.slice(gate, form), /return \(/, "the check must return early");
  assert.doesNotMatch(EDIT_PAGE, /existingKitchen=\{kitchen \?\? null\}/, "no null-kitchen fallback into the form");
});

// --- No select("*") on kitchens, and no private columns ---

test("neither merchants page selects * on kitchens", () => {
  for (const page of [LIST_PAGE, EDIT_PAGE]) {
    assert.doesNotMatch(page, /from\("kitchens"\)\s*\.select\(\s*(["'`]\s*\*\s*["'`])?\s*\)/);
  }
  assert.match(LIST_PAGE, /from\("kitchens"\)\.select\(MERCHANT_LIST_KITCHEN_COLUMNS\)/);
  assert.match(EDIT_PAGE, /from\("kitchens"\)\.select\(MERCHANT_EDIT_KITCHEN_COLUMNS\)/);
});

test("the column lists are exact, with no * and no private column", () => {
  assert.deepEqual(cols(MERCHANT_LIST_KITCHEN_COLUMNS), ["id", "business_name", "category", "cuisine_type", "is_live"]);
  assert.deepEqual(cols(MERCHANT_EDIT_KITCHEN_COLUMNS), [
    "id", "business_name", "category", "cuisine_type", "neighbourhood", "description", "hero_image", "is_live",
  ]);
  for (const list of [MERCHANT_LIST_KITCHEN_COLUMNS, MERCHANT_EDIT_KITCHEN_COLUMNS]) {
    assert.ok(!list.includes("*"));
    for (const c of PRIVATE) assert.ok(!cols(list).includes(c), `${c} must not be selected`);
  }
});

test("the edit query fetches every kitchen field MerchantEditForm reads", () => {
  const used = [...EDIT_FORM.matchAll(/existingKitchen\?\.(\w+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const field of used) assert.ok(cols(MERCHANT_EDIT_KITCHEN_COLUMNS).includes(field), `missing ${field}`);
});
