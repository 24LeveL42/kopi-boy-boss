import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { DataTable } from "@/components/ops/DataTable";
import { Card, EmptyState } from "@/components/ops/EmptyState";
import { requireAdmin } from "@/lib/require-admin";

const COLUMNS = [
  { label: "Merchant" },
  { label: "Plan" },
  { label: "Price", align: "right" as const },
  { label: "Free trial ends" },
  { label: "Status" },
];

export default async function SubscriptionsPage() {
  const { user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  return (
    <AdminShell
      title="Subscriptions"
      subtitle="Flat monthly subscription for merchants at S$29.90 / month after a free trial — zero commission on orders."
    >
      <Card className="overflow-hidden">
        <DataTable
          columns={COLUMNS}
          rows={[]}
          noun="subscriptions"
          searchPlaceholder="Search merchant…"
          empty={
            <EmptyState>
              Subscription billing isn&apos;t recorded in the database yet, so there are no plans or free-trial dates to
              show.
            </EmptyState>
          }
        />
      </Card>
    </AdminShell>
  );
}
