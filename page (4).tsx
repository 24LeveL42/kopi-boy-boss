import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { requireAdmin } from "@/lib/require-admin";

export default async function RefundsPage() {
  const { user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  return (
    <AdminShell
      title="Refunds"
      subtitle="Each cook sets their own refund policy — HQ steps in only as a backstop for repeated complaints."
    >
      <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
        Refund tracking isn&apos;t built yet — this lands with Feature #010 (complaints + refunds).
      </p>
    </AdminShell>
  );
}
