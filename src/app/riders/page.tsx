import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { RiderList, type RiderListItem } from "@/components/RiderList";
import { requireAdmin } from "@/lib/require-admin";
import { fetchEmailsById } from "@/lib/contacts";
import type { Profile, RiderApplication } from "@/lib/types-auth";

export default async function RidersPage() {
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const [{ data: riderProfiles }, { data: approvedApps }] = await Promise.all([
    supabase.from("profiles").select("*").eq("role", "rider").returns<Profile[]>(),
    supabase
      .from("rider_applications")
      .select("*")
      .eq("status", "approved")
      .returns<RiderApplication[]>(),
  ]);

  const riders = riderProfiles ?? [];
  const appsByUser = new Map((approvedApps ?? []).map((a) => [a.user_id, a]));
  const emailById = await fetchEmailsById(supabase, riders.map((r) => r.id));

  const items: RiderListItem[] = riders.map((r) => {
    const app = appsByUser.get(r.id);
    return {
      id: r.id,
      full_name: r.full_name,
      phone: r.phone,
      email: emailById.get(r.id) ?? null,
      is_active: r.is_active,
      vehicle: app
        ? `${app.vehicle_type ?? "—"}${app.license_plate ? ` · ${app.license_plate}` : ""}`
        : "No application on file",
    };
  });

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
        <RiderList riders={items} />
      )}
    </AdminShell>
  );
}
