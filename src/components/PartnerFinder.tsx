"use client";

import { useState } from "react";
import { setPartnerActive, deleteTestPartner } from "@/lib/actions";
import { ActionButton } from "@/components/ActionButton";
import { ContactLine } from "@/components/ContactLine";
import type { Profile } from "@/lib/types-auth";

type PartnerRole = "cook" | "rider" | "picker";

export type PartnerListItem = Profile & {
  role: PartnerRole;
  /** Kitchen business name, cooks only. */
  business_name: string | null;
  /** From auth.users via admin_user_emails; admin-only. */
  email: string | null;
};

const CATEGORIES: { role: PartnerRole; label: string; empty: string }[] = [
  { role: "cook", label: "Cooks", empty: "No approved cooks yet." },
  { role: "rider", label: "Riders", empty: "No approved riders yet." },
  { role: "picker", label: "Pickers", empty: "No approved pickers yet." },
];

export function PartnerFinder({ partners }: { partners: PartnerListItem[] }) {
  const [role, setRole] = useState<PartnerRole>("cook");
  const [query, setQuery] = useState("");

  const counts = { cook: 0, rider: 0, picker: 0 };
  for (const p of partners) counts[p.role]++;

  const category = CATEGORIES.find((c) => c.role === role)!;
  const needle = query.trim().toLowerCase();
  const inRole = partners.filter((p) => p.role === role);
  const results = needle
    ? inRole.filter(
        (p) =>
          p.full_name?.toLowerCase().includes(needle) ||
          p.business_name?.toLowerCase().includes(needle)
      )
    : inRole;

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as PartnerRole)}
          aria-label="Partner type"
          className="rounded-xl border bg-white px-3 py-2.5 text-sm sm:w-48"
          style={{ borderColor: "#E5E7EB", color: "var(--kb-ink)" }}
        >
          {CATEGORIES.map((c) => (
            <option key={c.role} value={c.role}>
              {c.label} ({counts[c.role]})
            </option>
          ))}
        </select>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={role === "cook" ? "Search by name or business name…" : "Search by name…"}
          aria-label={`Search ${category.label.toLowerCase()}`}
          className="flex-1 rounded-xl border bg-white px-3 py-2.5 text-sm"
          style={{ borderColor: "#E5E7EB", color: "var(--kb-ink)" }}
        />
      </div>

      <p className="mt-4 text-xs" style={{ color: "var(--kb-on-navy-soft)" }}>
        {needle
          ? `${results.length} of ${inRole.length} ${category.label.toLowerCase()} match “${query.trim()}”`
          : `${inRole.length} ${category.label.toLowerCase()}`}
      </p>

      <div className="mt-2 space-y-2">
        {results.length === 0 && (
          <p className="rounded-2xl bg-white p-4 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
            {needle ? `No ${category.label.toLowerCase()} match “${query.trim()}”.` : category.empty}
          </p>
        )}
        {results.map((p) => (
          <PartnerRow key={p.id} profile={p} />
        ))}
      </div>
    </>
  );
}

function PartnerRow({ profile }: { profile: PartnerListItem }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
      <div>
        <p className="text-sm font-semibold">{profile.full_name || "(no name on file)"}</p>
        {profile.business_name && (
          <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
            {profile.business_name}
          </p>
        )}
        <ContactLine phone={profile.phone} email={profile.email} />
        <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
          {profile.is_active ? "Active" : "Blocked"}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <ActionButton
          action={setPartnerActive.bind(null, profile.id, !profile.is_active)}
          label={profile.is_active ? "Block" : "Reinstate"}
          pendingLabel="Saving…"
          background={profile.is_active ? "var(--kb-danger)" : "var(--kb-green-deep)"}
        />
        <ActionButton
          action={deleteTestPartner.bind(null, profile.id, profile.role)}
          label="Delete"
          pendingLabel="Deleting…"
          background="var(--kb-cream)"
          color="var(--kb-danger)"
          confirmMessage={`Delete ${profile.full_name || "this partner"}? This removes their profile, application, and kitchen/menu data.`}
        />
      </div>
    </div>
  );
}
