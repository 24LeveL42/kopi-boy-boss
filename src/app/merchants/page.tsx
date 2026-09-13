import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { requireAdmin } from "@/lib/require-admin";
import { setPartnerActive, deleteTestPartner } from "@/lib/actions";
import type { Profile, CookApplication } from "@/lib/types-auth";

export default async function MerchantsPage() {
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const [{ data: merchantProfiles }, { data: approvedApps }] = await Promise.all([
    supabase
      .from("profiles")
      .select("*")
      .eq("role", "cook")
      .order("created_at", { ascending: false })
      .returns<Profile[]>(),
    supabase
      .from("cook_applications")
      .select("*")
      .eq("status", "approved")
      .returns<CookApplication[]>(),
  ]);

  const merchants = merchantProfiles ?? [];
  const appsByUser = new Map((approvedApps ?? []).map((a) => [a.user_id, a]));

  return (
    <AdminShell
      title={`Merchants (${merchants.length})`}
      subtitle="Approved cooks, hawkers, bakeries, and small food businesses selling on Kopi Boy."
    >
      {merchants.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          No approved merchants yet.
        </p>
      ) : (
        <div className="space-y-2">
          {merchants.map((m) => {
            const app = appsByUser.get(m.id);
            return (
              <div key={m.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{app?.business_name || m.full_name || "(no name on file)"}</p>
                    <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                      {app ? `${app.business_type ?? "—"} · ${app.neighbourhood ?? "—"}` : "No application on file"}
                    </p>
                    {m.phone && (
                      <p className="mt-1 text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                        {m.phone}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className="rounded-full px-2.5 py-1 text-xs font-medium"
                      style={{
                        background: m.is_active ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                        color: m.is_active ? "#16A34A" : "#DC2626",
                      }}
                    >
                      {m.is_active ? "Active" : "Blocked"}
                    </span>
                    <Link
                      href={`/merchants/${m.id}/edit`}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                      style={{ background: "var(--kb-purple)" }}
                    >
                      Edit
                    </Link>
                    <form action={setPartnerActive.bind(null, m.id, !m.is_active)}>
                      <button
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                        style={{ background: m.is_active ? "var(--kb-danger)" : "var(--kb-green-deep)" }}
                      >
                        {m.is_active ? "Block" : "Reinstate"}
                      </button>
                    </form>
                    <form action={deleteTestPartner.bind(null, m.id, "cook")}>
                      <button
                        className="rounded-lg px-3 py-1.5 text-xs font-medium"
                        style={{ background: "var(--kb-cream)", color: "var(--kb-danger)" }}
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </div>
                {app?.description && (
                  <p className="mt-2 text-xs" style={{ color: "var(--kb-ink-soft)" }}>{app.description}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </AdminShell>
  );
}
