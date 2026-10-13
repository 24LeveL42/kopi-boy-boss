"use client";

import { useMemo, useState } from "react";
import { setPartnerActive, deleteTestPartner } from "@/lib/actions";
import { ActionButton } from "@/components/ActionButton";
import { ContactLine } from "@/components/ContactLine";
import { BLOCKED_ROW_BG, ListSearchBox } from "@/components/ListSearchBox";
import { matchesSearch, sortActiveThenBlocked } from "@/lib/admin-lists";

export type RiderListItem = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  /** "Motorcycle · SBA1234X", or "No application on file". */
  vehicle: string;
};

export function RiderList({ riders }: { riders: RiderListItem[] }) {
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => sortActiveThenBlocked(riders, (r) => r.full_name, (r) => r.is_active), [riders]);
  const results = sorted.filter((r) => matchesSearch(query, [r.full_name, r.email, r.phone]));

  return (
    <>
      <ListSearchBox
        query={query}
        onChange={setQuery}
        placeholder="Search by name, email or phone…"
        label="Search riders"
        shown={results.length}
        total={riders.length}
        noun="riders"
      />
      <div className="space-y-2">
        {results.length === 0 && (
          <p className="rounded-2xl bg-white p-4 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
            No riders match “{query.trim()}”.
          </p>
        )}
        {results.map((r) => (
          <RiderRow key={r.id} rider={r} />
        ))}
      </div>
    </>
  );
}

function RiderRow({ rider: r }: { rider: RiderListItem }) {
  const blocked = !r.is_active;
  return (
    <div
      className="rounded-2xl p-4 shadow-lg"
      style={{ color: "var(--kb-ink)", background: blocked ? BLOCKED_ROW_BG : "white" }}
      data-blocked={blocked || undefined}
    >
      <div className="flex items-center justify-between">
        <div className={blocked ? "opacity-50" : undefined}>
          <p className="text-sm font-semibold">{r.full_name || "(no name on file)"}</p>
          <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
            {r.vehicle}
          </p>
          <div className="mt-1">
            <ContactLine phone={r.phone} email={r.email} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              background: r.is_active ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
              color: r.is_active ? "#16A34A" : "#DC2626",
            }}
          >
            {r.is_active ? "Active" : "Blocked"}
          </span>
          <ActionButton
            action={setPartnerActive.bind(null, r.id, !r.is_active)}
            label={r.is_active ? "Block" : "Reinstate"}
            pendingLabel="Saving…"
            background={r.is_active ? "var(--kb-danger)" : "var(--kb-green-deep)"}
          />
          <ActionButton
            action={deleteTestPartner.bind(null, r.id, "rider")}
            label="Delete"
            pendingLabel="Deleting…"
            background="var(--kb-cream)"
            color="var(--kb-danger)"
            confirmMessage={`Delete ${r.full_name || "this partner"}? This removes their profile, application, and kitchen/menu data.`}
          />
        </div>
      </div>
    </div>
  );
}
