/**
 * Kopi Boy is free for merchants during the pilot. The S$29.95 subscription
 * and the founding merchant offer are cancelled; billing is switched off in
 * the database by billing_settings.billing_enabled (docs/supabase-billing-off.sql).
 */
export const PILOT_TERMS_VERSION = "Pilot terms v1";

export const PILOT_TERMS = [
  "Free to join and use. No subscription, registration fee or setup fee. Merchants pay Kopi Boy nothing during the pilot.",
  "Customers pay the merchant directly; Kopi Boy does not handle payments. The merchant pays the rider the delivery fee at collection.",
  "If a commission is introduced later it will be 15% of food sales after discounts, excluding the delivery fee, never higher.",
  "At least 30 days' written notice (in the app and by message) before any charge starts. Nothing is charged before the notice ends and never for earlier orders.",
  "The merchant can leave at any time with no penalty.",
] as const;

export type BillingState =
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "error"; message: string };

/**
 * What the Billing page shows, from the billing_settings read. Only an
 * explicit false is "off": a missing row or column is an error to fix (run
 * docs/supabase-billing-off.sql), never shown as off by accident.
 */
export function billingStateFrom(
  row: { billing_enabled?: unknown } | null,
  error: { message: string } | null
): BillingState {
  if (error) return { kind: "error", message: error.message };
  if (!row) return { kind: "error", message: "the billing_settings row is missing" };
  if (row.billing_enabled === false) return { kind: "off" };
  if (row.billing_enabled === true) return { kind: "on" };
  return { kind: "error", message: "billing_settings.billing_enabled is missing (run docs/supabase-billing-off.sql)" };
}
