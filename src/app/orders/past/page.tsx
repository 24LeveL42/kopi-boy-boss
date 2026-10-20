import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Cell, DataTable, type TableRow } from "@/components/ops/DataTable";
import { Card, EmptyState, LoadError } from "@/components/ops/EmptyState";
import { StatusPill } from "@/components/ops/StatusPill";
import { requireAdmin } from "@/lib/require-admin";
import { loadOrderRows, PAST_ORDER_LIMIT } from "@/lib/ops-data";
import { formatSgd, isLiveStage, pastOutcome, shortId, STAGE_TONE } from "@/lib/ops";
import { formatSgTime } from "@/lib/complaints";

const COLUMNS = [
  { label: "Order" },
  { label: "Merchant" },
  { label: "Customer" },
  { label: "Rider" },
  { label: "Outcome" },
  { label: "Total", align: "right" as const },
  { label: "Finished", align: "right" as const },
];

export default async function PastOrdersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const { rows: recent, error } = await loadOrderRows(supabase, "recent");
  const past = recent.filter((r) => !isLiveStage(r.stage));

  const rows: TableRow[] = past.map((r) => {
    const { order } = r;
    const outcome = pastOutcome(r.stage);
    // Delivered: when the rider completed it. Rejected/cancelled: decided_at.
    const finishedAt = r.stage === "delivered" ? r.delivery?.completed_at : order.decided_at;
    return {
      id: order.id,
      search: [shortId(order.id), order.id, r.merchant, r.customer, r.customerPhone, r.rider, outcome],
      cells: [
        <Cell key="o" main={<span className="font-mono">{shortId(order.id)}</span>} sub={`Placed ${formatSgTime(order.created_at)}`} />,
        <span key="m">{r.merchant}</span>,
        <Cell key="c" main={r.customer} sub={r.customerPhone} />,
        r.rider ? <span key="r">{r.rider}</span> : <span key="r" style={{ color: "var(--oc-text-soft)" }}>—</span>,
        <div key="s" className="flex flex-wrap items-center gap-1.5">
          <StatusPill tone={STAGE_TONE[r.stage]}>{outcome}</StatusPill>
          {r.stage === "delivered" && (
            <Link
              href={`/orders/${order.id}/route`}
              className="rounded-lg px-2.5 py-1 text-xs font-medium text-white"
              style={{ background: "var(--oc-accent)" }}
            >
              Replay route
            </Link>
          )}
          {r.stage !== "delivered" && order.payment_status === "paid" && (
            <StatusPill tone="amber" title="payment_status is 'paid' on an order that didn't complete">Was paid</StatusPill>
          )}
        </div>,
        <span key="t" className="tabular-nums">{formatSgd(order.subtotal)}</span>,
        <span key="f" style={{ color: "var(--oc-text-soft)" }}>{finishedAt ? formatSgTime(finishedAt) : "—"}</span>,
      ],
    };
  });

  return (
    <AdminShell
      title="Past orders"
      subtitle={`Delivered, rejected and cancelled orders from the newest ${PAST_ORDER_LIMIT} orders. Only cooks reject an order; only customers cancel one.`}
    >
      {error && <LoadError what="orders" message={error} />}
      <Card className="overflow-hidden">
        <DataTable
          columns={COLUMNS}
          rows={rows}
          noun="past orders"
          initialQuery={q ?? ""}
          searchPlaceholder="Search order id, merchant, customer, rider or outcome…"
          empty={<EmptyState>No finished orders yet.</EmptyState>}
        />
      </Card>
    </AdminShell>
  );
}
