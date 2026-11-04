import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { getViewer, hasAdminRole } from "@/lib/require-admin";

export default async function SettingsPage() {
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  return (
    <AdminShell title="Platform Settings" subtitle="Global toggles and configuration for Kopi Boy.">
      <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
        No configurable settings yet — this lands with Feature #011 (Admin Control Center).
      </p>
    </AdminShell>
  );
}
