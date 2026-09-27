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
