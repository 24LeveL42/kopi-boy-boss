import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { requireAdmin } from "@/lib/require-admin";
import { PartnerFinder, type PartnerListItem } from "@/components/PartnerFinder";
import type { Profile } from "@/lib/types-auth";
import { fetchEmailsById } from "@/lib/contacts";

export default async function PartnersPage() {
  const { supabase, user, profile: viewerProfile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!viewerProfile || viewerProfile.role !== "admin") return <NotAuthorized />;

  const { data: partners } = await supabase
    .from("profiles")
    .select("*")
    .in("role", ["cook", "rider", "picker"])
    .order("created_at", { ascending: false })
    .returns<Profile[]>();

  const list = partners ?? [];

  // Kitchens share the cook's profile id; pulled so admins can search cooks by business name.
  const cookIds = list.filter((p) => p.role === "cook").map((p) => p.id);
  const { data: kitchens } = cookIds.length
    ? await supabase
        .from("kitchens")
        .select("id, business_name")
        .in("id", cookIds)
        .returns<{ id: string; business_name: string | null }[]>()
    : { data: [] as { id: string; business_name: string | null }[] };
  const businessNameById = new Map((kitchens ?? []).map((k) => [k.id, k.business_name]));
  const emailById = await fetchEmailsById(supabase, list.map((p) => p.id));

  const items: PartnerListItem[] = list.map((p) => ({
    ...p,
    role: p.role as PartnerListItem["role"],
    business_name: businessNameById.get(p.id) ?? null,
    email: emailById.get(p.id) ?? null,
  }));

  return (
    <AdminShell
      title="Manage Partners"
      subtitle="Disabling a partner blocks them from accepting new orders/deliveries without deleting their account."
    >
      <PartnerFinder partners={items} />
    </AdminShell>
  );
}
