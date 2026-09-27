import { TopBar } from "@/components/TopBar";
import { SidebarNav } from "@/components/SidebarNav";
import { Bone, CardListSkeleton } from "@/components/Skeleton";

/** Command Centre while its stats and pending applications load. Mirrors HqDashboard. */
export default function Loading() {
  return (
    <div className="min-h-screen md:flex" style={{ background: "var(--kb-navy)" }}>
      <aside
        className="shrink-0 border-b p-4 md:w-56 md:border-b-0 md:border-r"
        style={{ borderColor: "var(--kb-navy-line)" }}
      >
        <TopBar />
        <SidebarNav />
      </aside>

      <main className="flex-1 px-4 py-8 sm:px-6" role="status" aria-live="polite">
        <span className="sr-only">Loading…</span>
        <h1 className="font-display text-xl font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Command Centre
        </h1>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {["Active merchants", "Active riders", "Pending applications"].map((label) => (
            <div key={label} className="rounded-2xl bg-white p-4 shadow-lg">
              <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
                {label}
              </p>
              <Bone className="mt-2 h-7 w-10" />
            </div>
          ))}
        </div>

        <h2 className="mt-6 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Pending approvals
        </h2>
        <div className="mt-3">
          <CardListSkeleton rows={3} actions={2} />
        </div>
      </main>
    </div>
  );
}
