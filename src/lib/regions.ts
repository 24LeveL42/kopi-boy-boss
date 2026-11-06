/**
 * Singapore regions in Boss: the coarse North / South / East / West label.
 *
 * - kitchens.region is derived by the database from the cook's private postal
 *   code (Partner repo docs/supabase-regions.sql). Boss only shows it and
 *   never writes it. null = no postal code, or a sector with no region.
 * - rider_regions (user_id, region) holds where each rider usually rides.
 *   Boss reads it (RLS: admins read every row) and changes it only through
 *   the admin_set_rider_regions RPC, which checks admin, rider and regions
 *   again in the database.
 *
 * Codes, labels and tag colours match the Customer app's src/lib/regions.ts
 * and public.regions (sort_order 1-4). A tag always shows the word, so colour
 * is never the only signal.
 *
 * Pure module (type-only imports) so `node --test` can load it with a fake client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const REGION_CODES = ["north", "south", "east", "west"] as const;
export type RegionCode = (typeof REGION_CODES)[number];

export const REGION_LABEL: Record<RegionCode, string> = {
  north: "North",
  south: "South",
  east: "East",
  west: "West",
};

/** Same as the Customer app: dark text on a light tint. */
export const REGION_COLOURS: Record<RegionCode, { text: string; background: string }> = {
  north: { text: "#1d4ed8", background: "#dbeafe" },
  south: { text: "#9a3412", background: "#ffedd5" },
  east: { text: "#be123c", background: "#ffe4e6" },
  west: { text: "#0e7490", background: "#cffafe" },
};

export const NO_REGION_LABEL = "No region";
export const RIDER_NO_REGIONS_LABEL = "Not set";
export const PICK_A_REGION_MESSAGE = "Pick at least one region.";

/** A region code from the database, or null for anything else (null, unknown, wrong case). */
export function toRegion(value: unknown): RegionCode | null {
  return typeof value === "string" && (REGION_CODES as readonly string[]).includes(value) ? (value as RegionCode) : null;
}

// --- Merchants list filter ---

export type RegionFilter = RegionCode | "all";

/** The ?region= value; anything unknown means All. */
export function parseRegionFilter(value: unknown): RegionFilter {
  return toRegion(typeof value === "string" ? value.trim().toLowerCase() : value) ?? "all";
}

export type RegionCounts = Record<RegionCode | "none", number> & { all: number };

/** How many merchants are in each region; "none" = no region. */
export function countByRegion(items: readonly { region?: unknown }[]): RegionCounts {
  const counts: RegionCounts = { all: items.length, north: 0, south: 0, east: 0, west: 0, none: 0 };
  for (const item of items) counts[toRegion(item.region) ?? "none"] += 1;
  return counts;
}

/** All keeps everything (merchants with no region too); a region keeps only its own. */
export function filterByRegion<T extends { region?: unknown }>(items: readonly T[], filter: RegionFilter): T[] {
  return filter === "all" ? [...items] : items.filter((i) => toRegion(i.region) === filter);
}

// --- Rider regions ---

/** Known codes only, no duplicates, in the fixed order. */
export function normalizeRegions(values: readonly unknown[]): RegionCode[] {
  const picked = new Set(values.map((v) => (typeof v === "string" ? v.trim().toLowerCase() : v)));
  return REGION_CODES.filter((code) => picked.has(code));
}

/** Checked before the RPC is called; the database checks again. */
export function validateRiderRegions(
  values: unknown,
): { ok: true; regions: RegionCode[] } | { ok: false; message: string } {
  if (!Array.isArray(values)) return { ok: false, message: PICK_A_REGION_MESSAGE };
  const raw = values.map((v) => (typeof v === "string" ? v.trim().toLowerCase() : v)).filter((v) => v !== "");
  const regions = normalizeRegions(raw);
  if (raw.length > regions.length && raw.some((v) => toRegion(v) === null)) {
    return { ok: false, message: "Unknown region. Use North, South, East or West." };
  }
  return regions.length > 0 ? { ok: true, regions } : { ok: false, message: PICK_A_REGION_MESSAGE };
}

export type RiderRegionsLoad = { ok: true; byRider: Map<string, RegionCode[]> } | { ok: false; error: string };

type FromClient = Pick<SupabaseClient, "from">;

const ID_BATCH = 150;

/**
 * Every listed rider's regions from rider_regions. A failed read is returned
 * as an error, never as "no regions": the screen must say it couldn't load,
 * not show every rider as "Not set".
 */
export async function loadRiderRegions(client: FromClient, riderIds: readonly string[]): Promise<RiderRegionsLoad> {
  const ids = [...new Set(riderIds)];
  const rows: { user_id: string; region: unknown }[] = [];
  try {
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const { data, error } = await client
        .from("rider_regions")
        .select("user_id, region")
        .in("user_id", ids.slice(i, i + ID_BATCH));
      if (error) return { ok: false, error: error.message || "unknown error" };
      rows.push(...((data ?? []) as { user_id: string; region: unknown }[]));
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown error" };
  }
  const grouped = new Map<string, unknown[]>();
  for (const row of rows) grouped.set(row.user_id, [...(grouped.get(row.user_id) ?? []), row.region]);
  const byRider = new Map<string, RegionCode[]>();
  for (const [id, values] of grouped) byRider.set(id, normalizeRegions(values));
  return { ok: true, byRider };
}

type ErrorLike = { code?: string; message?: string } | null | undefined;

/** A message HQ can act on, for an error from admin_set_rider_regions. */
export function riderRegionsSaveMessage(error: ErrorLike): string {
  const message = error?.message ?? "";
  if (/at least one region/i.test(message)) return PICK_A_REGION_MESSAGE;
  if (/unknown region/i.test(message)) return "Unknown region. Use North, South, East or West.";
  if (/only admins/i.test(message)) return "Only admins can change a rider's regions.";
  if (/only riders and rider applicants/i.test(message)) return "This person isn't a rider or rider applicant, so they can't have ride regions.";
  if (/choose a rider/i.test(message)) return "No rider was chosen.";
  if (error?.code === "PGRST202" || error?.code === "42883") {
    return "Changing regions isn't available yet: admin_set_rider_regions wasn't found in the database.";
  }
  return message ? `Couldn't save the regions: ${message}` : "Couldn't save the regions. Please try again.";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SaveResult = { ok: true; regions: RegionCode[] } | { ok: false; message: string };

/**
 * Replaces a rider's regions with exactly `values` through
 * admin_set_rider_regions. Never throws: problems come back as a message.
 * The caller must already have passed assertAdmin().
 */
export async function setRiderRegionsWith(
  client: Pick<SupabaseClient, "rpc">,
  riderId: unknown,
  values: unknown,
): Promise<SaveResult> {
  if (typeof riderId !== "string" || !UUID.test(riderId)) return { ok: false, message: "No rider was chosen." };
  const checked = validateRiderRegions(values);
  if (!checked.ok) return checked;
  try {
    const { error } = await client.rpc("admin_set_rider_regions", { p_rider: riderId, p_regions: checked.regions });
    if (error) {
      console.error("admin_set_rider_regions failed:", error);
      return { ok: false, message: riderRegionsSaveMessage(error) };
    }
    return { ok: true, regions: checked.regions };
  } catch (e) {
    console.error("admin_set_rider_regions failed:", e);
    return { ok: false, message: "Couldn't reach the database. Please check your connection and try again." };
  }
}
