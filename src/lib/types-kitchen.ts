/**
 * Mirrors kopi-boy-partner-v2's src/lib/types-kitchen.ts: the same
 * `kitchens` / `menu_items` tables. Boss reads only the public columns
 * listed in kitchen-columns.ts and writes only through kitchen-admin.ts.
 * Private columns (PayNow, exact location, terms acknowledgement, opening
 * hours) are deliberately not here: signed-in users can't read them.
 */

export type MerchantCategory = "home-cook" | "hawker" | "bakery" | "vegetarian" | "drinks-desserts";
export type CuisineType = "chinese" | "halal" | "indian" | "western";

export interface Kitchen {
  id: string;
  business_name: string;
  category: MerchantCategory;
  cuisine_type: CuisineType;
  is_halal: boolean;
  description: string | null;
  hero_image: string | null;
  is_live: boolean;
  /** Bumped by the database on every update; Boss saves only if it still matches (stale-edit check). */
  updated_at: string;
}

export interface MenuItem {
  id: string;
  kitchen_id: string;
  name: string;
  price: number;
  photo_url: string | null;
  /** Hidden items stay in the database; customers never see them. */
  is_hidden: boolean;
  updated_at: string;
  created_at: string;
  /** Assisted-onboarding drafts only (assisted_shop_items.category); live menu_items have none. */
  category?: string | null;
}
