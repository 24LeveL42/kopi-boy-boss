/**
 * Mirrors kopi-boy-partner-v2's src/lib/types-kitchen.ts — same
 * `kitchens` / `menu_items` tables, read/written by the admin here too.
 */

export type MerchantCategory = "home-cook" | "hawker" | "bakery" | "bulk-orders" | "drinks";
export type CuisineType = "chinese" | "halal" | "indian" | "western";

export interface Kitchen {
  id: string;
  business_name: string;
  category: MerchantCategory;
  cuisine_type: CuisineType;
  neighbourhood: string;
  description: string | null;
  hero_image: string | null;
  is_live: boolean;
}

export interface MenuItem {
  id: string;
  kitchen_id: string;
  name: string;
  price: number;
  photo_url: string | null;
}
