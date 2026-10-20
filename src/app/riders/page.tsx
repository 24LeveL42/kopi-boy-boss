import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { ActionButton } from "@/components/ActionButton";
import { ContactLine } from "@/components/ContactLine";
import { Cell, DataTable, type TableRow } from "@/components/ops/DataTable";
import { Card, EmptyState, LoadError } from "@/components/ops/EmptyState";
import { ActivePill, StatusPill } from "@/components/ops/StatusPill";
import { Age } from "@/components/ops/Ticking";
import { loadPendingApplications, PendingRiderApplications } from "@/components/ops/PendingApplications";
import { requireAdmin } from "@/lib/require-admin";
import { fetchEmailsById } from "@/lib/contacts";
import { loadNames, renderTime } from "@/lib/ops-data";
import { deliveredSince, sgDayStartIso, shortId, type DeliveryFacts } from "@/lib/ops";
import { sortActiveThenBlocked } from "@/lib/admin-lists";
import { deleteTestPartner, setPartnerActive } from "@/lib/actions";
import type { Profile, RiderApplication } from "@/lib/types-auth";

type Delivery = DeliveryFacts & { kitchen_id: string };

const DELIVERY_COLUMNS = "id, order_id, kitchen_id, rider_id, status, created_at, accepted_at, completed_at";

const COLUMNS = [
  { label: "Rider" },
  { label: "Contact" },
  { label: "Status" },
  { label: "Current job" },
  { label: "Delivered today", align: "right" as const },
  { label: "Account" },
  { label: "Actions", align: "right" as const },
];

export default async function RidersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const now = renderTime();
  const [{ data: riderProfiles, error: riderError }, { data: approvedApps }, current, today, pending] = await Promise.all([
    supabase.from("profiles").select("*").eq("role", "rider").returns<Profile[]>(),
    supabase.from("rider_applications").select("*").eq("status", "approved").returns<RiderApplication[]>(),
    supabase.from("delivery_requests").select(DELIVERY_COLUMNS).eq("status", "accepted").returns<Delivery[]>(),
    supabase
      .from("delivery_requests")
      .select(DELIVERY_COLUMNS)
      .eq("status", "completed")
      .gte("completed_at", sgDayStartIso(now))
      .returns<Delivery[]>(),
    loadPendingApplications<RiderApplication>(supabase, "rider_applications"),
  ]);

  const riders = riderProfiles ?? [];
  const appsByUser = new Map((approvedApps ?? []).map((a) => [a.user_id, a]));
  const jobs = current.data ?? [];
  const jobByRider = new Map(jobs.filter((d) => d.rider_id).map((d) => [d.rider_id!, d]));
  const deliveredToday = deliveredSince(today.data ?? [], sgDayStartIso(now));
  const [emailById, names] = await Promise.all([
    fetchEmailsById(supabase, riders.map((r) => r.id)),
    loadNames(supabase, jobs.map((d) => d.kitchen_id), []),
  ]);

  const rows: TableRow[] = sortActiveThenBlocked(riders, (r) => r.full_name, (r) => r.is_active).map((r) => {
    const app = appsByUser.get(r.id);
    const job = jobByRider.get(r.id);
    const email = emailById.get(r.id) ?? null;
    const merchant = job ? names.kitchenName.get(job.kitchen_id) || "Unknown kitchen" : null;
    const vehicle = app
      ? `${app.vehicle_type ?? "—"}${app.license_plate ? ` · ${app.license_plate}` : ""}`
      : "No application on file";
    return {
      id: r.id,
      muted: !r.is_active,
      search: [r.full_name, r.phone, email, vehicle, job ? shortId(job.order_id) : null, merchant],
      cells: [
        <Cell key="n" main={r.full_name || "(no name on file)"} sub={vehicle} />,
        <ContactLine key="c" phone={r.phone} email={email} />,
        job ? <StatusPill key="s" tone="purple">On a delivery</StatusPill> : <StatusPill key="s" tone="grey">No job</StatusPill>,
        job ? (
          <Cell
            key="j"
            main={`Order ${shortId(job.order_id)}`}
            sub={
              <>
                {merchant}
                {job.accepted_at && (
                  <>
                    {" "}· accepted <Age since={job.accepted_at} serverNow={now} /> ago
                  </>
                )}
              </>
            }
          />
        ) : (
          <span key="j" style={{ color: "var(--oc-text-soft)" }}>—</span>
        ),
        <span key="d" className="tabular-nums">{deliveredToday.get(r.id) ?? 0}</span>,
        <ActivePill key="a" active={r.is_active} />,
        <div key="x" className="flex justify-end gap-2">
          <ActionButton
            action={setPartnerActive.bind(null, r.id, !r.is_active)}
            label={r.is_active ? "Block" : "Reinstate"}
            pendingLabel="Saving…"
            background={r.is_active ? "var(--kb-danger)" : "var(--kb-green-deep)"}
          />
          <ActionButton
            action={deleteTestPartner.bind(null, r.id, "rider")}
            label="Delete"
            pendingLabel="Deleting…"
            background="var(--oc-grey-bg)"
            color="var(--kb-danger)"
            confirmMessage={`Delete ${r.full_name || "this partner"}? This removes their profile, application, and kitchen/menu data.`}
          />
        </div>,
      ],
    };
  });

  const deliveryError = current.error ?? today.error;

  return (
    <AdminShell
      title="Riders"
      subtitle="Approved delivery riders, what they're doing now and how many deliveries they've completed today (Singapore time)."
    >
      {riderError && <LoadError what="riders" message={riderError.message} />}
      {deliveryError && <LoadError what="deliveries" message={deliveryError.message} />}
      {pending.error && <LoadError what="rider applications" message={pending.error} />}
      <PendingRiderApplications loaded={pending} />
      <Card className="overflow-hidden">
        <DataTable
          columns={COLUMNS}
          rows={rows}
          noun="riders"
          initialQuery={q ?? ""}
          searchPlaceholder="Search name, phone, email, vehicle or order…"
          empty={<EmptyState>No approved riders yet.</EmptyState>}
        />
      </Card>
    </AdminShell>
  );
}
