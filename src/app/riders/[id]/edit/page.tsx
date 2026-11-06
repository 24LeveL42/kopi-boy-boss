import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Card, LoadError } from "@/components/ops/EmptyState";
import { RiderRegions } from "@/components/RegionTag";
import { RiderRegionsForm } from "@/components/RiderRegionsForm";
import { getViewer, hasAdminRole } from "@/lib/require-admin";
import { loadRiderRegions } from "@/lib/regions";

type RiderRow = { id: string; role: string; full_name: string | null; phone: string | null };

function BackLink() {
  return (
    <Link href="/riders" className="text-sm font-medium underline" style={{ color: "var(--oc-accent)" }}>
      Back to riders
    </Link>
  );
}

export default async function EditRiderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const [profile, regions] = await Promise.all([
    supabase.from("profiles").select("id, role, full_name, phone").eq("id", id).maybeSingle<RiderRow>(),
    loadRiderRegions(supabase, [id]),
  ]);

  if (profile.error) {
    return (
      <AdminShell title="Can't edit this rider" subtitle="The rider didn't load.">
        <LoadError what="this rider" message={profile.error.message} />
        <BackLink />
      </AdminShell>
    );
  }
  const rider = profile.data;
  if (!rider || rider.role !== "rider") {
    return (
      <AdminShell title="Rider not found" subtitle="This person may have been deleted, or isn't a rider.">
        <Card className="mb-4 p-5 text-sm">No rider found with this ID.</Card>
        <BackLink />
      </AdminShell>
    );
  }

  const name = rider.full_name?.trim() || "(no name on file)";

  // Never show the checkboxes over a failed read: they'd start empty and
  // look like "no regions", and saving would replace the real ones.
  if (!regions.ok) {
    return (
      <AdminShell title={`Edit: ${name}`} subtitle="Editing is switched off because the rider's current regions didn't load.">
        <LoadError what="this rider's regions" message={regions.error} />
        <BackLink />
      </AdminShell>
    );
  }
  const current = regions.byRider.get(id) ?? [];

  return (
    <AdminShell
      title={`Edit: ${name}`}
      subtitle="Where this rider usually rides. Riders choose these in the Partner app; HQ can change them here."
    >
      <Card className="mb-4 space-y-4 p-5">
        <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
          Saved now: <RiderRegions regions={current} />
        </p>
        <RiderRegionsForm riderId={id} initial={current} />
      </Card>
      <BackLink />
    </AdminShell>
  );
}
