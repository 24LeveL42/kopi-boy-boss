/**
 * The business UEN (ACRA registration number) rule, shared by the assisted
 * draft form and HQ's "Business UEN" on the merchant page. Same pattern as
 * the database (check_cook_application_uen, set_my_business_uen,
 * admin_set_kitchen_business_uen) and the Partner app's src/lib/business-uen.ts:
 *   * businesses        nnnnnnnnX    (8 digits + letter)
 *   * local companies   yyyynnnnnX   (9 digits + letter)
 *   * other entities    TyyPQnnnnX   (T/S/R, 2 digits, 2 letters, 4 digits, letter)
 * The database checks again; this only gives an early, friendly message.
 */
export const BUSINESS_UEN_PATTERN = /^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$/;

/** Trimmed and upper-cased, like the database stores it. */
export function normalizeBusinessUen(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

export const UEN_FORMAT_MESSAGE = "That UEN doesn't look right. It's 9 or 10 characters, like 53123456A or 201912345K.";
