import { OpsSidebar } from "./ops/OpsSidebar";

/**
 * Operations Centre frame for every signed-in admin screen: dark sidebar on
 * the left, light main area with the page title. Below the lg breakpoint the
 * sidebar becomes a top bar with a menu drawer, and wide tables scroll sideways.
 */
export function AdminShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: React.ReactNode;
  subtitle?: string;
  /** Right-hand side of the title row (e.g. a Refresh button). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <OpsSidebar />
      <main className="oc-main min-w-0 flex-1 px-4 py-5 lg:px-8 lg:py-7">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-tight" style={{ color: "var(--oc-text)" }}>
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1 max-w-3xl text-sm" style={{ color: "var(--oc-text-soft)" }}>
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        {children}
      </main>
    </div>
  );
}
