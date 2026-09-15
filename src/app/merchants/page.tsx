import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { requireAdmin } from "@/lib/require-admin";
import { setPartnerActive, deleteTestPartner } from "@/lib/actions";
import { ActionButton } from "@/components/ActionButton";
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
    .order("created_at", { ascending: false })
    .returns<Kitchen[]>();

  const kitchens = liveKitchens ?? [];
  const kitchenIds = kitchens.map((k) => k.id);

  const { data: owners } = kitchenIds.length
    ? await supabase.from("profiles").select("*").in("id", kitchenIds).returns<Profile[]>()
    : { data: [] as Profile[] };

  const ownerById = new Map((owners ?? []).map((p) => [p.id, p]));

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
        <div className="space-y-2">
          {kitchens.map((k) => {
            const owner = ownerById.get(k.id);
            return (
              <div key={k.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{k.business_name}</p>
                    <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                      {k.category} · {k.neighbourhood}
                    </p>
                    {owner?.phone && (
                      <p className="mt-1 text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                        {owner.phone}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className="rounded-full px-2.5 py-1 text-xs font-medium"
                      style={{
                        background: owner?.is_active ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                        color: owner?.is_active ? "#16A34A" : "#DC2626",
                      }}
                    >
                      {owner?.is_active ? "Active" : "Blocked"}
                    </span>
                    <Link
                      href={`/merchants/${k.id}/edit`}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                      style={{ background: "var(--kb-purple)" }}
                    >
                      Edit
                    </Link>
                    <ActionButton
                      action={setPartnerActive.bind(null, k.id, !owner?.is_active)}
                      label={owner?.is_active ? "Block" : "Reinstate"}
                      pendingLabel="Saving…"
                      background={owner?.is_active ? "var(--kb-danger)" : "var(--kb-green-deep)"}
                    />
                    <ActionButton
                      action={deleteTestPartner.bind(null, k.id, "cook")}
                      label="Delete"
                      pendingLabel="Deleting…"
                      background="var(--kb-cream)"
                      color="var(--kb-danger)"
                      confirmMessage={`Delete ${k.business_name}? This removes their profile, application, and kitchen/menu data.`}
                    />
                  </div>
                </div>
                {k.description && (
                  <p className="mt-2 text-xs" style={{ color: "var(--kb-ink-soft)" }}>{k.description}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </AdminShell>
  );
}
