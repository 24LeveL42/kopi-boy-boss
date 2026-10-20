import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { DataTable } from "@/components/ops/DataTable";
import { Card, EmptyState } from "@/components/ops/EmptyState";
import { requireAdmin } from "@/lib/require-admin";

const COLUMNS = [
  { label: "Case" },
  { label: "Order" },
  { label: "Customer" },
  { label: "Merchant" },
  { label: "Amount", align: "right" as const },
  { label: "Opened" },
  { label: "Outcome" },
];

export default async function RefundsPage() {
  const { user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  return (
    <AdminShell title="Refunds and disputes" subtitle="Refund and dispute cases between customers and merchants.">
      <p
        className="mb-4 rounded-[14px] border px-4 py-3 text-sm"
        style={{ background: "var(--oc-accent-soft)", borderColor: "transparent", color: "var(--oc-text)" }}
      >
        Kopi Boy never holds customer money. The customer pays the merchant directly by PayNow, so a refund is agreed
        between the customer and the merchant. This list tracks each case and the outcome.
      </p>
      <Card className="overflow-hidden">
        <DataTable
          columns={COLUMNS}
          rows={[]}
          noun="cases"
          searchPlaceholder="Search case, order, customer or merchant…"
          empty={
            <EmptyState>
              There&apos;s no refund-case table in the database yet, so no cases are recorded. Customer complaints about an
              order are on the Complaints screen.
            </EmptyState>
          }
        />
      </Card>
    </AdminShell>
  );
}
