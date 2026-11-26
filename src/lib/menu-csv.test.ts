import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCategory, itemKey, parseCsv, planImport, previewCsv, replaceConfirmation } from "./menu-csv.ts";

// --- Parser ---

test("parser: a leading BOM (Excel) is dropped, CRLF and LF both end a row", () => {
  assert.deepEqual(parseCsv("﻿name,price\r\nKopi,1.50\nTeh,1.60"), [
    ["name", "price"],
    ["Kopi", "1.50"],
    ["Teh", "1.60"],
  ]);
  assert.deepEqual(previewCsv("﻿name,price\r\nKopi,1.50\r\n").rows.map((r) => r.name), ["Kopi"]);
});

test("parser: quoted fields with commas, doubled quotes and line breaks", () => {
  assert.deepEqual(parseCsv('name,price\n"Chicken rice, large",5.50\n"The ""special""",6\n"Two\nlines",7'), [
    ["name", "price"],
    ["Chicken rice, large", "5.50"],
    ['The "special"', "6"],
    ["Two\nlines", "7"],
  ]);
  assert.deepEqual(parseCsv('a,"",c'), [["a", "", "c"]], "an empty quoted field");
});

test("parser: an unclosed quote is an error, not a silent merge", () => {
  assert.throws(() => parseCsv('name,price\n"Kopi,1.50'), /never closed/);
  const p = previewCsv('name,price\n"Kopi,1.50');
  assert.equal(p.rows.length, 0);
  assert.match(p.errors[0].message, /never closed/);
});

// --- Header ---

test("header: any order, any case, unknown columns ignored and listed; name and price required", () => {
  const p = previewCsv("Price, NAME ,Spice level,Category,Check With Owner\n4.50,Laksa,hot,Noodles,\n");
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.unknownColumns, ["Spice level"]);
  assert.deepEqual(p.rows, [{ row: 2, category: "Noodles", name: "Laksa", price: 4.5, hidden: false, note: null }]);

  assert.match(previewCsv("category,name\nA,B").errors[0].message, /no "price" column/);
  assert.match(previewCsv("category,price\nA,1").errors[0].message, /no "name" column/);
  assert.match(previewCsv("name,price,name\nA,1,B").errors[0].message, /appears twice/);
  assert.match(previewCsv("").errors[0].message, /empty/);
  assert.match(previewCsv("name,price\n\n").errors[0].message, /no items/);
});

test("category and check_with_owner are optional columns", () => {
  const p = previewCsv("name,price\nKopi,1.5");
  assert.deepEqual(p.rows, [{ row: 2, category: null, name: "Kopi", price: 1.5, hidden: false, note: null }]);
});

// --- Row checks ---

test("bad prices are errors with their row number; good ones are stored like the editor stores them", () => {
  const p = previewCsv(
    ["name,price", "A,abc", "B,0", "C,-1", "D,4.555", "E,", "F,1e3", "G,10000", "H,$4.50", "I,.5", "J, 3 ", "K,4.5.0", "L,1,5"].join("\n")
  );
  const byRow = new Map(p.errors.map((e) => [e.row, e.message]));
  for (const row of [2, 3, 4, 5, 6, 7, 8, 12]) assert.ok(byRow.has(row), `row ${row} should be an error`);
  assert.match(byRow.get(2)!, /"abc" isn't a valid price/);
  assert.match(byRow.get(3)!, /more than \$0/);
  assert.match(byRow.get(5)!, /at most 2 decimals/);
  assert.match(byRow.get(6)!, /price is empty/);
  assert.match(byRow.get(8)!, /at most \$9999\.99/);
  assert.deepEqual(
    p.rows.map((r) => [r.name, r.price]),
    [
      ["H", 4.5],
      ["I", 0.5],
      ["J", 3],
      ["L", 1],
    ],
    "the extra column on row 13 (1,5) is just ignored"
  );
});

test("empty name, name too long and category too long are errors with row numbers", () => {
  const p = previewCsv(`category,name,price\nA,,1\nA,${"n".repeat(81)},1\n${"c".repeat(61)},Kopi,1\n${"c".repeat(60)},${"n".repeat(80)},1`);
  assert.deepEqual(
    p.errors.map((e) => [e.row, e.message]),
    [
      [2, "The name is empty."],
      [3, "The name is longer than 80 characters."],
      [4, "The category is longer than 60 characters."],
    ]
  );
  assert.equal(p.rows.length, 1, "exactly 80 and 60 are fine");
});

test("duplicates in the file: same name and category, ignoring case and extra spaces; another category is fine", () => {
  const p = previewCsv("category,name,price\nNoodles,Laksa,6\n noodles ,  LAKSA ,6.5\nSpecials,Laksa,7\n,Water,1\n,water,1");
  assert.deepEqual(
    p.errors.map((e) => [e.row, e.message]),
    [
      [3, '"LAKSA" is already in "noodles" on row 2.'],
      [6, '"water" is already in the items with no category on row 5.'],
    ]
  );
  assert.deepEqual(p.rows.map((r) => `${r.category}/${r.name}`), ["Noodles/Laksa", "Specials/Laksa", "null/Water"]);
});

test("at most 200 rows; blank lines don't count but keep their row numbers", () => {
  const rows = (n: number) => ["name,price", ...Array.from({ length: n }, (_, i) => `Item ${i},1`)].join("\n");
  assert.equal(previewCsv(rows(200)).total, 200);
  const over = previewCsv(rows(201));
  assert.equal(over.rows.length, 0);
  assert.match(over.errors[0].message, /201 items; the most is 200/);
  const gap = previewCsv("name,price\n\nKopi,abc");
  assert.equal(gap.errors[0].row, 3, "header row 1, blank row 2, Kopi on row 3");
});

// --- Hidden by note ---

test("a filled check_with_owner imports the row hidden and keeps the note for the preview; blank or spaces = visible", () => {
  const p = previewCsv('name,price,check_with_owner\nKopi,1.5,"Ask if he still sells this"\nTeh,1.6,   \nMilo,2,');
  assert.deepEqual(
    p.rows.map((r) => [r.name, r.hidden, r.note]),
    [
      ["Kopi", true, "Ask if he still sells this"],
      ["Teh", false, null],
      ["Milo", false, null],
    ]
  );
  assert.equal(p.hidden, 1);
  const long = previewCsv(`name,price,check_with_owner\nKopi,1.5,${"n".repeat(201)}\nTeh,1.6,${"n".repeat(200)}`);
  assert.deepEqual(long.errors.map((e) => [e.row, e.message]), [[2, "The check_with_owner note is longer than 200 characters."]]);
  assert.equal(long.rows[0].note?.length, 200);
});

// --- Preview numbers ---

test("preview: grouped by category in file order, total, count per category, cheapest and dearest", () => {
  const p = previewCsv(
    "category,name,price,check_with_owner\nBreakfast,Kaya Toast,2.20,\nDrinks,Kopi,1.50,\nbreakfast,Eggs,1.60,check price\n,Water,0.50,\nDrinks,Milo Dinosaur,4.80,"
  );
  assert.equal(p.total, 5);
  assert.equal(p.hidden, 1);
  assert.equal(p.cheapest, 0.5);
  assert.equal(p.dearest, 4.8);
  assert.deepEqual(
    p.categories.map((c) => [c.category, c.count, c.items.map((i) => i.name)]),
    [
      ["Breakfast", 2, ["Kaya Toast", "Eggs"]],
      ["Drinks", 2, ["Kopi", "Milo Dinosaur"]],
      [null, 1, ["Water"]],
    ]
  );
  const bad = previewCsv("name,price\nA,abc");
  assert.equal(bad.cheapest, null);
  assert.equal(bad.total, 0);
});

// --- What an import would do ---

const existing = [
  { name: "Kaya Toast", category: "Breakfast", is_hidden: false },
  { name: "Teh Tarik", category: "Drinks", is_hidden: true },
  { name: "Water", category: null, is_hidden: false },
];

test("skip duplicates (default): rows already in the draft, visible or hidden, are skipped and counted", () => {
  const p = previewCsv("category,name,price,check_with_owner\nbreakfast,kaya  toast,2.5,\nDRINKS,Teh Tarik,1.8,\n,water,1,\nRice,Nasi Lemak,4,ask\nDrinks,Kaya Toast,3,");
  assert.deepEqual(planImport(p, existing, "add"), { toImport: 2, skipped: 3, existingHidden: 0, hidden: 1 });
});

test("replace all: every visible draft item will be hidden, the whole file is added", () => {
  const p = previewCsv("name,price\nKaya Toast,2.5\nNew,1");
  assert.deepEqual(planImport(p, existing, "replace"), { toImport: 2, skipped: 0, existingHidden: 2, hidden: 0 });
  assert.match(replaceConfirmation(2), /^2 existing items will be hidden\./);
  assert.match(replaceConfirmation(1), /^1 existing item will be hidden\./);
});

test("categories and keys: trimmed, inner spaces collapsed, case ignored for matching only", () => {
  assert.equal(cleanCategory("  Hot   Drinks "), "Hot Drinks");
  assert.equal(cleanCategory("   "), null);
  assert.equal(itemKey(" Teh  Tarik ", " hot drinks"), itemKey("teh tarik", "HOT   DRINKS"));
  assert.notEqual(itemKey("Teh", "Drinks"), itemKey("Teh", null));
});
