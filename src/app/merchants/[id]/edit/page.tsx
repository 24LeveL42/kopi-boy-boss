import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { MerchantEditForm } from "@/components/MerchantEditForm";
import { requireAdmin } from "@/lib/require-admin";
import type { Profile } from "@/lib/types-auth";
import type { Kitchen, MenuItem } from "@/lib/types-kitchen";

export default async function EditMerchantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const [{ data: merchant }, { data: kitchen }, { data: items }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", id).single<Profile>(),
    supabase.from("kitchens").select("*").eq("id", id).maybeSingle<Kitchen>(),
    supabase.from("menu_items").select("*").eq("kitchen_id", id).returns<MenuItem[]>(),
  ]);

  if (!merchant) {
    return (
      <AdminShell title="Merchant not found" subtitle="This profile may have been deleted.">
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          No merchant found with this ID.
        </p>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      title={`Edit: ${kitchen?.business_name || merchant.full_name || "Merchant"}`}
      subtitle="Changes save directly and go live in the Customer app immediately."
    >
      <MerchantEditForm
        merchantId={id}
        merchantName={merchant.full_name || ""}
        existingKitchen={kitchen ?? null}
        existingItems={items ?? []}
      />
    </AdminShell>
  );
}
