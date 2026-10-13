/**
 * Pure helpers for the searchable merchant and rider lists. No imports so
 * `node --test` can load this file directly (see admin-lists.test.ts).
 */

/** Case-insensitive A–Z; blank names go last so "(no name on file)" rows sink. */
export function compareNames(a: string | null | undefined, b: string | null | undefined): number {
  const x = (a ?? "").trim();
  const y = (b ?? "").trim();
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  return x.localeCompare(y, "en", { sensitivity: "base" }) || (x < y ? -1 : x > y ? 1 : 0);
}

/** Active accounts first, then blocked ones; alphabetical by name inside each group. Returns a new array. */
export function sortActiveThenBlocked<T>(
  items: readonly T[],
  getName: (item: T) => string | null | undefined,
  isActive: (item: T) => boolean
): T[] {
  return [...items].sort((a, b) => {
    const blockedA = isActive(a) ? 0 : 1;
    const blockedB = isActive(b) ? 0 : 1;
    return blockedA - blockedB || compareNames(getName(a), getName(b));
  });
}

/**
 * True when every word of the query appears in at least one of the fields,
 * ignoring case. Spaces are also ignored for the comparison, so "9123 4567"
 * finds "91234567" and vice versa. An empty query matches everything.
 */
export function matchesSearch(query: string, fields: (string | null | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystacks = fields.filter((f): f is string => Boolean(f)).map((f) => f.toLowerCase());
  const squashed = haystacks.map((h) => h.replace(/\s+/g, ""));
  return words.every((w) => haystacks.some((h) => h.includes(w)) || squashed.some((h) => h.includes(w)));
}

/** "12 of 40" while a search is narrowing the list, otherwise just "40". */
export function countLabel(shown: number, total: number, searching: boolean): string {
  return searching ? `${shown} of ${total}` : `${total}`;
}
