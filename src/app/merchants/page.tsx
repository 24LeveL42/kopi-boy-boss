import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { MerchantList, type MerchantListItem } from "@/components/MerchantList";
import { requireAdmin } from "@/lib/require-admin";
import { fetchEmailsById } from "@/lib/contacts";
import type { Profile } from "@/lib/types-auth";
import type { Kitchen } from "@/lib/types-kitchen";

export default async function MerchantsPage() {
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const { data: liveKitchens } = await supabase
    .from("kitchens")
    .select("*")
    .eq("is_live", true)
    .returns<Kitchen[]>();

  const kitchens = liveKitchens ?? [];
  const kitchenIds = kitchens.map((k) => k.id);

  const [{ data: owners }, emailById] = await Promise.all([
    kitchenIds.length
      ? supabase.from("profiles").select("*").in("id", kitchenIds).returns<Profile[]>()
      : Promise.resolve({ data: [] as Profile[] }),
    fetchEmailsById(supabase, kitchenIds),
  ]);

  const ownerById = new Map((owners ?? []).map((p) => [p.id, p]));
  const items: MerchantListItem[] = kitchens.map((k) => {
    const owner = ownerById.get(k.id);
    return {
      id: k.id,
      business_name: k.business_name,
      category: k.category,
      neighbourhood: k.neighbourhood,
      description: k.description,
      owner_name: owner?.full_name ?? null,
      phone: owner?.phone ?? null,
      email: emailById.get(k.id) ?? null,
      is_active: owner?.is_active ?? false,
    };
  });

  return (
    <AdminShell
      title={`Merchants (${kitchens.length})`}
      subtitle="Live kitchens selling on Kopi Boy — hawkers, bakeries, home cooks, and more."
    >
      {kitchens.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          No live merchants yet.
        </p>
      ) : (
        <MerchantList merchants={items} />
      )}
    </AdminShell>
  );
}
