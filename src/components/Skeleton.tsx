import { AdminShell } from "./AdminShell";

/**
 * Placeholder building blocks for the route-level loading.tsx files. They
 * mirror the real pages' white cards on navy so the swap-in doesn't jump.
 */

/** A pulsing grey bar. `onNavy` for bars drawn straight on the navy background. */
export function Bone({ className = "", onNavy = false }: { className?: string; onNavy?: boolean }) {
  return (
    <span
      aria-hidden
      className={`block rounded-md motion-safe:animate-pulse ${className}`}
      style={{ background: onNavy ? "var(--kb-navy-raised)" : "var(--kb-cream)" }}
    />
  );
}

/** Stack of list-row cards: name, meta line, and optional action pills on the right. */
export function CardListSkeleton({ rows = 4, actions = 0 }: { rows?: number; actions?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-lg">
          <div className="min-w-0 flex-1 space-y-2">
            <Bone className="h-3.5 w-2/5" />
            <Bone className="h-3 w-3/5" />
          </div>
          {actions > 0 && (
            <div className="flex shrink-0 gap-2">
              {Array.from({ length: actions }, (_, j) => (
                <Bone key={j} className="h-7 w-16 rounded-lg" />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Full admin page in its loading state. `title` is the page's real title when
 * it's static; leave it out when the title depends on the data (a count, a name).
 */
export function PageSkeleton({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <AdminShell title={title ?? <Bone onNavy className="h-6 w-56" />}>
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading…</span>
        {children}
      </div>
    </AdminShell>
  );
}

/** Operations Centre table card: search bar, header row, then `rows` lines of `columns` cells. */
export function TableSkeleton({ rows = 6, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <section className="overflow-hidden rounded-[14px] border bg-white" style={{ borderColor: "var(--oc-line)" }}>
      <div className="border-b px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
        <Bone className="h-9 w-96 rounded-lg" />
      </div>
      {Array.from({ length: rows + 1 }, (_, i) => (
        <div key={i} className="flex gap-6 border-b px-4 py-3.5 last:border-b-0" style={{ borderColor: "var(--oc-line)" }}>
          {Array.from({ length: columns }, (_, j) => (
            <Bone key={j} className={`flex-1 ${i === 0 ? "h-2.5" : "h-3.5"}`} />
          ))}
        </div>
      ))}
    </section>
  );
}
