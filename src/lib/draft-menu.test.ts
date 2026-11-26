import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryGroups, categoryLabel, categoryPhotoButtonLabel, categoryPhotoNotice, categoryPhotoTargets } from "./draft-menu.ts";
import { importNotice } from "./menu-csv.ts";

const item = (id: string, category: string | null, photo: string | null = null, hidden = false) => ({ id, category, photo_url: photo, is_hidden: hidden });

test("groups by category ignoring case and spaces, first spelling wins, file order kept, no category last", () => {
  const groups = categoryGroups([
    item("1", null),
    item("2", "Noodles"),
    item("3", " noodles ", "https://x/a.jpg", true),
    item("4", "Drinks"),
    item("5", "NOODLES"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.category, g.items.map((i) => i.id), g.hiddenCount, g.withoutPhoto]),
    [
      ["Noodles", ["2", "3", "5"], 1, 2],
      ["Drinks", ["4"], 0, 1],
      [null, ["1"], 0, 1],
    ]
  );
  assert.equal(categoryLabel(null), "No category");
});

test("button label, how many would change (hidden included), and the notice", () => {
  assert.equal(categoryPhotoButtonLabel("Noodles"), "Set photo for all Noodles items");
  assert.equal(categoryPhotoButtonLabel(null), "Set photo for all items with no category");
  const group = { items: [item("1", "N"), item("2", "N", "https://x/own.jpg"), item("3", "N", null, true), item("4", "N", "https://x/new.jpg")] };
  assert.equal(categoryPhotoTargets(group, "https://x/new.jpg", false), 2, "only the ones with no photo, the hidden one too");
  assert.equal(categoryPhotoTargets(group, "https://x/new.jpg", true), 3, "replace: all but the one already on it");
  assert.equal(categoryPhotoNotice(3), "Photo set on 3 items.");
  assert.equal(categoryPhotoNotice(1), "Photo set on 1 item.");
  assert.match(categoryPhotoNotice(0), /No items changed/);
});

test("the import notice shows how many were imported, hidden and skipped (or hidden by replace all)", () => {
  assert.equal(
    importNotice({ imported: 4, hidden: 1, skipped: 2, existing_hidden: 0 }, "add"),
    "Imported 4 items · 1 hidden to check with the owner · 2 skipped (already in the draft)."
  );
  assert.equal(importNotice({ imported: 1, hidden: 0, skipped: 0, existing_hidden: 3 }, "replace"), "Imported 1 item · 3 existing items hidden.");
});
