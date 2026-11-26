/**
 * Grouping a draft menu by category (assisted onboarding). Pure, so the
 * editor and the tests share it. Categories match ignoring case and extra
 * spaces, like the database (admin_set_assisted_category_photo); a group is
 * shown with the spelling of its first item. Items with no category come last.
 */
import { cleanCategory } from "./menu-csv.ts";

type Item = { id: string; category?: string | null; is_hidden: boolean; photo_url: string | null };

export type CategoryGroup<T extends Item = Item> = {
  /** Stable key: the lowercased category, "" for no category. */
  key: string;
  category: string | null;
  items: T[];
  hiddenCount: number;
  /** Items with no photo yet: what the category photo sets by default. */
  withoutPhoto: number;
};

export function categoryGroups<T extends Item>(items: T[]): CategoryGroup<T>[] {
  const groups = new Map<string, CategoryGroup<T>>();
  for (const item of items) {
    const category = cleanCategory(item.category);
    const key = (category ?? "").toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { key, category, items: [], hiddenCount: 0, withoutPhoto: 0 };
      groups.set(key, group);
    }
    group.items.push(item);
    if (item.is_hidden) group.hiddenCount++;
    if (!item.photo_url) group.withoutPhoto++;
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.category !== null), ...all.filter((g) => g.category === null)];
}

export function categoryLabel(category: string | null): string {
  return category ?? "No category";
}

/** The button text: "Set photo for all Noodles items". */
export function categoryPhotoButtonLabel(category: string | null): string {
  return category ? `Set photo for all ${category} items` : "Set photo for all items with no category";
}

/** How many items a category photo would change (hidden ones included). */
export function categoryPhotoTargets(group: Pick<CategoryGroup, "items">, photoUrl: string, replaceExisting: boolean): number {
  return group.items.filter((i) => (replaceExisting || !i.photo_url) && i.photo_url !== photoUrl).length;
}

/** What the admin sees after applying. */
export function categoryPhotoNotice(updated: number): string {
  return updated === 0 ? "No items changed: they all have a photo already." : `Photo set on ${updated} item${updated === 1 ? "" : "s"}.`;
}
