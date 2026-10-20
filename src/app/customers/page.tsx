import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { ContactLine } from "@/components/ContactLine";
import { DataTable, type TableRow } from "@/components/ops/DataTable";
import { Card, EmptyState, LoadError } from "@/components/ops/EmptyState";
import { ActivePill } from "@/components/ops/StatusPill";
import { requireAdmin } from "@/lib/require-admin";
import { fetchEmailsById } from "@/lib/contacts";
import { ordersByCustomer } from "@/lib/ops";
import { formatSgTime } from "@/lib/complaints";
import type { Profile } from "@/lib/types-auth";

/** How many customers and recent orders the screen reads. */
const CUSTOMER_LIMIT = 1000;
const ORDER_SCAN_LIMIT = 5000;

const COLUMNS = [
  { label: "Customer" },
  { label: "Contact" },
  { label: "Joined" },
  { label: "Orders", align: "right" as const },
  { label: "Last order" },
  { label: "Saved addresses", align: "right" as const },
  { label: "Account" },
];

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const [{ data: customerRows, error }, { data: orderRows, error: orderError }] = await Promise.all([
    supabase
      .from("profiles")
      .select("*")
      .eq("role", "customer")
      .order("created_at", { ascending: false })
      .limit(CUSTOMER_LIMIT)
      .returns<Profile[]>(),
    supabase
      .from("orders")
      .select("customer_id, created_at")
      .order("created_at", { ascending: false })
      .limit(ORDER_SCAN_LIMIT)
      .returns<{ customer_id: string; created_at: string }[]>(),
  ]);
  const customers = customerRows ?? [];
  const orderStats = ordersByCustomer(orderRows ?? []);
  const emailById = await fetchEmailsById(supabase, customers.map((c) => c.id));

  const rows: TableRow[] = customers.map((c) => {
    const stats = orderStats.get(c.id);
    const email = emailById.get(c.id) ?? null;
    return {
      id: c.id,
      muted: !c.is_active,
      search: [c.full_name, c.phone, email],
      cells: [
        <span key="n" className="font-medium">{c.full_name || "(no name on file)"}</span>,
        <ContactLine key="c" phone={c.phone} email={email} />,
        <span key="j" style={{ color: "var(--oc-text-soft)" }}>{formatSgTime(c.created_at)}</span>,
        <span key="o" className="tabular-nums">{stats?.count ?? 0}</span>,
        <span key="l">{stats ? formatSgTime(stats.last) : <span style={{ color: "var(--oc-text-soft)" }}>Never ordered</span>}</span>,
        <span key="a" style={{ color: "var(--oc-text-soft)" }} title="Saved addresses aren't stored in the database yet">—</span>,
        <ActivePill key="s" active={c.is_active} />,
      ],
    };
  });

  return (
    <AdminShell
      title="Customers"
      subtitle="People who order through the Customer app. Order counts cover the newest 5,000 orders. Saved addresses aren't stored in the database yet, and blocking isn't available here because the Customer app doesn't check the Blocked flag."
    >
      {error && <LoadError what="customers" message={error.message} />}
      {orderError && <LoadError what="orders" message={orderError.message} />}
      <Card className="overflow-hidden">
        <DataTable
          columns={COLUMNS}
          rows={rows}
          noun="customers"
          initialQuery={q ?? ""}
          searchPlaceholder="Search name, phone or email…"
          empty={<EmptyState>No customers have signed up yet.</EmptyState>}
        />
      </Card>
    </AdminShell>
  );
}
