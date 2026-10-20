/**
 * Rider tracking — pure helpers for the Riders map, "Track rider" and
 * "Replay route". Data comes from public.rider_live_location (one row per
 * rider, updated live) and public.rider_location_points (route history,
 * about every 15 seconds on a job); both are admin-read-only to Boss.
 * No imports so `node --test` can load this file directly (see rider-tracking.test.ts).
 */

/** A dot turns grey when the rider hasn't sent a position for this long. */
export const STALE_AFTER_MS = 2 * 60_000;

/** Riders whose last position is older than this aren't shown at all. */
export const HIDE_AFTER_MS = 15 * 60_000;

/** Polling interval used while Realtime isn't connected. */
export const POLL_INTERVAL_MS = 15_000;

/** Centre of Singapore, for the map's starting view. */
export const SINGAPORE_CENTER: [number, number] = [1.3521, 103.8198];

export interface LiveLocation {
  rider_id: string;
  lat: number | string;
  lng: number | string;
  accuracy_m: number | string | null;
  heading: number | string | null;
  speed_mps: number | string | null;
  delivery_request_id: string | null;
  updated_at: string;
}

export interface RoutePoint {
  id: number | string;
  lat: number | string;
  lng: number | string;
  accuracy_m: number | string | null;
  recorded_at: string;
}

export type DotState = "delivery" | "idle" | "stale";

/** Purple on a delivery, blue sharing with no job, grey once silent for over 2 minutes. */
export const DOT_COLOR: Record<DotState, string> = {
  delivery: "#5B3FD0",
  idle: "#1D5BBF",
  stale: "#9A98AA",
};

export const DOT_LABEL: Record<DotState, string> = {
  delivery: "On a delivery",
  idle: "No job",
  stale: "No update for over 2 minutes",
};

function ageMs(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : nowMs - t;
}

/** The 15-minute rule: only riders heard from in the last 15 minutes are shown. */
export function isShown(loc: Pick<LiveLocation, "updated_at">, nowMs: number): boolean {
  return ageMs(loc.updated_at, nowMs) <= HIDE_AFTER_MS;
}

/** Stale (grey) wins over on-a-delivery (purple): an old position says nothing about now. */
export function dotState(loc: Pick<LiveLocation, "updated_at" | "delivery_request_id">, nowMs: number): DotState {
  if (ageMs(loc.updated_at, nowMs) > STALE_AFTER_MS) return "stale";
  return loc.delivery_request_id ? "delivery" : "idle";
}

/** Riders to draw, newest update first, with a usable position. Returns a new array. */
export function visibleRiders<T extends LiveLocation>(locations: readonly T[], nowMs: number): T[] {
  return locations
    .filter((l) => isShown(l, nowMs) && toLatLng(l.lat, l.lng) !== null)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

/** Postgres numerics can arrive as strings; null for anything that isn't a real position (0,0 included). */
export function toLatLng(lat: unknown, lng: unknown): [number, number] | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined || lat === "" || lng === "") return null;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  if (a === 0 && b === 0) return null;
  return [a, b];
}

/** "just now", "1 second ago", "12 seconds ago", "3 minutes ago", "2 hours ago", "4 days ago". */
export function timeAgo(iso: string, nowMs: number): string {
  const ms = ageMs(iso, nowMs);
  if (!Number.isFinite(ms)) return "unknown";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 1) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return unit(s, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 48) return unit(h, "hour");
  return unit(Math.floor(h / 24), "day");
}

/** "±7 m", or "Unknown" when the phone didn't report accuracy. */
export function formatAccuracy(meters: number | string | null | undefined): string {
  if (meters === null || meters === undefined || meters === "") return "Unknown";
  const n = Number(meters);
  return Number.isFinite(n) && n >= 0 ? `±${Math.round(n)} m` : "Unknown";
}

/**
 * Route in the order the rider travelled it: by recorded_at, then id for
 * points saved in the same instant. Points without a usable position are
 * dropped. Returns a new array.
 */
export function orderRoute<T extends RoutePoint>(points: readonly T[]): T[] {
  return points
    .filter((p) => toLatLng(p.lat, p.lng) !== null && !Number.isNaN(Date.parse(p.recorded_at)))
    .sort((a, b) => {
      const dt = Date.parse(a.recorded_at) - Date.parse(b.recorded_at);
      if (dt !== 0) return dt;
      const ia = Number(a.id);
      const ib = Number(b.id);
      return Number.isFinite(ia) && Number.isFinite(ib) ? ia - ib : String(a.id).localeCompare(String(b.id));
    });
}

/** Merges a Realtime change into the current set (one row per rider). Returns a new array. */
export function applyLocationChange<T extends LiveLocation>(
  current: readonly T[],
  change: { eventType: "INSERT" | "UPDATE" | "DELETE"; row: Partial<T> & { rider_id?: string } }
): T[] {
  const id = change.row.rider_id;
  if (!id) return [...current];
  const rest = current.filter((l) => l.rider_id !== id);
  return change.eventType === "DELETE" ? rest : [...rest, change.row as T];
}

/** "21 Oct, 12:04:35 pm" in Singapore time; route points are ~15 seconds apart, so seconds matter. */
export function formatSgTimeWithSeconds(iso: string): string {
  return new Date(iso).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}
