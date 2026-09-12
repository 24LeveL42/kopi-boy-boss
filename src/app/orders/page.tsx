import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { requireAdmin } from "@/lib/require-admin";

type OrderRow = {
  id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
};

export default async function OrdersPage() {
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const { data: orders, error } = await supabase
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50)
    .returns<OrderRow[]>();

  return (
    <AdminShell
      title="Orders"
      subtitle="Live order feed across all merchants — placed, cooking, out for delivery, delivered."
    >
      {error ? (
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          Order tracking isn&apos;t wired up on this build yet — this lands with Feature #005 (order creation).
        </p>
      ) : !orders || orders.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          No orders yet.
        </p>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <div key={o.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Order #{o.id.slice(0, 8)}</p>
                <span
                  className="rounded-full px-2.5 py-1 text-xs font-medium"
                  style={{ background: "var(--kb-cream)", color: "var(--kb-ink)" }}
                >
                  {o.status}
                </span>
              </div>
              <p className="mt-1 text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                {new Date(o.created_at).toLocaleString("en-SG")}
              </p>
            </div>
          ))}
        </div>
      )}
    </AdminShell>
  );
}
