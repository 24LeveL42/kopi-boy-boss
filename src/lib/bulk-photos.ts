/**
 * "Bulk photos" for an assisted-onboarding draft menu: HQ chooses many photos
 * at once, Boss uploads them to kitchen-photos/assisted/<shopId>/, pairs each
 * one with a draft item (by file name, or in menu order) in a preview, and
 * only Apply saves anything (setAssistedItemPhotos, one item at a time
 * through the usual draft item update).
 *
 * Pure (no React, no browser APIs), so `node --test` and the panel share it.
 */
import { categoryGroups } from "./draft-menu.ts";
import { cleanCategory } from "./menu-csv.ts";

export const BULK_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Photos are downscaled so the long side is at most this. */
export const BULK_PHOTO_MAX_SIDE = 1600;
export const BULK_PHOTO_JPEG_QUALITY = 0.85;
export const BULK_UPLOAD_CONCURRENCY = 3;
/** At most this many items in one Apply. */
export const BULK_APPLY_MAX = 300;
export const BULK_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

// --- Names ---

/** Lowercase, keep only letters and digits (any script): "Egg Prata" -> "eggprata". */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** A file name without its extension, normalised: "egg_prata.WEBP" -> "eggprata". */
export function normalizeFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return normalizeName(dot > 0 ? fileName.slice(0, dot) : fileName);
}

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Natural order: IMG_2 before IMG_10. Ties broken by the exact text, so the order is stable. */
export function naturalCompare(a: string, b: string): number {
  return COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

// --- Menu order ---

type Item = { id: string; name: string; category?: string | null; is_hidden: boolean; photo_url: string | null };

/** The draft items in the order the editor shows them: by category group (no category last), then their own order. */
export function menuOrder<T extends Item>(items: T[]): T[] {
  return categoryGroups(items).flatMap((g) => g.items);
}

/** The key a category filter uses (same matching as the editor's groups). "" = no category. */
export function categoryKey(category: string | null | undefined): string {
  return (cleanCategory(category ?? null) ?? "").toLowerCase();
}

// --- Matching ---

export type MatchResult = { itemId: string | null; ambiguous: boolean };

/**
 * Matches a file name to an item by normalised name, exact equality only.
 * More than one item with that name (say, in two categories) = ambiguous,
 * left unmatched.
 */
export function matchByName(fileName: string, items: Item[]): MatchResult {
  const key = normalizeFileName(fileName);
  if (!key) return { itemId: null, ambiguous: false };
  const hits = items.filter((i) => normalizeName(i.name) === key);
  if (hits.length === 1) return { itemId: hits[0].id, ambiguous: false };
  return { itemId: null, ambiguous: hits.length > 1 };
}

/**
 * "Pair in menu order": the photos sorted by file name (natural order),
 * paired one-to-one with the items in menu order, optionally only one
 * category. Unless replaceExisting, items that already have a photo are
 * passed over, so pairing starts at the first item with no photo and never
 * spends a photo on an item Apply would skip. Extra photos stay unassigned.
 * Returns photo key -> item id (or null).
 */
export function pairInMenuOrder(
  photos: { key: string; fileName: string }[],
  items: Item[],
  options: { category?: string | null; replaceExisting: boolean }
): Map<string, string | null> {
  let targets = menuOrder(items);
  if (options.category !== undefined) {
    const want = categoryKey(options.category);
    targets = targets.filter((i) => categoryKey(i.category) === want);
  }
  if (!options.replaceExisting) targets = targets.filter((i) => !i.photo_url);
  const sorted = [...photos].sort((a, b) => naturalCompare(a.fileName, b.fileName));
  return new Map(sorted.map((p, n) => [p.key, targets[n]?.id ?? null]));
}

// --- Resize ---

/** Resize when over 5 MB or when the long side is over 1600 px. */
export function needsResize(file: { size: number; width: number; height: number }): boolean {
  return file.size > BULK_PHOTO_MAX_BYTES || Math.max(file.width, file.height) > BULK_PHOTO_MAX_SIDE;
}

/** Size after downscaling to at most 1600 px on the long side (never upscaled). */
export function resizedSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, BULK_PHOTO_MAX_SIDE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** "IMG_1234.HEIC.png" -> "IMG_1234.HEIC.jpg" (the name a re-encoded photo keeps for matching). */
export function jpegName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return `${dot > 0 ? fileName.slice(0, dot) : fileName}.jpg`;
}

// --- Upload pool ---

export type PoolResult<R> = { ok: true; value: R } | { ok: false; message: string };

/**
 * Runs worker over every input, at most `limit` at a time, in input order.
 * One failing (throwing) never stops the rest; each result says why.
 */
export async function runPool<T, R>(
  inputs: T[],
  limit: number,
  worker: (input: T, index: number) => Promise<R>,
  onDone?: (index: number, result: PoolResult<R>) => void
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = new Array(inputs.length);
  let next = 0;
  async function lane() {
    while (next < inputs.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(inputs[i], i) };
      } catch (e) {
        results[i] = { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      onDone?.(i, results[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, inputs.length)) }, lane));
  return results;
}

// --- Preview ---

export type PhotoRow = { key: string; fileName: string; url: string | null; itemId: string | null };
export type RowState = "update" | "skipped" | "unassigned" | "conflict" | "unchanged";

export type BulkPlan = {
  /** What Apply does with each photo row, by key. */
  rows: Map<string, RowState>;
  /** The item updates Apply sends. */
  updates: { itemId: string; photoUrl: string }[];
  toUpdate: number;
  /** Paired with an item that already has a photo (replace not ticked). */
  skipped: number;
  /** Uploaded photos with no item. */
  unmatched: number;
  /** Photos paired with an item another photo is also paired with: fix before Apply. */
  conflicts: number;
};

/**
 * The preview counts and the exact updates Apply sends. Photos that are not
 * uploaded (failed or still uploading) are left out. Two photos on one item
 * is a conflict and neither is applied until HQ fixes it.
 */
export function planBulkPhotos(photos: PhotoRow[], items: Item[], replaceExisting: boolean): BulkPlan {
  const byId = new Map(items.map((i) => [i.id, i]));
  const uploaded = photos.filter((p) => p.url);
  const perItem = new Map<string, number>();
  for (const p of uploaded) if (p.itemId && byId.has(p.itemId)) perItem.set(p.itemId, (perItem.get(p.itemId) ?? 0) + 1);

  const rows = new Map<string, RowState>();
  const updates: BulkPlan["updates"] = [];
  let skipped = 0;
  let unmatched = 0;
  let conflicts = 0;
  for (const p of uploaded) {
    const item = p.itemId ? byId.get(p.itemId) : undefined;
    let state: RowState;
    if (!item) state = "unassigned";
    else if ((perItem.get(item.id) ?? 0) > 1) state = "conflict";
    else if (item.photo_url === p.url) state = "unchanged";
    else if (item.photo_url && !replaceExisting) state = "skipped";
    else state = "update";
    rows.set(p.key, state);
    if (state === "unassigned") unmatched++;
    else if (state === "conflict") conflicts++;
    else if (state === "skipped") skipped++;
    else if (state === "update") updates.push({ itemId: item!.id, photoUrl: p.url! });
  }
  return { rows, updates, toUpdate: updates.length, skipped, unmatched, conflicts };
}

// --- Server-side URL check ---

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * True only for a photo Boss uploaded to this shop's own folder:
 * <public base of kitchen-photos>/assisted/<shopId>/<uuid>.<jpg|png|webp>,
 * exactly (no query, no other folder, no "..").
 */
export function isOwnAssistedPhotoUrl(url: unknown, shopId: string, bucketPublicBase: string): boolean {
  if (typeof url !== "string" || url.length > 2000) return false;
  if (!new RegExp(`^${UUID_RE}$`, "i").test(shopId)) return false;
  const base = bucketPublicBase.replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) return false;
  const prefix = `${base}/assisted/${shopId.toLowerCase()}/`;
  if (!url.startsWith(prefix)) return false;
  return new RegExp(`^${UUID_RE}\\.(jpg|png|webp)$`, "i").test(url.slice(prefix.length));
}

// --- Wording ---

export function bulkApplyNotice(updated: number, skipped: number, failed: number): string {
  const n = (k: number) => `${k} item${k === 1 ? "" : "s"}`;
  const parts = [updated === 0 ? "No photos set" : `Photo set on ${n(updated)}`];
  if (skipped) parts.push(`${n(skipped)} skipped (already had a photo)`);
  if (failed) parts.push(`${n(failed)} not saved`);
  return `${parts.join(" · ")}.`;
}
