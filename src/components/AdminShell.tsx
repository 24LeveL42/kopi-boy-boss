import { OpsSidebar } from "./ops/OpsSidebar";

/**
 * Operations Centre frame for every signed-in admin screen: dark sidebar on
 * the left, light main area with the page title. Desktop only — below
 * ~1100px the page scrolls sideways rather than reflowing.
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
    <div className="flex min-h-screen min-w-[1100px]">
      <OpsSidebar />
      <main className="oc-main min-w-0 flex-1 px-8 py-7">
        <header className="mb-6 flex items-start justify-between gap-6">
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
