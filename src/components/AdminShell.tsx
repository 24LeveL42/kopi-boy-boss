import Link from "next/link";
import { TopBar } from "./TopBar";
import { SidebarNav } from "./SidebarNav";

export function AdminShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
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
        <Link href="/" className="text-sm" style={{ color: "var(--kb-green)" }}>
          &larr; Back to Command Centre
        </Link>
        <h1 className="mt-3 font-display text-xl font-bold" style={{ color: "var(--kb-on-navy)" }}>
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm" style={{ color: "var(--kb-on-navy-soft)" }}>
            {subtitle}
          </p>
        )}
        <div className="mt-5">{children}</div>
      </main>
    </div>
  );
}
