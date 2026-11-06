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
import { getViewer, hasAdminRole } from "@/lib/require-admin";
import { fetchEmailsById } from "@/lib/contacts";
import { selectIn } from "@/lib/ops-data";
import { sortActiveThenBlocked } from "@/lib/admin-lists";
import { MERCHANT_LIST_KITCHEN_COLUMNS } from "@/lib/kitchen-columns";
import { setPartnerActive } from "@/lib/actions";
import { DeletePartnerButton } from "@/components/DeletePartnerButton";
import { MerchantRegion } from "@/components/RegionTag";
import { RegionFilterBar } from "@/components/RegionFilterBar";
import { countByRegion, filterByRegion, parseRegionFilter, REGION_LABEL, toRegion, type RegionCode } from "@/lib/regions";
import type { CookApplication, Profile } from "@/lib/types-auth";
import type { Kitchen } from "@/lib/types-kitchen";

/** Only the columns MERCHANT_LIST_KITCHEN_COLUMNS fetches. region is read-only (set by the database). */
type KitchenRow = Pick<Kitchen, "id" | "business_name" | "category" | "cuisine_type" | "is_live"> & { region: RegionCode | null };
type AddressRow = { kitchen_id: string; business_address: string | null; postal_code: string | null };

const COLUMNS = [
  { label: "Merchant" },
  { label: "Owner and contact" },
  { label: "Pickup address" },
  { label: "Postal code" },
  { label: "Region" },
  { label: "Listing" },
  { label: "Subscription" },
  { label: "Account" },
  { label: "Actions", align: "right" as const },
];

export default async function MerchantsPage({ searchParams }: { searchParams: Promise<{ q?: string; region?: string }> }) {
  const { q, region: regionParam } = await searchParams;
  const regionFilter = parseRegionFilter(regionParam);
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const [{ data: kitchenRows, error: kitchenError }, pending] = await Promise.all([
    supabase.from("kitchens").select(MERCHANT_LIST_KITCHEN_COLUMNS).returns<KitchenRow[]>(),
    loadPendingApplications<CookApplication>(supabase, "cook_applications"),
  ]);
  // Unknown values from the database count as "No region".
  const allKitchens = (kitchenRows ?? []).map((k) => ({ ...k, region: toRegion(k.region) }));
  const regionCounts = countByRegion(allKitchens);
  const kitchens = filterByRegion(allKitchens, regionFilter);
  const ids = kitchens.map((k) => k.id);

  const [owners, addresses, emailById] = await Promise.all([
    selectIn<Profile>(supabase, "profiles", "*", "id", ids),
    selectIn<AddressRow>(supabase, "kitchen_addresses", "kitchen_id, business_address, postal_code", "kitchen_id", ids),
    fetchEmailsById(supabase, ids),
  ]);
  const ownerById = new Map(owners.data.map((p) => [p.id, p]));
  const addressById = new Map(addresses.data.map((a) => [a.kitchen_id, a]));

  // A missing owner profile counts as blocked, as on the old Merchants list.
  const isActive = (k: KitchenRow) => ownerById.get(k.id)?.is_active ?? false;
  const rows: TableRow[] = sortActiveThenBlocked(kitchens, (k) => k.business_name, isActive).map((k) => {
    const owner = ownerById.get(k.id);
    const address = addressById.get(k.id);
    const email = emailById.get(k.id) ?? null;
    const active = isActive(k);
    return {
      id: k.id,
      muted: !active,
      search: [k.business_name, owner?.full_name, owner?.phone, email, address?.business_address, address?.postal_code, k.category, k.region ? REGION_LABEL[k.region] : null],
      cells: [
        <Cell key="m" main={k.business_name} sub={`${k.category} · ${k.cuisine_type}`} />,
        <div key="o" className="min-w-0">
          <p className="font-medium">{owner?.full_name || "(no name on file)"}</p>
          <ContactLine phone={owner?.phone} email={email} />
        </div>,
        <span key="a">{address?.business_address || <span style={{ color: "var(--oc-text-soft)" }}>Not given</span>}</span>,
        <span key="p" className="font-mono text-xs">{address?.postal_code || "—"}</span>,
        <MerchantRegion key="r" region={k.region} />,
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
          <DeletePartnerButton partnerId={k.id} role="cook" confirmName={k.business_name || null} />
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
      {!kitchenError && <RegionFilterBar active={regionFilter} counts={regionCounts} q={q} />}
      <Card className="overflow-hidden">
        <DataTable
          columns={COLUMNS}
          rows={rows}
          noun="merchants"
          initialQuery={q ?? ""}
          searchPlaceholder="Search name, owner, phone, email, address or postal code…"
          empty={
            regionFilter !== "all" && allKitchens.length > 0 ? (
              <EmptyState title={`No merchants in ${REGION_LABEL[regionFilter]}`}>Choose All to see every merchant.</EmptyState>
            ) : (
              <EmptyState>No kitchens yet. A kitchen appears once an approved cook sets it up in the Partner app.</EmptyState>
            )
          }
        />
      </Card>
    </AdminShell>
  );
}
