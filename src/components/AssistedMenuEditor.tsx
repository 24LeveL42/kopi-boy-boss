"use client";

import { useState } from "react";
import { addAssistedShopItem, setAssistedCategoryPhoto, setAssistedShopItemHidden, updateAssistedShopItem } from "@/lib/actions";
import { assistedPhotoPath } from "@/lib/assisted-onboarding";
import type { MenuItem } from "@/lib/types-kitchen";
import { AssistedBulkPhotos } from "./AssistedBulkPhotos";
import { AssistedMenuImport } from "./AssistedMenuImport";
import { MenuItemsEditor, type MenuEditorActions } from "./MenuItemsEditor";

const DRAFT_ACTIONS: MenuEditorActions = {
  add: addAssistedShopItem,
  update: updateAssistedShopItem,
  setHidden: setAssistedShopItemHidden,
};

/**
 * The draft menu of an assisted shop: the same editor as a live kitchen's
 * menu, saving to assisted_shop_items through the assisted server actions,
 * with photos uploaded to kitchen-photos/assisted/<shopId>/. Items are
 * grouped by their draft category, each with "Set photo for all [Category]
 * items", a CSV import adds many at once, and "Bulk photos" pairs many
 * photos with items in one go. Visible items are copied to
 * the kitchen when the owner claims; hidden ones are not, and the category
 * stays in the draft.
 */
export function AssistedMenuEditor({ shopId, initialItems }: { shopId: string; initialItems: MenuItem[] }) {
  // What the editor starts from (replaced after an import) and what it shows now (for the import's counts).
  const [items, setItems] = useState(initialItems);
  const [current, setCurrent] = useState(initialItems);
  // A new key reloads the editor with the list the import returned.
  const [version, setVersion] = useState(0);
  const reload = (fresh: MenuItem[] | null) => {
    if (!fresh) {
      window.location.reload();
      return;
    }
    setItems(fresh);
    setVersion((v) => v + 1);
  };
  return (
    <div className="space-y-4">
      <AssistedMenuImport
        shopId={shopId}
        items={current}
        onImported={reload}
      />
      <AssistedBulkPhotos shopId={shopId} items={current} onApplied={reload} />
      <MenuItemsEditor
        key={version}
        kitchenId={shopId}
        initialItems={items}
        actions={DRAFT_ACTIONS}
        photoPath={(file, uuid) => assistedPhotoPath(shopId, file, uuid)}
        setCategoryPhoto={setAssistedCategoryPhoto}
        onItemsChange={setCurrent}
        draft
      />
    </div>
  );
}
