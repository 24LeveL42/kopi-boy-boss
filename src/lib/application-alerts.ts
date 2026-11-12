/**
 * New-application alerts (pop-up, chime, tab-title count) — pure helpers.
 * The live wiring is in src/components/ApplicationAlerts.tsx; the Realtime
 * publication change is docs/supabase-realtime-applications.sql.
 *
 * Alerts come from comparing the pending lists against the ids already seen,
 * not from the Realtime payload, so the same code works when Realtime is off
 * (the 60-second refresh finds the new rows instead). Only the business name
 * is ever shown: no phone, address, UEN or PayNow details.
 * No imports so `node --test` can load this file directly.
 */

export const ALERT_TABLES = ["cook_applications", "rider_applications"] as const;

/** How often the alerts re-check when Realtime is quiet or not connected. */
export const ALERT_POLL_MS = 60_000;
/** How long a pop-up stays up unless closed. */
export const ALERT_TOAST_MS = 15_000;
/** Most pop-ups shown at once; older ones drop off. */
export const MAX_ALERTS = 4;
/** Newest pending rows read per check (the count itself is exact). */
export const ALERT_FETCH_LIMIT = 100;

export const MUTE_STORAGE_KEY = "kb-boss:alert-sound-muted";

export type AlertKind = "merchant" | "rider";

export interface ApplicationAlert {
  key: string;
  kind: AlertKind;
  title: string;
  href: string;
}

export interface PendingCookRow {
  id: string;
  business_name: string | null;
}

export interface PendingRiderRow {
  id: string;
}

const NAME_MAX = 60;

/** A business name safe for a one-line pop-up: no control characters, single spaces, capped. */
export function cleanBusinessName(raw: string | null | undefined): string {
  const name = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return "(no business name)";
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1).trimEnd()}…` : name;
}

/** Anchor on the application's row in the pending list (see PendingApplications.tsx). */
export function applicationAnchor(id: string): string {
  return `application-${id}`;
}

export function alertFor(kind: "merchant", row: PendingCookRow): ApplicationAlert;
export function alertFor(kind: "rider", row: PendingRiderRow): ApplicationAlert;
export function alertFor(kind: AlertKind, row: PendingCookRow | PendingRiderRow): ApplicationAlert {
  if (kind === "merchant") {
    return {
      key: `merchant:${row.id}`,
      kind,
      title: `New merchant application: ${cleanBusinessName((row as PendingCookRow).business_name)}`,
      href: `/merchants#${applicationAnchor(row.id)}`,
    };
  }
  return { key: `rider:${row.id}`, kind, title: "New rider application", href: `/riders#${applicationAnchor(row.id)}` };
}

/**
 * Remembers which pending applications have been seen. The first successful
 * read of each table only records what's there (no pop-ups for old sign-ups);
 * after that, every id not seen before becomes one alert. A failed read
 * (`rows` null) changes nothing.
 */
export function createAlertTracker() {
  const seen = new Set<string>();
  const seeded: Record<AlertKind, boolean> = { merchant: false, rider: false };

  function take(kind: "merchant", rows: readonly PendingCookRow[] | null): ApplicationAlert[];
  function take(kind: "rider", rows: readonly PendingRiderRow[] | null): ApplicationAlert[];
  function take(kind: AlertKind, rows: readonly (PendingCookRow | PendingRiderRow)[] | null): ApplicationAlert[] {
    if (!rows) return [];
    const fresh: ApplicationAlert[] = [];
    for (const row of rows) {
      const key = `${kind}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seeded[kind]) fresh.push(kind === "merchant" ? alertFor("merchant", row as PendingCookRow) : alertFor("rider", row));
    }
    seeded[kind] = true;
    return fresh;
  }

  return { take };
}

/** `incoming` (newest first) on top of `current`, without duplicates, at most MAX_ALERTS. */
export function mergeAlerts(current: readonly ApplicationAlert[], incoming: readonly ApplicationAlert[]): ApplicationAlert[] {
  const out: ApplicationAlert[] = [];
  for (const a of [...incoming, ...current]) {
    if (!out.some((b) => b.key === a.key)) out.push(a);
  }
  return out.slice(0, MAX_ALERTS);
}

/** Sum of the two pending counts; null when neither could be read. */
export function pendingTotal(cooks: number | null, riders: number | null): number | null {
  if (cooks === null && riders === null) return null;
  return (cooks ?? 0) + (riders ?? 0);
}

const COUNT_PREFIX = /^\(\d+\+?\)\s+/;

/** "(2) Kopi Boy Operations Centre"; any old count is replaced, and none is shown at zero. */
export function titleWithCount(title: string, count: number | null): string {
  const base = title.replace(COUNT_PREFIX, "");
  if (!count || !Number.isFinite(count) || count <= 0) return base;
  return `(${count > 99 ? "99+" : Math.floor(count)}) ${base}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Whether sound is muted. Storage that is missing, blocked or throws counts as "not muted". */
export function readMuted(getStorage: () => StorageLike | null | undefined): boolean {
  try {
    return getStorage()?.getItem(MUTE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Saves the mute choice if storage works; otherwise the choice only lasts for this page. */
export function writeMuted(getStorage: () => StorageLike | null | undefined, muted: boolean): void {
  try {
    getStorage()?.setItem(MUTE_STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // storage blocked (private window, previews): keep the in-memory choice only
  }
}
