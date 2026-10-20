"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { countLabel, matchesSearch } from "@/lib/admin-lists";
import { EmptyState } from "./EmptyState";

export type TableColumn = { label: string; align?: "left" | "right"; className?: string };

export type TableRow = {
  id: string;
  /** Text the search box matches against (every word must hit one of these). */
  search: (string | null | undefined)[];
  /** One node per column; may hold client components such as action buttons. */
  cells: React.ReactNode[];
  /** Faded details for a blocked account; the last cell (actions) stays fully usable. */
  muted?: boolean;
  /** Clicking the row (outside its links and buttons) opens this page. */
  rowHref?: string;
};

/** Search field + "12 of 40 …" count shared by DataTable and SearchableList. */
function SearchBar({
  query,
  onChange,
  placeholder,
  shown,
  total,
  noun,
  toolbar,
}: {
  query: string;
  onChange: (q: string) => void;
  placeholder: string;
  shown: number;
  total: number;
  noun: string;
  toolbar?: React.ReactNode;
}) {
  const searching = query.trim() !== "";
  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
      <input
        type="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={`Search ${noun}`}
        className="w-full rounded-lg border sm:w-96 px-3 py-2 text-sm outline-none focus:border-[var(--oc-accent)]"
        style={{ borderColor: "var(--oc-line)", background: "var(--oc-bg)", color: "var(--oc-text)" }}
      />
      <p className="text-xs" style={{ color: "var(--oc-text-soft)" }} aria-live="polite">
        {countLabel(shown, total, searching)} {noun}
      </p>
      {toolbar && <div className="ml-auto flex items-center gap-2">{toolbar}</div>}
    </div>
  );
}

export function DataTable({
  columns,
  rows,
  noun,
  searchPlaceholder,
  initialQuery = "",
  empty,
  toolbar,
}: {
  columns: TableColumn[];
  rows: TableRow[];
  noun: string;
  searchPlaceholder: string;
  initialQuery?: string;
  /** Shown when there are no rows at all (not when a search finds nothing). */
  empty: React.ReactNode;
  toolbar?: React.ReactNode;
}) {
  const [query, setQuery] = useState(initialQuery);
  const router = useRouter();
  const results = rows.filter((r) => matchesSearch(query, r.search));

  return (
    <>
      <SearchBar
        query={query}
        onChange={setQuery}
        placeholder={searchPlaceholder}
        shown={results.length}
        total={rows.length}
        noun={noun}
        toolbar={toolbar}
      />
      {rows.length === 0 ? (
        empty
      ) : results.length === 0 ? (
        <EmptyState title={`No ${noun} match “${query.trim()}”`} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.label}
                    scope="col"
                    className={`border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wide ${
                      c.align === "right" ? "text-right" : "text-left"
                    } ${c.className ?? ""}`}
                    style={{ borderColor: "var(--oc-line)", color: "var(--oc-text-soft)" }}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr
                  key={r.id}
                  data-blocked={r.muted || undefined}
                  onClick={
                    r.rowHref
                      ? (e) => {
                          if ((e.target as HTMLElement).closest("a, button, input, textarea, select")) return;
                          router.push(r.rowHref!);
                        }
                      : undefined
                  }
                  className={`border-b last:border-b-0 hover:bg-[var(--oc-bg)] ${r.rowHref ? "cursor-pointer" : ""}`}
                  style={{ borderColor: "var(--oc-line)" }}
                >
                  {r.cells.map((cell, i) => (
                    <td
                      key={i}
                      className={`px-4 py-3 align-top ${columns[i]?.align === "right" ? "text-right" : ""} ${
                        r.muted && i < r.cells.length - 1 ? "opacity-50" : ""
                      }`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Same search bar over a stack of cards (the Messages inbox, where each card holds a reply form). */
export function SearchableList({
  items,
  noun,
  searchPlaceholder,
  empty,
  toolbar,
}: {
  items: { id: string; search: (string | null | undefined)[]; node: React.ReactNode }[];
  noun: string;
  searchPlaceholder: string;
  empty: React.ReactNode;
  toolbar?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const results = items.filter((i) => matchesSearch(query, i.search));
  return (
    <>
      <SearchBar
        query={query}
        onChange={setQuery}
        placeholder={searchPlaceholder}
        shown={results.length}
        total={items.length}
        noun={noun}
        toolbar={toolbar}
      />
      {items.length === 0 ? (
        empty
      ) : results.length === 0 ? (
        <EmptyState title={`No ${noun} match “${query.trim()}”`} />
      ) : (
        <div className="space-y-3 p-4">
          {results.map((i) => (
            <div key={i.id}>{i.node}</div>
          ))}
        </div>
      )}
    </>
  );
}

/** Two-line cell: main text and a muted line under it. */
export function Cell({ main, sub }: { main: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="font-medium" style={{ color: "var(--oc-text)" }}>
        {main}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs" style={{ color: "var(--oc-text-soft)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}
