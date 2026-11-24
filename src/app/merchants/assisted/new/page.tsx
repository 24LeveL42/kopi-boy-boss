import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Card } from "@/components/ops/EmptyState";
import { AssistedShopForm } from "@/components/AssistedShopForm";
import { getViewer, hasAdminRole } from "@/lib/require-admin";

export default async function NewAssistedShopPage() {
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  return (
    <AdminShell
      title="New assisted shop"
      subtitle="Fill in what you know now. The address, postal code, UEN and menu can be added before you send the claim link."
    >
      <Card className="mb-4 p-5">
        <AssistedShopForm />
      </Card>
      <Link href="/merchants/assisted" className="text-sm font-medium underline" style={{ color: "var(--oc-accent)" }}>
        Back to assisted onboarding
      </Link>
    </AdminShell>
  );
}
