import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { ComplaintsRealtimeRefresher } from "@/components/ComplaintsRealtimeRefresher";
import { ThreadStatusButton, ThreadStatusBadge } from "@/components/ThreadStatus";
import { hasAdminRole, requireAdmin } from "@/lib/require-admin";
import {
  COMPLAINT_LIST_SCAN_LIMIT,
  formatSgTime,
  groupThreads,
  type ComplaintMessageRow,
} from "@/lib/complaints";

type OrderRow = {
  id: string;
  customer_id: string;
  order_status: string;
  created_at: string;
  kitchens: { business_name: string | null } | null;
};

type CustomerRow = { id: string; full_name: string | null; phone: string | null };

type StatusRow = { order_id: string; resolved_at: string };

type View = "active" | "resolved";

export default async function ComplaintsPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const view: View = (await searchParams).view === "resolved" ? "resolved" : "active";
  const { supabase, user } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const { data: messages, error } = await supabase
    .from("complaint_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(COMPLAINT_LIST_SCAN_LIMIT)
    .returns<ComplaintMessageRow[]>();

  if (error) {
    return (
      <AdminShell title="Complaints" subtitle="Customer support threads, one per order.">
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-danger)" }}>
          Couldn&apos;t load complaint threads: {error.message}
        </p>
      </AdminShell>
    );
  }

  const orderIds = [...new Set((messages ?? []).map((m) => m.order_id))];
  const [{ data: orders }, { data: statuses, error: statusError }] = orderIds.length
    ? await Promise.all([
        supabase
          .from("orders")
          .select("id, customer_id, order_status, created_at, kitchens(business_name)")
          .in("id", orderIds)
          .returns<OrderRow[]>(),
        supabase
          .from("complaint_threads")
          .select("order_id, resolved_at")
          .eq("status", "resolved")
          .in("order_id", orderIds)
          .returns<StatusRow[]>(),
      ])
    : [{ data: [] as OrderRow[] }, { data: [] as StatusRow[], error: null }];

  const orderById = new Map((orders ?? []).map((o) => [o.id, o]));
  const customerIds = [...new Set((orders ?? []).map((o) => o.customer_id))];
  const { data: customers } = customerIds.length
    ? await supabase.from("profiles").select("id, full_name, phone").in("id", customerIds).returns<CustomerRow[]>()
    : { data: [] as CustomerRow[] };
  const customerById = new Map((customers ?? []).map((c) => [c.id, c]));

  const customerByOrder = Object.fromEntries((orders ?? []).map((o) => [o.id, o.customer_id]));
  const resolvedAtByOrder = Object.fromEntries((statuses ?? []).map((t) => [t.order_id, t.resolved_at]));
  const everything = groupThreads(messages ?? [], customerByOrder, resolvedAtByOrder).flatMap((g) => g.threads);
  const resolvedCount = everything.filter((t) => t.resolved).length;
  const activeCount = everything.length - resolvedCount;
  const needsReply = everything.filter((t) => t.needsReply).length;
  const groups = groupThreads(messages ?? [], customerByOrder, resolvedAtByOrder, (t) =>
    view === "resolved" ? t.resolved : !t.resolved
  );

  const tabs: [View, string, string][] = [
    ["active", `Active (${activeCount})`, "/complaints"],
    ["resolved", `Resolved (${resolvedCount})`, "/complaints?view=resolved"],
  ];

  return (
    <AdminShell
      title="Complaints"
      subtitle="Customer support threads, one per order. Resolve a thread once the issue is settled — it comes back here if the customer writes again."
    >
      <ComplaintsRealtimeRefresher />

      <nav className="mb-4 flex flex-wrap items-center gap-2 text-sm" aria-label="Complaint thread filter">
        {tabs.map(([key, label, href]) => (
          <Link
            key={key}
            href={href}
            aria-current={view === key ? "page" : undefined}
            className="rounded-full px-3 py-1.5 font-medium"
            style={
              view === key
                ? { background: "var(--kb-green)", color: "var(--kb-navy)" }
                : { background: "var(--kb-navy-raised)", color: "var(--kb-on-navy-soft)" }
            }
          >
            {label}
          </Link>
        ))}
        {needsReply > 0 && (
          <span className="ml-1" style={{ color: "var(--kb-warn)" }}>
            {needsReply} awaiting HQ reply
          </span>
        )}
      </nav>

      {statusError && (
        <p className="mb-4 rounded-2xl bg-white p-4 text-sm shadow-lg" style={{ color: "var(--kb-danger)" }}>
          Couldn&apos;t load resolved status ({statusError.message}), so every thread is shown as active.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          {view === "resolved" ? (
            "No resolved threads yet."
          ) : everything.length === 0 ? (
            <>No complaint threads yet. They appear here when a customer taps &ldquo;Report an issue&rdquo; on an order.</>
          ) : (
            "No active threads — every complaint is resolved."
          )}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const customer = g.customerId ? customerById.get(g.customerId) : undefined;
            return (
              <section key={g.customerId ?? "unknown"} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                <header className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-semibold">
                    {customer?.full_name || (g.customerId ? `Customer ${g.customerId.slice(0, 8)}` : "Unknown customer")}
                    {customer?.phone && (
                      <span className="ml-2 font-normal" style={{ color: "var(--kb-ink-soft)" }}>
                        {customer.phone}
                      </span>
                    )}
                  </h2>
                  {g.needsReplyCount > 0 && (
                    <span className="shrink-0 text-xs font-semibold" style={{ color: "var(--kb-warn)" }}>
                      {g.needsReplyCount} awaiting reply
                    </span>
                  )}
                </header>
                <ul className="mt-3 divide-y" style={{ borderColor: "var(--kb-cream)" }}>
                  {g.threads.map((t) => {
                    const order = orderById.get(t.orderId);
                    const preview = t.lastMessage.body || (t.lastMessage.photo_path ? "📷 Photo" : "");
                    const fromCustomer = t.customerId !== null && t.lastMessage.sender_id === t.customerId;
                    return (
                      <li key={t.orderId} className="flex items-center gap-2">
                        <Link
                          href={`/complaints/${t.orderId}`}
                          className="flex min-w-0 flex-1 items-start justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-[var(--kb-cream)]"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              Order #{t.orderId.slice(0, 8)}
                              {order?.kitchens?.business_name && (
                                <span className="font-normal" style={{ color: "var(--kb-ink-soft)" }}>
                                  {" "}· {order.kitchens.business_name}
                                </span>
                              )}
                            </p>
                            <p className="mt-0.5 truncate text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                              <span className="font-semibold">{fromCustomer ? "Customer" : "HQ"}:</span> {preview}
                            </p>
                            <p className="mt-0.5 text-[11px]" style={{ color: "var(--kb-ink-soft)" }}>
                              {t.messageCount} message{t.messageCount === 1 ? "" : "s"}
                              {t.photoCount > 0 && ` · ${t.photoCount} photo${t.photoCount === 1 ? "" : "s"}`} ·{" "}
                              {formatSgTime(t.lastMessage.created_at)}
                            </p>
                          </div>
                          <ThreadStatusBadge thread={t} />
                        </Link>
                        <ThreadStatusButton orderId={t.orderId} thread={t} />
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </AdminShell>
  );
}
