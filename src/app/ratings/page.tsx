import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { getViewer, hasAdminRole } from "@/lib/require-admin";

export default async function RatingsPage() {
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  return (
    <AdminShell title="Ratings" subtitle="Merchant and rider ratings from customers.">
      <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
        Ratings aren&apos;t built yet — this lands with Feature #009 (ratings).
      </p>
    </AdminShell>
  );
}
