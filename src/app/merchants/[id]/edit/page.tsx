import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Card, LoadError } from "@/components/ops/EmptyState";
import { MerchantEditForm } from "@/components/MerchantEditForm";
import { MenuItemsEditor } from "@/components/MenuItemsEditor";
import { KitchenAuditLog } from "@/components/KitchenAuditLog";
import { KitchenUenPanel } from "@/components/KitchenUenPanel";
import { getViewer, hasAdminRole } from "@/lib/require-admin";
import { kitchenHasPaynowWith } from "@/lib/kitchen-go-live";
import { kitchenUenStatusWith } from "@/lib/kitchen-uen";
import {
  KITCHEN_AUDIT_COLUMNS,
  kitchenLoadProblem,
  MERCHANT_EDIT_KITCHEN_COLUMNS,
  MERCHANT_EDIT_MENU_COLUMNS,
} from "@/lib/kitchen-columns";
import type { AuditRow } from "@/lib/kitchen-admin";
import type { Kitchen, MenuItem } from "@/lib/types-kitchen";

function BackLink() {
  return (
    <Link href="/merchants" className="text-sm font-medium underline" style={{ color: "var(--oc-accent)" }}>
      Back to merchants
    </Link>
  );
}

export default async function EditMerchantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const [{ data: merchant }, kitchenResult, itemsResult, auditResult, hasPaynow, uenStatus] = await Promise.all([
    supabase.from("profiles").select("id, full_name").eq("id", id).maybeSingle<{ id: string; full_name: string | null }>(),
    supabase.from("kitchens").select(MERCHANT_EDIT_KITCHEN_COLUMNS).eq("id", id).maybeSingle<Kitchen>(),
    supabase.from("menu_items").select(MERCHANT_EDIT_MENU_COLUMNS).eq("kitchen_id", id).order("created_at").returns<MenuItem[]>(),
    supabase
      .from("kitchen_admin_audit")
      .select(KITCHEN_AUDIT_COLUMNS)
      .eq("kitchen_id", id)
      .order("created_at", { ascending: false })
      .limit(50)
      .returns<AuditRow[]>(),
    // Yes/no only; the details never reach this page.
    kitchenHasPaynowWith(supabase, id),
    // Whether it needs a UEN is decided by the approved application, as the database decides it.
    kitchenUenStatusWith(supabase, id),
  ]);

  if (!merchant) {
    return (
      <AdminShell title="Merchant not found" subtitle="This profile may have been deleted.">
        <Card className="mb-4 p-5 text-sm">No merchant found with this ID.</Card>
        <BackLink />
      </AdminShell>
    );
  }

  // Never fall back to a blank form: Save would overwrite the real kitchen with defaults.
  const kitchen = kitchenResult.data;
  const problem = kitchenLoadProblem(kitchenResult);
  if (problem || !kitchen) {
    return (
      <AdminShell title="Can't edit this merchant" subtitle="The kitchen didn't load, so editing is switched off to protect its data.">
        <p className="mb-4 rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-danger)" }} role="alert">
          {problem}
        </p>
        <BackLink />
      </AdminShell>
    );
  }

  const items = itemsResult.data ?? [];
  const audit = auditResult.data ?? [];

  // Names for the change history: admins who made changes, and menu items.
  const adminIds = [...new Set(audit.map((r) => r.admin_id))];
  const { data: admins } = adminIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", adminIds).returns<{ id: string; full_name: string | null }[]>()
    : { data: [] as { id: string; full_name: string | null }[] };
  const adminNames = new Map((admins ?? []).map((a) => [a.id, a.full_name?.trim() || "Admin"]));
  const itemNames = new Map(items.map((i) => [i.id, i.name]));

  return (
    <AdminShell
      title={`Edit: ${kitchen.business_name || merchant.full_name || "Merchant"}`}
      subtitle="You're editing as HQ. Changes show in the Customer app straight away, and each one is recorded in the change history."
    >
      <Card className="mb-4 p-5">
        <h2 className="mb-4 text-base font-semibold" style={{ color: "var(--oc-text)" }}>
          Kitchen details
        </h2>
        <MerchantEditForm existingKitchen={kitchen} hasPaynow={hasPaynow} uenPending={uenStatus.state === "pending"} />
      </Card>

      <Card className="mb-4 p-5">
        <h2 className="mb-1 text-base font-semibold" style={{ color: "var(--oc-text)" }}>
          Business UEN
        </h2>
        <p className="mb-4 text-sm" style={{ color: "var(--oc-text-soft)" }}>
          Every kitchen except a Home Cook needs one to go live. Set or correct it here; each change needs the business name
          and a reason, and is recorded in the change history.
        </p>
        <KitchenUenPanel kitchenId={kitchen.id} businessName={kitchen.business_name} status={uenStatus} />
      </Card>

      <Card className="mb-4 p-5">
        <h2 className="mb-1 text-base font-semibold" style={{ color: "var(--oc-text)" }}>
          Menu
        </h2>
        <p className="mb-4 text-sm" style={{ color: "var(--oc-text-soft)" }}>
          Hide an item to take it off the menu. Hidden items stay here and can be shown again.
        </p>
        {itemsResult.error ? (
          // Never show the editor over a failed read: the menu would look empty.
          <LoadError what="the menu" message={itemsResult.error.message} />
        ) : (
          <MenuItemsEditor kitchenId={kitchen.id} initialItems={items} />
        )}
      </Card>

      <Card className="mb-4 p-5">
        <h2 className="mb-4 text-base font-semibold" style={{ color: "var(--oc-text)" }}>
          Change history
        </h2>
        {auditResult.error ? (
          <LoadError what="the change history" message={auditResult.error.message} />
        ) : (
          <KitchenAuditLog rows={audit} adminNames={adminNames} itemNames={itemNames} />
        )}
      </Card>

      <BackLink />
    </AdminShell>
  );
}
