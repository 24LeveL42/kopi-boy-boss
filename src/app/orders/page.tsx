import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Cell, DataTable, type TableRow } from "@/components/ops/DataTable";
import { Card, EmptyState, LoadError } from "@/components/ops/EmptyState";
import { StatusPill } from "@/components/ops/StatusPill";
import { Age, PaymentCountdown } from "@/components/ops/Ticking";
import { LiveRefresher } from "@/components/ops/LiveRefresher";
import { requireAdmin } from "@/lib/require-admin";
import { loadOrderRows, renderTime } from "@/lib/ops-data";
import {
  formatSgd,
  isLiveStage,
  shortId,
  LIVE_STAGES,
  STAGE_LABEL,
  STAGE_TONE,
  PAYMENT_WINDOW_MINUTES,
  type OrderStage,
} from "@/lib/ops";
import { formatSgTime } from "@/lib/complaints";

const COLUMNS = [
  { label: "Order" },
  { label: "Merchant" },
  { label: "Customer" },
  { label: "Rider" },
  { label: "Status" },
  { label: "Total", align: "right" as const },
  { label: "Age", align: "right" as const },
];

export default async function LiveOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; stage?: string }>;
}) {
  const { q, stage: stageParam } = await searchParams;
  // ?stage= comes from the Overview pipeline; anything that isn't a live stage is ignored.
  const stage = LIVE_STAGES.find((s) => s === stageParam) as OrderStage | undefined;
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const now = renderTime();
  const { rows: all, error } = await loadOrderRows(supabase, "live");
  const live = all.filter((r) => isLiveStage(r.stage) && (!stage || r.stage === stage));

  const rows: TableRow[] = live.map((r) => {
    const { order } = r;
    const fee = order.delivery_fee_estimate;
    return {
      id: order.id,
      search: [shortId(order.id), order.id, r.merchant, r.customer, r.customerPhone, r.rider, STAGE_LABEL[r.stage]],
      cells: [
        <Cell key="o" main={<span className="font-mono">{shortId(order.id)}</span>} sub={formatSgTime(order.created_at)} />,
        <span key="m">{r.merchant}</span>,
        <Cell key="c" main={r.customer} sub={r.customerPhone} />,
        r.rider ? <span key="r">{r.rider}</span> : <span key="r" style={{ color: "var(--oc-text-soft)" }}>—</span>,
        <div key="s" className="flex flex-wrap items-center gap-1.5">
          <StatusPill tone={STAGE_TONE[r.stage]}>{STAGE_LABEL[r.stage]}</StatusPill>
          {r.stage === "awaiting_payment" && <PaymentCountdown decidedAt={order.decided_at} serverNow={now} />}
          {r.delivery?.status === "release_requested" && <StatusPill tone="red">Rider released</StatusPill>}
        </div>,
        <Cell
          key="t"
          main={<span className="tabular-nums">{formatSgd(order.subtotal)}</span>}
          sub={fee != null ? `+ ${formatSgd(fee)} delivery (est.)` : undefined}
        />,
        <Age key="a" since={order.created_at} serverNow={now} />,
      ],
    };
  });

  return (
    <AdminShell
      title="Live orders"
      subtitle={`Every order not yet delivered, rejected or cancelled. The customer has ${PAYMENT_WINDOW_MINUTES} minutes to pay by PayNow once the cook accepts.`}
    >
      {error && <LoadError what="orders" message={error} />}
      {stage && (
        <p className="mb-4 flex items-center gap-2 text-sm">
          Showing only <StatusPill tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</StatusPill>
          <Link href="/orders" className="font-medium underline" style={{ color: "var(--oc-accent)" }}>
            Show all live orders
          </Link>
        </p>
      )}
      <Card className="overflow-hidden">
        <DataTable
          key={`${stage ?? ""}|${q ?? ""}`}
          columns={COLUMNS}
          rows={rows}
          noun="live orders"
          initialQuery={q ?? ""}
          searchPlaceholder="Search order id, merchant, customer, phone, rider or status…"
          toolbar={<LiveRefresher tables={["orders", "delivery_requests"]} channel="live-orders" />}
          empty={
            <EmptyState title={stage ? `No orders ${STAGE_LABEL[stage].toLowerCase()} right now` : "No live orders right now"}>
              New orders appear here as soon as a customer checks out.
            </EmptyState>
          }
        />
      </Card>
    </AdminShell>
  );
}
