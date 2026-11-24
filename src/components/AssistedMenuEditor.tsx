"use client";

import { addAssistedShopItem, setAssistedShopItemHidden, updateAssistedShopItem } from "@/lib/actions";
import { assistedPhotoPath } from "@/lib/assisted-onboarding";
import type { MenuItem } from "@/lib/types-kitchen";
import { MenuItemsEditor, type MenuEditorActions } from "./MenuItemsEditor";

const DRAFT_ACTIONS: MenuEditorActions = {
  add: addAssistedShopItem,
  update: updateAssistedShopItem,
  setHidden: setAssistedShopItemHidden,
};

/**
 * The draft menu of an assisted shop: the same editor as a live kitchen's
 * menu, saving to assisted_shop_items through the assisted server actions,
 * with photos uploaded to kitchen-photos/assisted/<shopId>/. Visible items
 * are copied to the kitchen when the owner claims; hidden ones are not.
 */
export function AssistedMenuEditor({ shopId, initialItems }: { shopId: string; initialItems: MenuItem[] }) {
  return (
    <MenuItemsEditor
      kitchenId={shopId}
      initialItems={initialItems}
      actions={DRAFT_ACTIONS}
      photoPath={(file, uuid) => assistedPhotoPath(shopId, file, uuid)}
      draft
    />
  );
}
