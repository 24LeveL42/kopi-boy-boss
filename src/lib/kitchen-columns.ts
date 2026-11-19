/**
 * Explicit column lists for reading public.kitchens and public.menu_items.
 * Signed-in users can't read the private kitchens columns (PayNow details,
 * lat/lng, terms acknowledgement, opening hours), so a select("*") on
 * kitchens fails with "permission denied". Always name the columns; never
 * add a private one here.
 */

/**
 * Merchants list: what the table renders. region is public and read-only:
 * the database derives it from the cook's postal code; Boss never writes it.
 */
export const MERCHANT_LIST_KITCHEN_COLUMNS = "id, business_name, category, cuisine_type, is_live, region";

/**
 * Edit merchant: every Kitchen field MerchantEditForm reads, plus updated_at
 * for the stale-edit check. Nothing the database derives.
 */
export const MERCHANT_EDIT_KITCHEN_COLUMNS =
  "id, business_name, category, cuisine_type, is_halal, description, hero_image, is_live, updated_at";

/** Edit merchant: the menu, hidden items included (HQ and the cook can see them). */
export const MERCHANT_EDIT_MENU_COLUMNS = "id, kitchen_id, name, price, photo_url, is_hidden, updated_at, created_at";

/** Change history on the edit page. */
export const KITCHEN_AUDIT_COLUMNS = "id, created_at, admin_id, target_table, target_id, action, changes, reason";

/**
 * Why the edit form must not be shown, or null when it's safe to show.
 * A missing or failed kitchen must never fall back to a blank form: its
 * defaults would overwrite the real kitchen on Save.
 */
export function kitchenLoadProblem(result: { data: unknown; error: { message: string } | null }): string | null {
  if (result.error) return `Couldn't load this kitchen: ${result.error.message}`;
  if (!result.data) return "This merchant has no kitchen record, so there is nothing to edit.";
  return null;
}
