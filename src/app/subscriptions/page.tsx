import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { requireAdmin } from "@/lib/require-admin";

export default async function SubscriptionsPage() {
  const { user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  return (
    <AdminShell
      title="Subscriptions"
      subtitle="Flat monthly subscription for merchants — zero commission on orders."
    >
      <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
        Subscription billing isn&apos;t wired up yet — this lands with Feature #011 (Admin Control Center).
      </p>
    </AdminShell>
  );
}
