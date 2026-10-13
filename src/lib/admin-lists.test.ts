import { test } from "node:test";
import assert from "node:assert/strict";
import { compareNames, countLabel, matchesSearch, sortActiveThenBlocked } from "./admin-lists.ts";

type Row = { name: string | null; active: boolean };
const sort = (rows: Row[]) => sortActiveThenBlocked(rows, (r) => r.name, (r) => r.active).map((r) => r.name);

test("compareNames is case-insensitive A–Z", () => {
  const names = ["banana", "Apple", "cherry", "apricot", "Banana Leaf"];
  assert.deepEqual([...names].sort(compareNames), ["Apple", "apricot", "banana", "Banana Leaf", "cherry"]);
});

test("compareNames puts blank and missing names last", () => {
  assert.deepEqual([null, "zed", "  ", "Amy", undefined].sort(compareNames).slice(0, 2), ["Amy", "zed"]);
});

test("sortActiveThenBlocked: active first, blocked after, alphabetical inside each group", () => {
  const rows: Row[] = [
    { name: "zara", active: true },
    { name: "Ben", active: false },
    { name: "alan", active: false },
    { name: "Mei", active: true },
    { name: null, active: true },
    { name: "ahmad", active: true },
  ];
  assert.deepEqual(sort(rows), ["ahmad", "Mei", "zara", null, "alan", "Ben"]);
});

test("sortActiveThenBlocked does not mutate its input", () => {
  const rows: Row[] = [{ name: "b", active: true }, { name: "a", active: true }];
  sort(rows);
  assert.deepEqual(rows.map((r) => r.name), ["b", "a"]);
});

test("matchesSearch: empty query matches everything", () => {
  assert.equal(matchesSearch("", ["Tan"]), true);
  assert.equal(matchesSearch("   ", [null]), true);
});

test("matchesSearch: name, email or phone, ignoring case", () => {
  const fields = ["Ah Hock Hawker", "Tan Ah Hock", "+65 9123 4567", "AHHOCK@example.com"];
  assert.equal(matchesSearch("hawker", fields), true);
  assert.equal(matchesSearch("TAN", fields), true);
  assert.equal(matchesSearch("ahhock@", fields), true);
  assert.equal(matchesSearch("9123", fields), true);
  assert.equal(matchesSearch("bakery", fields), false);
});

test("matchesSearch: phone numbers match with or without spaces", () => {
  assert.equal(matchesSearch("91234567", ["9123 4567"]), true);
  assert.equal(matchesSearch("9123 4567", ["91234567"]), true);
});

test("matchesSearch: every word must match somewhere", () => {
  const fields = ["Mei Ling", "mei@example.com"];
  assert.equal(matchesSearch("ling mei", fields), true);
  assert.equal(matchesSearch("mei bakery", fields), false);
});

test("matchesSearch skips null and undefined fields", () => {
  assert.equal(matchesSearch("tan", [null, undefined, "Tan"]), true);
  assert.equal(matchesSearch("tan", [null, undefined]), false);
});

test("countLabel shows 'x of y' only while searching", () => {
  assert.equal(countLabel(12, 40, true), "12 of 40");
  assert.equal(countLabel(40, 40, false), "40");
});
