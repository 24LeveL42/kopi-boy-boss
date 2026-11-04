import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { MerchantEditForm } from "@/components/MerchantEditForm";
import { requireAdmin } from "@/lib/require-admin";
import { kitchenLoadProblem, MERCHANT_EDIT_KITCHEN_COLUMNS } from "@/lib/kitchen-columns";
import type { Profile } from "@/lib/types-auth";
import type { Kitchen, MenuItem } from "@/lib/types-kitchen";

export default async function EditMerchantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const [{ data: merchant }, kitchenResult, { data: items }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", id).single<Profile>(),
    supabase.from("kitchens").select(MERCHANT_EDIT_KITCHEN_COLUMNS).eq("id", id).maybeSingle<Kitchen>(),
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

  // Never fall back to a blank form: Save would overwrite the real kitchen with defaults.
  const kitchen = kitchenResult.data;
  const problem = kitchenLoadProblem(kitchenResult);
  if (problem || !kitchen) {
    return (
      <AdminShell title="Can't edit this merchant" subtitle="The kitchen didn't load, so editing is switched off to protect its data.">
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-danger)" }} role="alert">
          {problem}
        </p>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      title={`Edit: ${kitchen.business_name || merchant.full_name || "Merchant"}`}
      subtitle="Changes save directly and go live in the Customer app immediately."
    >
      <MerchantEditForm
        merchantId={id}
        merchantName={merchant.full_name || ""}
        existingKitchen={kitchen}
        existingItems={items ?? []}
      />
    </AdminShell>
  );
}
