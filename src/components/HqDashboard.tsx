import Link from "next/link";
import { TopBar } from "./TopBar";
import { createClient } from "@/lib/supabase/server";
import {
  approveCookApplication,
  rejectCookApplication,
  approveRiderApplication,
  rejectRiderApplication,
  approvePickerApplication,
  rejectPickerApplication,
} from "@/lib/actions";
import type { CookApplication, RiderApplication, PickerApplication } from "@/lib/types-auth";
import { NAV_SECTIONS, METRICS } from "@/lib/demo-data";

export async function HqDashboard() {
  const supabase = await createClient();

  const [{ data: pendingCooks }, { data: pendingRiders }, { data: pendingPickers }] = await Promise.all([
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
  ]);

  const cooks = pendingCooks ?? [];
  const riders = pendingRiders ?? [];
  const pickers = pendingPickers ?? [];
  const totalPending = cooks.length + riders.length + pickers.length;

  return (
    <div className="min-h-screen md:flex" style={{ background: "var(--kb-navy)" }}>
      <aside
        className="shrink-0 border-b p-4 md:w-56 md:border-b-0 md:border-r"
        style={{ borderColor: "var(--kb-navy-line)" }}
      >
        <TopBar />
        <nav className="mt-6 space-y-1">
          {NAV_SECTIONS.map((s, i) => (
  <a
    key={s}
    href="#"
    className="block rounded-lg px-3 py-2 text-sm"
    style={
      i === 0
        ? { background: "var(--kb-navy-raised)", color: "var(--kb-on-navy)", fontWeight: 600 }
        : { color: "var(--kb-on-navy-soft)" }
    }
  >
    {s}
  </a>
))}
          <Link href="/partners" className="block rounded-lg px-3 py-2 text-sm" style={{ color: "var(--kb-on-navy-soft)" }}>
            Manage Partners
          </Link>
        </nav>
      </aside>

      <main className="flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-xl font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Command Centre
        </h1>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {METRICS.map((m) => (
            <div key={m.label} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
              <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>{m.label}</p>
              <p className="mt-1 text-2xl font-bold">{m.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--kb-on-navy-soft)" }}>
          Metrics above are placeholders — real numbers land with Features #005-#010 (orders, subscriptions, complaints).
        </p>

        <h2 className="mt-6 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Pending approvals {totalPending > 0 && `(${totalPending})`}
        </h2>

        {totalPending === 0 ? (
          <p className="mt-3 rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
            No pending applications right now.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {cooks.map((app) => (
              <div key={app.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{app.business_name}</p>
                    <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                      Cook &middot; {app.business_type} &middot; {app.neighbourhood}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <form action={approveCookApplication.bind(null, app.id, app.user_id)}>
                      <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: "var(--kb-green-deep)" }}>
                        Approve
                      </button>
                    </form>
                    <form action={rejectCookApplication.bind(null, app.id)}>
                      <button className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ background: "var(--kb-cream)", color: "var(--kb-ink)" }}>
                        Reject
                      </button>
                    </form>
                  </div>
                </div>
                {app.description && (
                  <p className="mt-2 text-xs" style={{ color: "var(--kb-ink-soft)" }}>{app.description}</p>
                )}
              </div>
            ))}

            {riders.map((app) => (
              <div key={app.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">Rider application</p>
                    <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                      {app.vehicle_type} {app.license_plate && `\u00b7 ${app.license_plate}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <form action={approveRiderApplication.bind(null, app.id, app.user_id)}>
                      <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: "var(--kb-green-deep)" }}>
                        Approve
                      </button>
                    </form>
                    <form action={rejectRiderApplication.bind(null, app.id)}>
                      <button className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ background: "var(--kb-cream)", color: "var(--kb-ink)" }}>
                        Reject
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            ))}

            {pickers.map((app) => (
              <div key={app.id} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">Picker application</p>
                    {app.note && (
                      <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>{app.note}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <form action={approvePickerApplication.bind(null, app.id, app.user_id)}>
                      <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: "var(--kb-green-deep)" }}>
                        Approve
                      </button>
                    </form>
                    <form action={rejectPickerApplication.bind(null, app.id)}>
                      <button className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ background: "var(--kb-cream)", color: "var(--kb-ink)" }}>
                        Reject
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}