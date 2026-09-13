import { TopBar } from "./TopBar";
import { SidebarNav } from "./SidebarNav";
import { createClient } from "@/lib/supabase/server";
import {
  approveCookApplication,
  rejectCookApplication,
  approveRiderApplication,
  rejectRiderApplication,
  approvePickerApplication,
  rejectPickerApplication,
} from "@/lib/actions";
import type { CookApplication, RiderApplication, PickerApplication, Profile } from "@/lib/types-auth";
import { ActionButton } from "./ActionButton";

export async function HqDashboard() {
  const supabase = await createClient();

  const [
    { data: pendingCooks },
    { data: pendingRiders },
    { data: pendingPickers },
    { count: activeMerchants },
    { count: activeRiders },
  ] = await Promise.all([
    supabase
      .from("cook_applications")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .returns<CookApplication[]>(),
    supabase
      .from("rider_applications")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .returns<RiderApplication[]>(),
    supabase
      .from("picker_applications")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .returns<PickerApplication[]>(),
    supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "cook")
      .eq("is_active", true),
    supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "rider")
      .eq("is_active", true),
  ]);

  const cooks = pendingCooks ?? [];
  const riders = pendingRiders ?? [];
  const pickers = pendingPickers ?? [];
  const totalPending = cooks.length + riders.length + pickers.length;

  // Pull applicant name/phone for every pending application in one query.
  const applicantIds = [...cooks, ...riders, ...pickers].map((a) => a.user_id);
  const { data: applicantProfiles } = applicantIds.length
    ? await supabase.from("profiles").select("*").in("id", applicantIds).returns<Profile[]>()
    : { data: [] as Profile[] };
  const applicantById = new Map((applicantProfiles ?? []).map((p) => [p.id, p]));

  return (
    <div className="min-h-screen md:flex" style={{ background: "var(--kb-navy)" }}>
      <aside
        className="shrink-0 border-b p-4 md:w-56 md:border-b-0 md:border-r"
        style={{ borderColor: "var(--kb-navy-line)" }}
      >
        <TopBar />
        <SidebarNav />
      </aside>

      <main className="flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-xl font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Command Centre
        </h1>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
            <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>Active merchants</p>
            <p className="mt-1 text-2xl font-bold">{activeMerchants ?? 0}</p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
            <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>Active riders</p>
            <p className="mt-1 text-2xl font-bold">{activeRiders ?? 0}</p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
            <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>Pending applications</p>
            <p className="mt-1 text-2xl font-bold">{totalPending}</p>
          </div>
        </div>

        <h2 className="mt-6 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Pending approvals {totalPending > 0 && `(${totalPending})`}
        </h2>

        {totalPending === 0 ? (
          <p className="mt-3 rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
            No pending applications right now.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {cooks.map((app) => {
              const applicant = applicantById.get(app.user_id);
              return (
                <div key={app.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">{app.business_name}</p>
                      <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                        Cook &middot; {app.business_type} &middot; {app.neighbourhood}
                      </p>
                      <p className="mt-1 text-xs font-medium" style={{ color: "var(--kb-ink)" }}>
                        {applicant?.full_name || "(no name on file)"}
                        {applicant?.phone && ` · ${applicant.phone}`}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <ActionButton
                        action={approveCookApplication.bind(null, app.id, app.user_id)}
                        label="Approve"
                        pendingLabel="Approving…"
                        background="var(--kb-green-deep)"
                      />
                      <ActionButton
                        action={rejectCookApplication.bind(null, app.id)}
                        label="Reject"
                        pendingLabel="Rejecting…"
                        background="var(--kb-cream)"
                        color="var(--kb-ink)"
                      />
                    </div>
                  </div>
                  {app.description && (
                    <p className="mt-2 text-xs" style={{ color: "var(--kb-ink-soft)" }}>{app.description}</p>
                  )}
                </div>
              );
            })}

            {riders.map((app) => {
              const applicant = applicantById.get(app.user_id);
              return (
                <div key={app.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">Rider application</p>
                      <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                        {app.vehicle_type} {app.license_plate && `\u00b7 ${app.license_plate}`}
                      </p>
                      <p className="mt-1 text-xs font-medium" style={{ color: "var(--kb-ink)" }}>
                        {applicant?.full_name || "(no name on file)"}
                        {applicant?.phone && ` · ${applicant.phone}`}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <ActionButton
                        action={approveRiderApplication.bind(null, app.id, app.user_id)}
                        label="Approve"
                        pendingLabel="Approving…"
                        background="var(--kb-green-deep)"
                      />
                      <ActionButton
                        action={rejectRiderApplication.bind(null, app.id)}
                        label="Reject"
                        pendingLabel="Rejecting…"
                        background="var(--kb-cream)"
                        color="var(--kb-ink)"
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            {pickers.map((app) => {
              const applicant = applicantById.get(app.user_id);
              return (
                <div key={app.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">Picker application</p>
                      <p className="mt-1 text-xs font-medium" style={{ color: "var(--kb-ink)" }}>
                        {applicant?.full_name || "(no name on file)"}
                        {applicant?.phone && ` · ${applicant.phone}`}
                      </p>
                      {app.note && (
                        <p className="mt-1 text-xs" style={{ color: "var(--kb-ink-soft)" }}>{app.note}</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <ActionButton
                        action={approvePickerApplication.bind(null, app.id, app.user_id)}
                        label="Approve"
                        pendingLabel="Approving…"
                        background="var(--kb-green-deep)"
                      />
                      <ActionButton
                        action={rejectPickerApplication.bind(null, app.id)}
                        label="Reject"
                        pendingLabel="Rejecting…"
                        background="var(--kb-cream)"
                        color="var(--kb-ink)"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
