"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { setPartnerActive, deleteTestPartner } from "@/lib/actions";
import { ActionButton } from "@/components/ActionButton";
import { ContactLine } from "@/components/ContactLine";
import { BLOCKED_ROW_BG, ListSearchBox } from "@/components/ListSearchBox";
import { matchesSearch, sortActiveThenBlocked } from "@/lib/admin-lists";

export type MerchantListItem = {
  id: string;
  business_name: string;
  category: string;
  neighbourhood: string;
  description: string | null;
  owner_name: string | null;
  phone: string | null;
  email: string | null;
  /** From the owner's profile; a missing profile counts as blocked, as before. */
  is_active: boolean;
};

export function MerchantList({ merchants }: { merchants: MerchantListItem[] }) {
  const [query, setQuery] = useState("");
  const sorted = useMemo(
    () => sortActiveThenBlocked(merchants, (m) => m.business_name, (m) => m.is_active),
    [merchants]
  );
  const results = sorted.filter((m) =>
    matchesSearch(query, [m.business_name, m.owner_name, m.email, m.phone])
  );

  return (
    <>
      <ListSearchBox
        query={query}
        onChange={setQuery}
        placeholder="Search by business name, owner, email or phone…"
        label="Search merchants"
        shown={results.length}
        total={merchants.length}
        noun="merchants"
      />
      <div className="space-y-2">
        {results.length === 0 && (
          <p className="rounded-2xl bg-white p-4 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
            No merchants match “{query.trim()}”.
          </p>
        )}
        {results.map((k) => (
          <MerchantRow key={k.id} merchant={k} />
        ))}
      </div>
    </>
  );
}

function MerchantRow({ merchant: k }: { merchant: MerchantListItem }) {
  const blocked = !k.is_active;
  return (
    <div
      className="rounded-2xl p-4 shadow-lg"
      style={{ color: "var(--kb-ink)", background: blocked ? BLOCKED_ROW_BG : "white" }}
      data-blocked={blocked || undefined}
    >
      <div className="flex items-center justify-between">
        <div className={blocked ? "opacity-50" : undefined}>
          <p className="text-sm font-semibold">{k.business_name}</p>
          <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
            {k.category} · {k.neighbourhood}
            {k.owner_name && ` · ${k.owner_name}`}
          </p>
          <div className="mt-1">
            <ContactLine phone={k.phone} email={k.email} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              background: k.is_active ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
              color: k.is_active ? "#16A34A" : "#DC2626",
            }}
          >
            {k.is_active ? "Active" : "Blocked"}
          </span>
          <Link
            href={`/merchants/${k.id}/edit`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
            style={{ background: "var(--kb-purple)" }}
          >
            Edit
          </Link>
          <ActionButton
            action={setPartnerActive.bind(null, k.id, !k.is_active)}
            label={k.is_active ? "Block" : "Reinstate"}
            pendingLabel="Saving…"
            background={k.is_active ? "var(--kb-danger)" : "var(--kb-green-deep)"}
          />
          <ActionButton
            action={deleteTestPartner.bind(null, k.id, "cook")}
            label="Delete"
            pendingLabel="Deleting…"
            background="var(--kb-cream)"
            color="var(--kb-danger)"
            confirmMessage={`Delete ${k.business_name}? This removes their profile, application, and kitchen/menu data.`}
          />
        </div>
      </div>
      {k.description && (
        <p className={`mt-2 text-xs ${blocked ? "opacity-50" : ""}`} style={{ color: "var(--kb-ink-soft)" }}>
          {k.description}
        </p>
      )}
    </div>
  );
}
