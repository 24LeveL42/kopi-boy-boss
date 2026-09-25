import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { ComplaintsRealtimeRefresher } from "@/components/ComplaintsRealtimeRefresher";
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

export default async function ComplaintsPage() {
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
  const { data: orders } = orderIds.length
    ? await supabase
        .from("orders")
        .select("id, customer_id, order_status, created_at, kitchens(business_name)")
        .in("id", orderIds)
        .returns<OrderRow[]>()
    : { data: [] as OrderRow[] };

  const orderById = new Map((orders ?? []).map((o) => [o.id, o]));
  const customerIds = [...new Set((orders ?? []).map((o) => o.customer_id))];
  const { data: customers } = customerIds.length
    ? await supabase.from("profiles").select("id, full_name, phone").in("id", customerIds).returns<CustomerRow[]>()
    : { data: [] as CustomerRow[] };
  const customerById = new Map((customers ?? []).map((c) => [c.id, c]));

  const groups = groupThreads(
    messages ?? [],
    Object.fromEntries((orders ?? []).map((o) => [o.id, o.customer_id]))
  );
  const needsReply = groups.reduce((n, g) => n + g.needsReplyCount, 0);
  const threadCount = groups.reduce((n, g) => n + g.threads.length, 0);

  return (
    <AdminShell
      title="Complaints"
      subtitle="Customer support threads, one per order. Threads never close — they stay as the record of the complaint."
    >
      <ComplaintsRealtimeRefresher />

      {groups.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          No complaint threads yet. They appear here when a customer taps &ldquo;Report an issue&rdquo; on an order.
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm" style={{ color: "var(--kb-on-navy-soft)" }}>
            {threadCount} thread{threadCount === 1 ? "" : "s"} ·{" "}
            <span style={{ color: needsReply ? "var(--kb-warn)" : "var(--kb-green)" }}>
              {needsReply} awaiting HQ reply
            </span>
          </p>
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
                        <li key={t.orderId}>
                          <Link
                            href={`/complaints/${t.orderId}`}
                            className="flex items-start justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-[var(--kb-cream)]"
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
                            <span
                              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium"
                              style={
                                t.needsReply
                                  ? { background: "#FEF3C7", color: "#92400E" }
                                  : { background: "var(--kb-cream)", color: "var(--kb-ink-soft)" }
                              }
                            >
                              {t.needsReply ? "Needs reply" : "Replied"}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}
    </AdminShell>
  );
}
