import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { ActionButton } from "@/components/ActionButton";
import { ContactLine } from "@/components/ContactLine";
import { Cell, DataTable, type TableRow } from "@/components/ops/DataTable";
import { Card, EmptyState, LoadError } from "@/components/ops/EmptyState";
import { ActivePill, StatusPill } from "@/components/ops/StatusPill";
import { loadPendingApplications, PendingCookApplications } from "@/components/ops/PendingApplications";
import { requireAdmin } from "@/lib/require-admin";
import { fetchEmailsById } from "@/lib/contacts";
import { selectIn } from "@/lib/ops-data";
import { sortActiveThenBlocked } from "@/lib/admin-lists";
import { deleteTestPartner, setPartnerActive } from "@/lib/actions";
import type { CookApplication, Profile } from "@/lib/types-auth";
import type { Kitchen } from "@/lib/types-kitchen";

type AddressRow = { kitchen_id: string; business_address: string | null; postal_code: string | null };

const COLUMNS = [
  { label: "Merchant" },
  { label: "Owner and contact" },
  { label: "Pickup address" },
  { label: "Postal code" },
  { label: "Listing" },
  { label: "Subscription" },
  { label: "Account" },
  { label: "Actions", align: "right" as const },
];

export default async function MerchantsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const [{ data: kitchenRows, error: kitchenError }, pending] = await Promise.all([
    supabase.from("kitchens").select("*").returns<Kitchen[]>(),
    loadPendingApplications<CookApplication>(supabase, "cook_applications"),
  ]);
  const kitchens = kitchenRows ?? [];
  const ids = kitchens.map((k) => k.id);

  const [owners, addresses, emailById] = await Promise.all([
    selectIn<Profile>(supabase, "profiles", "*", "id", ids),
    selectIn<AddressRow>(supabase, "kitchen_addresses", "kitchen_id, business_address, postal_code", "kitchen_id", ids),
    fetchEmailsById(supabase, ids),
  ]);
  const ownerById = new Map(owners.data.map((p) => [p.id, p]));
  const addressById = new Map(addresses.data.map((a) => [a.kitchen_id, a]));

  // A missing owner profile counts as blocked, as on the old Merchants list.
  const isActive = (k: Kitchen) => ownerById.get(k.id)?.is_active ?? false;
  const rows: TableRow[] = sortActiveThenBlocked(kitchens, (k) => k.business_name, isActive).map((k) => {
    const owner = ownerById.get(k.id);
    const address = addressById.get(k.id);
    const email = emailById.get(k.id) ?? null;
    const active = isActive(k);
    return {
      id: k.id,
      muted: !active,
      search: [k.business_name, owner?.full_name, owner?.phone, email, address?.business_address, address?.postal_code, k.category],
      cells: [
        <Cell key="m" main={k.business_name} sub={`${k.category} · ${k.cuisine_type}`} />,
        <div key="o" className="min-w-0">
          <p className="font-medium">{owner?.full_name || "(no name on file)"}</p>
          <ContactLine phone={owner?.phone} email={email} />
        </div>,
        <span key="a">{address?.business_address || <span style={{ color: "var(--oc-text-soft)" }}>Not given</span>}</span>,
        <span key="p" className="font-mono text-xs">{address?.postal_code || "—"}</span>,
        k.is_live ? (
          <StatusPill key="l" tone="green" title="kitchens.is_live: shown in the Customer app">Live</StatusPill>
        ) : (
          <StatusPill key="l" tone="grey" title="kitchens.is_live: hidden from the Customer app">Hidden</StatusPill>
        ),
        <span key="s" style={{ color: "var(--oc-text-soft)" }} title="No subscription records in the database yet">—</span>,
        <ActivePill key="st" active={active} />,
        <div key="x" className="flex justify-end gap-2">
          <Link
            href={`/merchants/${k.id}/edit`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
            style={{ background: "var(--oc-accent)" }}
          >
            Edit
          </Link>
          <ActionButton
            action={setPartnerActive.bind(null, k.id, !active)}
            label={active ? "Block" : "Reinstate"}
            pendingLabel="Saving…"
            background={active ? "var(--kb-danger)" : "var(--kb-green-deep)"}
          />
          <ActionButton
            action={deleteTestPartner.bind(null, k.id, "cook")}
            label="Delete"
            pendingLabel="Deleting…"
            background="var(--oc-grey-bg)"
            color="var(--kb-danger)"
            confirmMessage={`Delete ${k.business_name}? This removes their profile, application, and kitchen/menu data.`}
          />
        </div>,
      ],
    };
  });

  return (
    <AdminShell
      title="Merchants and addresses"
      subtitle="Every kitchen on Kopi Boy with its private pickup address. Listing shows whether the kitchen is live in the Customer app."
    >
      {kitchenError && <LoadError what="kitchens" message={kitchenError.message} />}
      {addresses.error && <LoadError what="pickup addresses" message={addresses.error} />}
      {pending.error && <LoadError what="merchant applications" message={pending.error} />}
      <PendingCookApplications loaded={pending} />
      <Card className="overflow-hidden">
        <DataTable
          columns={COLUMNS}
          rows={rows}
          noun="merchants"
          initialQuery={q ?? ""}
          searchPlaceholder="Search name, owner, phone, email, address or postal code…"
          empty={<EmptyState>No kitchens yet. A kitchen appears once an approved cook sets it up in the Partner app.</EmptyState>}
        />
      </Card>
    </AdminShell>
  );
}
