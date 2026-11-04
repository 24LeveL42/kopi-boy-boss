/**
 * Explicit column lists for reading public.kitchens. Signed-in users can't
 * read the private columns (PayNow details, lat/lng, terms acknowledgement),
 * so a select("*") on kitchens fails with "permission denied". Always name
 * the columns; never add a private one here.
 */

/** Merchants list: what the table renders. */
export const MERCHANT_LIST_KITCHEN_COLUMNS = "id, business_name, category, cuisine_type, is_live";

/** Edit merchant: every Kitchen field MerchantEditForm reads. */
export const MERCHANT_EDIT_KITCHEN_COLUMNS =
  "id, business_name, category, cuisine_type, neighbourhood, description, hero_image, is_live";

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
