"use client";

import { countLabel } from "@/lib/admin-lists";

/** Search input + "12 of 40" count, shared by the Merchants and Riders lists. */
export function ListSearchBox({
  query,
  onChange,
  placeholder,
  label,
  shown,
  total,
  noun,
}: {
  query: string;
  onChange: (query: string) => void;
  placeholder: string;
  label: string;
  shown: number;
  total: number;
  noun: string;
}) {
  const searching = query.trim() !== "";
  return (
    <>
      <input
        type="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="w-full rounded-xl border bg-white px-3 py-2.5 text-sm"
        style={{ borderColor: "#E5E7EB", color: "var(--kb-ink)" }}
      />
      <p className="mt-4 mb-2 text-xs" style={{ color: "var(--kb-on-navy-soft)" }} aria-live="polite">
        {countLabel(shown, total, searching)} {noun}
        {searching && ` match “${query.trim()}”`}
      </p>
    </>
  );
}

/** Grey + 50% opacity for a blocked account's details; buttons sit outside this so they stay fully usable. */
export const BLOCKED_ROW_BG = "#F3F4F6";
