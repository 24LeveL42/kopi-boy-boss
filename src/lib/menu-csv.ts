/**
 * CSV menu import for an assisted-onboarding draft: parse, check and preview.
 * Pure (no database): the browser uses it for the preview, and the server
 * action runs it again on the same text before anything is written
 * (importDraftMenuWith in assisted-onboarding.ts). The database function
 * admin_import_assisted_menu checks the rows a third time.
 *
 * Columns: category, name, price, check_with_owner. Header row required,
 * any order, matched ignoring case and spaces. name and price required.
 * Unknown columns are ignored and listed. UTF-8, a leading BOM (Excel) is
 * dropped, quoted fields with commas, quotes ("") and line breaks work.
 */
import { ITEM_NAME_MAX, validateMenuItem } from "./kitchen-admin.ts";

export const CSV_MAX_ROWS = 200;
export const CSV_MAX_CHARS = 200_000;
export const CATEGORY_MAX = 60;
export const CSV_COLUMNS = ["category", "name", "price", "check_with_owner"] as const;
type Column = (typeof CSV_COLUMNS)[number];

export type CsvRow = {
  /** The row number as a spreadsheet shows it: the header is row 1. */
  row: number;
  category: string | null;
  name: string;
  price: number;
  /** check_with_owner was filled in: imported hidden. */
  hidden: boolean;
  /** The check_with_owner text (shown in the preview; there is no notes field to save it in). */
  note: string | null;
};
export type CsvError = { row: number | null; message: string };
export type CategorySummary = { category: string | null; count: number; items: CsvRow[] };
export type CsvPreview = {
  rows: CsvRow[];
  errors: CsvError[];
  unknownColumns: string[];
  total: number;
  hidden: number;
  categories: CategorySummary[];
  cheapest: number | null;
  dearest: number | null;
};

/** Splits CSV text into rows of fields (RFC 4180). Throws on an unclosed quote. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new Error("A quoted field is never closed (a \" is missing).");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Trim and collapse inner spaces; '' becomes null. Same rule as the database. */
export function cleanCategory(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().replace(/\s+/g, " ");
  return v === "" ? null : v;
}

/** The duplicate key: name + category, ignoring case and extra spaces. */
export function itemKey(name: string, category: string | null | undefined): string {
  return `${name.trim().replace(/\s+/g, " ").toLowerCase()}\u001f${(cleanCategory(category) ?? "").toLowerCase()}`;
}

const headerKey = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");
/** A positive number with at most 2 decimals; a leading $ is allowed, like the editor. */
const PRICE_RE = /^\$?\s*(\d+(?:\.\d{1,2})?|\.\d{1,2})$/;

export function previewCsv(text: string): CsvPreview {
  const empty: CsvPreview = { rows: [], errors: [], unknownColumns: [], total: 0, hidden: 0, categories: [], cheapest: null, dearest: null };
  if (text.length > CSV_MAX_CHARS) return { ...empty, errors: [{ row: null, message: "The file is too big. Import at most 200 rows." }] };

  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (e) {
    return { ...empty, errors: [{ row: null, message: (e as Error).message }] };
  }
  // Blank lines are ignored (but still counted for row numbers).
  const lines = table.map((cells, i) => ({ cells, row: i + 1 })).filter((l) => l.cells.some((c) => c.trim() !== ""));
  if (lines.length === 0) return { ...empty, errors: [{ row: null, message: "The file is empty. The first row must be the header: category,name,price,check_with_owner." }] };

  const [header, ...data] = lines;
  const index = new Map<Column, number>();
  const unknownColumns: string[] = [];
  const errors: CsvError[] = [];
  header.cells.forEach((h, i) => {
    const key = headerKey(h) as Column;
    if ((CSV_COLUMNS as readonly string[]).includes(key)) {
      if (index.has(key)) errors.push({ row: header.row, message: `The column "${key}" appears twice.` });
      else index.set(key, i);
    } else if (h.trim() !== "") unknownColumns.push(h.trim());
  });
  for (const required of ["name", "price"] as const) {
    if (!index.has(required)) errors.push({ row: header.row, message: `The header has no "${required}" column.` });
  }
  if (errors.length) return { ...empty, errors, unknownColumns };
  if (data.length === 0) return { ...empty, unknownColumns, errors: [{ row: null, message: "The file has a header but no items." }] };
  if (data.length > CSV_MAX_ROWS) {
    return { ...empty, unknownColumns, errors: [{ row: null, message: `The file has ${data.length} items; the most is ${CSV_MAX_ROWS}. Split it into two files.` }] };
  }

  const cell = (cells: string[], col: Column) => {
    const i = index.get(col);
    return i === undefined ? "" : (cells[i] ?? "");
  };
  const rows: CsvRow[] = [];
  const seen = new Map<string, number>();
  for (const { cells, row } of data) {
    const rowErrors: string[] = [];
    const rawName = cell(cells, "name");
    const rawPrice = cell(cells, "price").trim();
    const category = cleanCategory(cell(cells, "category"));
    const note = cell(cells, "check_with_owner").trim() || null;

    if (category && category.length > CATEGORY_MAX) rowErrors.push(`The category is longer than ${CATEGORY_MAX} characters.`);
    let price = NaN;
    if (!rawPrice) rowErrors.push("The price is empty.");
    else if (!PRICE_RE.test(rawPrice)) rowErrors.push(`"${rawPrice}" isn't a valid price: use a positive number with at most 2 decimals, like 4.50.`);
    else price = Number(rawPrice.replace(/^\$\s*/, ""));

    // The editor's own rules (name required and length, price above 0 and the maximum).
    const checked = validateMenuItem({ name: rawName, price: Number.isFinite(price) ? price : 1, photo_url: null });
    if (!checked.ok) {
      rowErrors.push(
        /name is required/i.test(checked.message)
          ? "The name is empty."
          : /name can be at most/i.test(checked.message)
            ? `The name is longer than ${ITEM_NAME_MAX} characters.`
            : checked.message
      );
    } else if (Number.isFinite(price) && price <= 0) {
      rowErrors.push("The price must be more than $0.");
    }

    const name = rawName.trim();
    if (name) {
      const key = itemKey(name, category);
      const first = seen.get(key);
      if (first !== undefined) rowErrors.push(`"${name}" is already in ${category ? `"${category}"` : "the items with no category"} on row ${first}.`);
      else seen.set(key, row);
    }

    if (rowErrors.length) {
      for (const message of rowErrors) errors.push({ row, message });
      continue;
    }
    rows.push({ row, category, name, price: checked.ok ? checked.value.price : price, hidden: note !== null, note });
  }

  const byCategory = new Map<string, CategorySummary>();
  for (const r of rows) {
    const key = (r.category ?? "").toLowerCase();
    const group = byCategory.get(key) ?? { category: r.category, count: 0, items: [] };
    group.count++;
    group.items.push(r);
    byCategory.set(key, group);
  }
  const prices = rows.map((r) => r.price);
  return {
    rows,
    errors,
    unknownColumns,
    total: rows.length,
    hidden: rows.filter((r) => r.hidden).length,
    categories: [...byCategory.values()],
    cheapest: prices.length ? Math.min(...prices) : null,
    dearest: prices.length ? Math.max(...prices) : null,
  };
}

export type ImportMode = "add" | "replace";
export type ImportPlan = { toImport: number; skipped: number; existingHidden: number; hidden: number };

/**
 * What an import would do to this draft, for the preview and the replace
 * confirmation. The database works it out again when saving.
 */
export function planImport(
  preview: Pick<CsvPreview, "rows">,
  existing: { name: string; category?: string | null; is_hidden: boolean }[],
  mode: ImportMode
): ImportPlan {
  if (mode === "replace") {
    return {
      toImport: preview.rows.length,
      skipped: 0,
      existingHidden: existing.filter((i) => !i.is_hidden).length,
      hidden: preview.rows.filter((r) => r.hidden).length,
    };
  }
  const have = new Set(existing.map((i) => itemKey(i.name, i.category)));
  const fresh = preview.rows.filter((r) => !have.has(itemKey(r.name, r.category)));
  return {
    toImport: fresh.length,
    skipped: preview.rows.length - fresh.length,
    existingHidden: 0,
    hidden: fresh.filter((r) => r.hidden).length,
  };
}

/** What the admin sees after a successful import (the counts the database returned). */
export function importNotice(
  c: { imported: number; hidden: number; skipped: number; existing_hidden: number },
  mode: ImportMode
): string {
  const parts = [`Imported ${c.imported} item${c.imported === 1 ? "" : "s"}`];
  if (c.hidden) parts.push(`${c.hidden} hidden to check with the owner`);
  if (mode === "add") parts.push(`${c.skipped} skipped (already in the draft)`);
  if (mode === "replace") parts.push(`${c.existing_hidden} existing item${c.existing_hidden === 1 ? "" : "s"} hidden`);
  return `${parts.join(" · ")}.`;
}

/** "X existing items will be hidden" (the replace-all confirmation). */
export function replaceConfirmation(existingHidden: number): string {
  return `${existingHidden} existing item${existingHidden === 1 ? "" : "s"} will be hidden. They stay in the draft but aren't copied to the shop. Import and replace?`;
}
