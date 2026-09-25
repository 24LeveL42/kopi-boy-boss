import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { ComplaintThread } from "@/components/ComplaintThread";
import { ComplaintsRealtimeRefresher } from "@/components/ComplaintsRealtimeRefresher";
import { ThreadStatusBadge, ThreadStatusButton } from "@/components/ThreadStatus";
import { hasAdminRole, requireAdmin } from "@/lib/require-admin";
import { COMPLAINT_THREAD_FETCH_LIMIT, formatSgTime, groupThreads, type ComplaintMessageRow } from "@/lib/complaints";

type OrderRow = {
  id: string;
  customer_id: string;
  order_status: string;
  payment_status: string;
  subtotal: number;
  created_at: string;
  kitchens: { business_name: string | null } | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ComplaintThreadPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const { supabase, user } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const { data: order } = UUID_RE.test(orderId)
    ? await supabase
        .from("orders")
        .select("id, customer_id, order_status, payment_status, subtotal, created_at, kitchens(business_name)")
        .eq("id", orderId)
        .maybeSingle<OrderRow>()
    : { data: null };

  if (!order) {
    return (
      <AdminShell title="Thread not found" subtitle="This order may have been deleted.">
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          No order found with this ID. <Link href="/complaints" style={{ color: "var(--kb-green-deep)" }}>Back to complaints</Link>
        </p>
      </AdminShell>
    );
  }

  const [{ data: customer }, { data: status }, { data: messages }] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, phone")
      .eq("id", order.customer_id)
      .maybeSingle<{ full_name: string | null; phone: string | null }>(),
    supabase
      .from("complaint_threads")
      .select("status, resolved_at")
      .eq("order_id", order.id)
      .maybeSingle<{ status: "open" | "resolved"; resolved_at: string | null }>(),
    supabase
      .from("complaint_messages")
      .select("*")
      .eq("order_id", order.id)
      .order("created_at", { ascending: false })
      .limit(COMPLAINT_THREAD_FETCH_LIMIT)
      .returns<ComplaintMessageRow[]>(),
  ]);
  const resolvedAt = status?.status === "resolved" && status.resolved_at ? { [order.id]: status.resolved_at } : {};
  const thread = groupThreads(messages ?? [], { [order.id]: order.customer_id }, resolvedAt)[0]?.threads[0];
  const customerName = customer?.full_name || `Customer ${order.customer_id.slice(0, 8)}`;

  return (
    <AdminShell
      title={`Order #${order.id.slice(0, 8)} — ${customerName}`}
      subtitle={[
        order.kitchens?.business_name,
        `placed ${formatSgTime(order.created_at)}`,
        `$${Number(order.subtotal).toFixed(2)}`,
        `${order.order_status} / ${order.payment_status}`,
        customer?.phone,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <ComplaintsRealtimeRefresher />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link href="/complaints" className="text-sm" style={{ color: "var(--kb-green)" }}>
          &larr; All complaint threads
        </Link>
        {thread && (
          <div className="flex items-center gap-2">
            <ThreadStatusBadge thread={thread} />
            <ThreadStatusButton orderId={order.id} thread={thread} />
          </div>
        )}
      </div>
      <ComplaintThread orderId={order.id} customerId={order.customer_id} customerName={customerName} currentUserId={user.id} />
    </AdminShell>
  );
}
