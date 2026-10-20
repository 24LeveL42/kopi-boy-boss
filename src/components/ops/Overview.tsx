import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AdminShell } from "../AdminShell";
import { Card, EmptyState, LoadError } from "./EmptyState";
import { StatusPill } from "./StatusPill";
import { Age } from "./Ticking";
import { LiveRefresher } from "./LiveRefresher";
import { loadNames, loadOrderRows, renderTime, type OrderRow } from "@/lib/ops-data";
import {
  ATTENTION_TONE,
  FEED_TONE,
  LIVE_STAGES,
  STAGE_LABEL,
  STAGE_TONE,
  countStages,
  isLiveStage,
  latestEvents,
  orderAttention,
  orderEvents,
  ridersOnDelivery,
  sgDayStartIso,
  shortId,
  sortAttention,
  type AttentionKind,
  type FeedEvent,
} from "@/lib/ops";
import { senderRoleLabel, type AdminMessageRow } from "@/lib/admin-messages";
import { groupThreads, type ComplaintMessageRow } from "@/lib/complaints";

/** How many recent complaint messages the attention list scans for threads awaiting HQ. */
const COMPLAINT_SCAN_LIMIT = 500;
const FEED_LENGTH = 14;

type AttentionItem = {
  key: string;
  kind: AttentionKind;
  since: string;
  title: string;
  detail: string;
  href: string;
  action: string;
};

const ATTENTION_LABEL: Record<AttentionKind, string> = {
  payment_overdue: "Payment overdue",
  no_rider: "No rider",
  rider_released: "Rider released",
  complaint_reply: "Complaint",
  cook_slow: "Cook not responding",
  message_open: "Message",
  merchant_application: "To approve",
  rider_application: "To approve",
};

function orderAttentionText(kind: AttentionKind, r: OrderRow): Pick<AttentionItem, "title" | "detail"> {
  const id = shortId(r.order.id);
  switch (kind) {
    case "payment_overdue":
      return { title: `Order ${id} not paid in time`, detail: `${r.customer} → ${r.merchant} · PayNow window passed` };
    case "cook_slow":
      return { title: `Order ${id} waiting for the cook`, detail: `${r.merchant} hasn't accepted or rejected it` };
    case "no_rider":
      return { title: `Order ${id} has no rider`, detail: `${r.merchant} asked for a rider and nobody has taken it` };
    case "rider_released":
      return { title: `Rider dropped order ${id}`, detail: `${r.rider ?? "The rider"} released the job · ${r.merchant}` };
    default:
      return { title: `Order ${id}`, detail: r.merchant };
  }
}

function feedText(e: FeedEvent, r: OrderRow): string {
  const id = shortId(r.order.id);
  const rider = e.riderId && e.riderId === r.delivery?.rider_id && r.rider ? r.rider : "A rider";
  switch (e.kind) {
    case "placed":
      return `${r.customer} placed order ${id} at ${r.merchant}`;
    case "accepted":
      return `${r.merchant} accepted order ${id}`;
    case "rejected":
      return `${r.merchant} rejected order ${id}`;
    case "cancelled":
      return `${r.customer} cancelled order ${id}`;
    case "paid":
      return `${r.merchant} marked order ${id} paid`;
    case "ready":
      return `${r.merchant} marked order ${id} ready`;
    case "rider_assigned":
      return `${rider} took the delivery for order ${id}`;
    case "delivered":
      return `${rider} delivered order ${id}`;
  }
}

function Kpi({ href, label, value, hint }: { href: string; label: string; value: number | null; hint?: string }) {
  return (
    <Link
      href={href}
      className="group rounded-[14px] border px-4 py-4 transition-colors hover:border-[var(--oc-accent)]"
      style={{ background: "var(--oc-card)", borderColor: "var(--oc-line)" }}
    >
      <p className="text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
        {label}
      </p>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight" style={{ color: "var(--oc-text)" }}>
        {value ?? "—"}
      </p>
      <p className="mt-1 text-xs group-hover:underline" style={{ color: hint ? "var(--oc-text-soft)" : "var(--oc-accent)" }}>
        {hint ?? "Open →"}
      </p>
    </Link>
  );
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
      <h2 className="text-sm font-semibold">{children}</h2>
      {aside}
    </header>
  );
}

export async function Overview() {
  const supabase = await createClient();
  const now = renderTime();
  const todayStart = sgDayStartIso(now);

  const [live, recent, deliveredToday, pendingCooks, pendingRiders, openMessages, openMessageCount, complaintMessages] =
    await Promise.all([
      loadOrderRows(supabase, "live"),
      loadOrderRows(supabase, "recent"),
      supabase
        .from("delivery_requests")
        .select("*", { count: "exact", head: true })
        .eq("status", "completed")
        .gte("completed_at", todayStart),
      supabase
        .from("cook_applications")
        .select("id, user_id, business_name, created_at")
        .eq("status", "pending")
        .returns<{ id: string; user_id: string; business_name: string; created_at: string }[]>(),
      supabase
        .from("rider_applications")
        .select("id, user_id, vehicle_type, created_at")
        .eq("status", "pending")
        .returns<{ id: string; user_id: string; vehicle_type: string | null; created_at: string }[]>(),
      supabase
        .from("admin_messages")
        .select("*")
        .eq("status", "open")
        .order("created_at", { ascending: true })
        .limit(50)
        .returns<AdminMessageRow[]>(),
      supabase.from("admin_messages").select("*", { count: "exact", head: true }).eq("status", "open"),
      supabase
        .from("complaint_messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(COMPLAINT_SCAN_LIMIT)
        .returns<ComplaintMessageRow[]>(),
    ]);

  const liveRows = live.rows.filter((r) => isLiveStage(r.stage));

  // Threads awaiting HQ, worked out exactly as on /complaints.
  const complaintOrderIds = [...new Set((complaintMessages.data ?? []).map((m) => m.order_id))];
  const [complaintOrders, resolved] = complaintOrderIds.length
    ? await Promise.all([
        supabase.from("orders").select("id, customer_id").in("id", complaintOrderIds).returns<{ id: string; customer_id: string }[]>(),
        supabase
          .from("complaint_threads")
          .select("order_id, resolved_at")
          .eq("status", "resolved")
          .in("order_id", complaintOrderIds)
          .returns<{ order_id: string; resolved_at: string }[]>(),
      ])
    : [{ data: [] }, { data: [] }];
  const threadsAwaitingReply = groupThreads(
    complaintMessages.data ?? [],
    Object.fromEntries((complaintOrders.data ?? []).map((o) => [o.id, o.customer_id])),
    Object.fromEntries((resolved.data ?? []).map((t) => [t.order_id, t.resolved_at])),
    (t) => t.needsReply
  ).flatMap((g) => g.threads);

  const people = await loadNames(supabase, [], [
    ...(openMessages.data ?? []).map((m) => m.sender_id),
    ...(pendingRiders.data ?? []).map((a) => a.user_id),
    ...threadsAwaitingReply.flatMap((t) => (t.customerId ? [t.customerId] : [])),
  ]);
  const nameOf = (id: string | null, fallback: string) => (id && people.profile.get(id)?.full_name) || fallback;

  const attention: AttentionItem[] = [];
  for (const r of liveRows) {
    const flag = orderAttention(r.order, r.delivery, now);
    if (!flag) continue;
    attention.push({
      key: `order:${r.order.id}`,
      ...flag,
      ...orderAttentionText(flag.kind, r),
      href: `/orders?q=${r.order.id.slice(0, 8)}`,
      action: "View order",
    });
  }
  for (const t of threadsAwaitingReply) {
    attention.push({
      key: `complaint:${t.orderId}`,
      kind: "complaint_reply",
      since: t.lastMessage.created_at,
      title: `${nameOf(t.customerId, "A customer")} is waiting for a reply`,
      detail: `Order ${shortId(t.orderId)} · “${t.lastMessage.body || "📷 Photo"}”`,
      href: `/complaints/${t.orderId}`,
      action: "Reply",
    });
  }
  for (const m of openMessages.data ?? []) {
    attention.push({
      key: `message:${m.id}`,
      kind: "message_open",
      since: m.created_at,
      title: `Message from ${nameOf(m.sender_id, "a partner")} (${senderRoleLabel(m.sender_role)})`,
      detail: m.message,
      href: "/messages",
      action: "Reply",
    });
  }
  for (const a of pendingCooks.data ?? []) {
    attention.push({
      key: `cook:${a.id}`,
      kind: "merchant_application",
      since: a.created_at,
      title: `New merchant: ${a.business_name}`,
      detail: "Check the business details and UEN, then approve or reject",
      href: "/merchants",
      action: "Review",
    });
  }
  for (const a of pendingRiders.data ?? []) {
    attention.push({
      key: `rider:${a.id}`,
      kind: "rider_application",
      since: a.created_at,
      title: `New rider: ${nameOf(a.user_id, "applicant")}`,
      detail: `${a.vehicle_type || "No vehicle given"} · check the photo, then approve or reject`,
      href: "/riders",
      action: "Review",
    });
  }
  const sortedAttention = sortAttention(attention);

  // Live orders can also be among the newest ones, so merge by id before building the feed.
  const feedRows = new Map<string, OrderRow>();
  for (const r of [...recent.rows, ...live.rows]) feedRows.set(r.order.id, r);
  const feed = latestEvents(
    [...feedRows.values()].flatMap((r) => orderEvents(r.order, r.deliveries)),
    FEED_LENGTH
  );

  const stageCounts = countStages(liveRows.map((r) => r.stage));
  const errors = [
    live.error && ["live orders", live.error],
    recent.error && ["recent orders", recent.error],
    deliveredToday.error && ["today's deliveries", deliveredToday.error.message],
    pendingCooks.error && ["merchant applications", pendingCooks.error.message],
    pendingRiders.error && ["rider applications", pendingRiders.error.message],
    openMessages.error && ["messages", openMessages.error.message],
    complaintMessages.error && ["complaints", complaintMessages.error.message],
  ].filter((e): e is [string, string] => Boolean(e));

  return (
    <AdminShell
      title="Overview"
      subtitle="What's happening on Kopi Boy right now."
      actions={
        <LiveRefresher
          tables={["orders", "delivery_requests", "admin_messages", "cook_applications", "rider_applications", "complaint_messages"]}
          channel="overview"
        />
      }
    >
      {errors.map(([what, message]) => (
        <LoadError key={what} what={what} message={message} />
      ))}

      <div className="grid grid-cols-6 gap-3">
        <Kpi href="/orders" label="Live orders" value={liveRows.length} />
        <Kpi href="/riders" label="Riders on a delivery" value={ridersOnDelivery(liveRows.flatMap((r) => r.deliveries)).size} />
        <Kpi href="/orders/past" label="Delivered today" value={deliveredToday.count} />
        <Kpi href="/refunds" label="Open refund cases" value={null} hint="No data source yet" />
        <Kpi href="/merchants" label="Merchants to approve" value={pendingCooks.data?.length ?? null} />
        <Kpi href="/messages" label="Unread messages" value={openMessageCount.count} />
      </div>

      <div className="mt-6 grid grid-cols-3 gap-6">
        <Card className="col-span-2 overflow-hidden">
          <SectionTitle aside={<span className="text-xs" style={{ color: "var(--oc-text-soft)" }}>Most urgent first</span>}>
            Needs your attention {sortedAttention.length > 0 && `(${sortedAttention.length})`}
          </SectionTitle>
          {sortedAttention.length === 0 ? (
            <EmptyState title="All clear">Nothing is waiting on HQ right now.</EmptyState>
          ) : (
            <ul>
              {sortedAttention.map((item) => (
                <li
                  key={item.key}
                  className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
                  style={{ borderColor: "var(--oc-line)" }}
                >
                  <div className="w-36 shrink-0">
                    <StatusPill tone={ATTENTION_TONE[item.kind]}>{ATTENTION_LABEL[item.kind]}</StatusPill>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="truncate text-xs" style={{ color: "var(--oc-text-soft)" }}>
                      {item.detail}
                    </p>
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs" style={{ color: "var(--oc-text-soft)" }}>
                    <Age since={item.since} serverNow={now} />
                  </span>
                  <Link
                    href={item.href}
                    className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                    style={{ background: "var(--oc-accent)" }}
                  >
                    {item.action}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle>Live activity</SectionTitle>
          {feed.length === 0 ? (
            <EmptyState>Order events show up here as they happen.</EmptyState>
          ) : (
            <ol>
              {feed.map((e) => {
                const row = feedRows.get(e.orderId)!;
                return (
                  <li key={e.key} className="flex gap-3 border-b px-4 py-2.5 last:border-b-0" style={{ borderColor: "var(--oc-line)" }}>
                    <span
                      aria-hidden
                      className="mt-1.5 size-2 shrink-0 rounded-full"
                      style={{ background: `var(--oc-${FEED_TONE[e.kind]}-fg)` }}
                    />
                    <div className="min-w-0">
                      <p className="text-sm">{feedText(e, row)}</p>
                      <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
                        <Age since={e.at} serverNow={now} /> ago
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden">
        <SectionTitle>Order pipeline right now</SectionTitle>
        <div className="flex items-stretch gap-2 p-4">
          {LIVE_STAGES.map((stage, i) => (
            <div key={stage} className="flex flex-1 items-center gap-2">
              <Link
                href={`/orders?stage=${stage}`}
                className="flex-1 rounded-xl border px-4 py-3 transition-colors hover:border-[var(--oc-accent)]"
                style={{ borderColor: "var(--oc-line)", background: "var(--oc-bg)" }}
              >
                <StatusPill tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</StatusPill>
                <p className="mt-2 text-2xl font-semibold tabular-nums">{stageCounts[stage]}</p>
              </Link>
              {i < LIVE_STAGES.length - 1 && (
                <span aria-hidden style={{ color: "var(--oc-text-soft)" }}>
                  →
                </span>
              )}
            </div>
          ))}
        </div>
      </Card>
    </AdminShell>
  );
}
