import { TopBar } from "./TopBar";
import { METRICS, NAV_SECTIONS, PENDING_APPROVALS } from "@/lib/demo-data";

/**
 * HQ app shell — foundation only (handover doc section 22-23).
 *
 * Real RBAC (Super Admin / Operations Admin / Support Admin) is Feature
 * #002. Each nav section here is a placeholder link — wiring them up to
 * real management screens is Feature #011 (Admin Control Center).
 */
export function HqDashboard() {
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

        <h2 className="mt-8 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Pending approvals
        </h2>
        <div className="mt-3 space-y-2">
          {PENDING_APPROVALS.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
              <div>
                <p className="text-sm font-semibold">{a.name}</p>
                <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>{a.type} &middot; submitted {a.submitted}</p>
              </div>
              <div className="flex gap-2">
                <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: "var(--kb-green-deep)" }}>Approve</button>
                <button className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ background: "var(--kb-cream)", color: "var(--kb-ink)" }}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
