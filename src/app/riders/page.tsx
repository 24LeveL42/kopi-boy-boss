import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { requireAdmin } from "@/lib/require-admin";
import { setPartnerActive, deleteTestPartner } from "@/lib/actions";
import type { Profile, RiderApplication } from "@/lib/types-auth";

export default async function RidersPage() {
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const [{ data: riderProfiles }, { data: approvedApps }] = await Promise.all([
    supabase
      .from("profiles")
      .select("*")
      .eq("role", "rider")
      .order("created_at", { ascending: false })
      .returns<Profile[]>(),
    supabase
      .from("rider_applications")
      .select("*")
      .eq("status", "approved")
      .returns<RiderApplication[]>(),
  ]);

  const riders = riderProfiles ?? [];
  const appsByUser = new Map((approvedApps ?? []).map((a) => [a.user_id, a]));

  return (
    <AdminShell
      title={`Riders (${riders.length})`}
      subtitle="Approved delivery riders — free registration, no fees, they keep the full delivery fee."
    >
      {riders.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          No approved riders yet.
        </p>
      ) : (
        <div className="space-y-2">
          {riders.map((r) => {
            const app = appsByUser.get(r.id);
            return (
              <div key={r.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{r.full_name || "(no name on file)"}</p>
                    <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                      {app ? `${app.vehicle_type ?? "—"}${app.license_plate ? ` · ${app.license_plate}` : ""}` : "No application on file"}
                    </p>
                    {r.phone && (
                      <p className="mt-1 text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                        {r.phone}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className="rounded-full px-2.5 py-1 text-xs font-medium"
                      style={{
                        background: r.is_active ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                        color: r.is_active ? "#16A34A" : "#DC2626",
                      }}
                    >
                      {r.is_active ? "Active" : "Blocked"}
                    </span>
                    <form action={setPartnerActive.bind(null, r.id, !r.is_active)}>
                      <button
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                        style={{ background: r.is_active ? "var(--kb-danger)" : "var(--kb-green-deep)" }}
                      >
                        {r.is_active ? "Block" : "Reinstate"}
                      </button>
                    </form>
                    <form action={deleteTestPartner.bind(null, r.id, "rider")}>
                      <button
                        className="rounded-lg px-3 py-1.5 text-xs font-medium"
                        style={{ background: "var(--kb-cream)", color: "var(--kb-danger)" }}
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AdminShell>
  );
}
