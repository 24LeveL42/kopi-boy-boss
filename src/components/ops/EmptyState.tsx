/** "Nothing to show yet" card for a screen or table with no rows (or no data source yet). */
export function EmptyState({ title = "Nothing to show yet", children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
        {title}
      </p>
      {children && (
        <div className="mx-auto mt-1.5 max-w-xl text-sm" style={{ color: "var(--oc-text-soft)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

/** White card with the Operations Centre border and radius. */
export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-[14px] border ${className}`}
      style={{ background: "var(--oc-card)", borderColor: "var(--oc-line)" }}
    >
      {children}
    </section>
  );
}

/** Red notice for a query that failed, so an error never looks like "no data". */
export function LoadError({ what, message }: { what: string; message: string }) {
  return (
    <p
      className="mb-4 rounded-[14px] border px-4 py-3 text-sm"
      style={{ background: "var(--oc-red-bg)", borderColor: "transparent", color: "var(--oc-red-fg)" }}
      role="alert"
    >
      Couldn&apos;t load {what}: {message}
    </p>
  );
}
