import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Cell, DataTable, type TableRow } from "@/components/ops/DataTable";
import { Card, EmptyState, LoadError } from "@/components/ops/EmptyState";
import { StatusPill } from "@/components/ops/StatusPill";
import { getViewer, hasAdminRole } from "@/lib/require-admin";
import {
  ASSISTED_SHOP_LIST_COLUMNS,
  CATEGORY_LABEL,
  formatMobile,
  formatSgt,
  SHOP_STATUS_LABEL,
  type AssistedShopListRow,
} from "@/lib/assisted-onboarding";

const COLUMNS = [{ label: "Shop" }, { label: "Owner" }, { label: "Status" }, { label: "Created" }, { label: "Actions", align: "right" as const }];

const STATUS_TONE = { draft: "amber", claimed: "green", cancelled: "grey" } as const;

export default async function AssistedShopsPage() {
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const { data, error } = await supabase
    .from("assisted_shops")
    .select(ASSISTED_SHOP_LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<AssistedShopListRow[]>();
  const shops = data ?? [];

  const rows: TableRow[] = shops.map((s) => ({
    id: s.id,
    search: [s.business_name, s.owner_name, s.owner_mobile, CATEGORY_LABEL[s.category], SHOP_STATUS_LABEL[s.status]],
    rowHref: `/merchants/assisted/${s.id}`,
    muted: s.status === "cancelled",
    cells: [
      <Cell key="shop" main={s.business_name} sub={CATEGORY_LABEL[s.category] ?? s.category} />,
      <Cell key="owner" main={s.owner_name} sub={formatMobile(s.owner_mobile)} />,
      <Cell
        key="status"
        main={<StatusPill tone={STATUS_TONE[s.status] ?? "grey"}>{SHOP_STATUS_LABEL[s.status] ?? s.status}</StatusPill>}
        sub={s.claimed_at ? `Claimed ${formatSgt(s.claimed_at)}` : s.cancelled_at ? `Cancelled ${formatSgt(s.cancelled_at)}` : null}
      />,
      <span key="created" className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
        {formatSgt(s.created_at)}
      </span>,
      <div key="actions" className="flex justify-end gap-3">
        {s.claimed_user_id && (
          <Link href={`/merchants/${s.claimed_user_id}/edit`} className="text-sm font-medium underline" style={{ color: "var(--oc-accent)" }}>
            Kitchen
          </Link>
        )}
        <Link href={`/merchants/assisted/${s.id}`} className="text-sm font-medium underline" style={{ color: "var(--oc-accent)" }}>
          Open
        </Link>
      </div>,
    ],
  }));

  return (
    <AdminShell
      title="Assisted onboarding"
      subtitle="Set up a shop for an owner who has no Google account or email, then send them a one-time claim link on WhatsApp. They add their own PayNow after claiming, and the shop goes live."
      actions={
        <Link
          href="/merchants/assisted/new"
          className="rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--oc-accent)" }}
        >
          New assisted shop
        </Link>
      }
    >
      {error && <LoadError what="assisted shops" message={error.message} />}
      <Card>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          noun="shops"
          searchPlaceholder="Search by shop, owner or mobile"
          empty={<EmptyState title="No assisted shops yet">Tap New assisted shop to set one up.</EmptyState>}
        />
      </Card>
    </AdminShell>
  );
}
