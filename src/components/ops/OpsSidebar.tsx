"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { badgeLabel } from "@/lib/admin-messages";
import { countLiveOrders, countWhere } from "@/lib/ops-data";
import { Logo } from "../Logo";
import { SignOutButton } from "../SignOutButton";

type CountKey = "liveOrders" | "pendingCooks" | "pendingRiders" | "openMessages";
type Counts = Record<CountKey, number | null>;

const MAIN_LINKS: { label: string; href: string; count?: CountKey; tone?: "neutral" | "amber" | "red" }[] = [
  { label: "Overview", href: "/" },
  { label: "Live orders", href: "/orders", count: "liveOrders", tone: "neutral" },
  { label: "Past orders", href: "/orders/past" },
  { label: "Refunds and disputes", href: "/refunds" },
  { label: "Merchants and addresses", href: "/merchants", count: "pendingCooks", tone: "amber" },
  { label: "Riders", href: "/riders", count: "pendingRiders", tone: "amber" },
  { label: "Customers", href: "/customers" },
  { label: "Subscriptions", href: "/subscriptions" },
  { label: "Messages", href: "/messages", count: "openMessages", tone: "red" },
  { label: "Activity log", href: "/activity" },
];

/** Screens from before the Operations Centre, still in use. */
const MORE_LINKS = [
  { label: "Complaints", href: "/complaints" },
  { label: "Ratings", href: "/ratings" },
  { label: "Delivery pricing", href: "/delivery-pricing" },
  { label: "Platform settings", href: "/settings" },
  { label: "Manage partners", href: "/partners" },
];

const ALL_HREFS = [...MAIN_LINKS, ...MORE_LINKS].map((l) => l.href);

const BADGE_STYLE = {
  neutral: { background: "var(--oc-ink-raised)", color: "var(--oc-on-ink)" },
  amber: { background: "#F2B544", color: "var(--oc-ink)" },
  red: { background: "#E5484D", color: "white" },
};

const BADGE_HINT: Record<CountKey, string> = {
  liveOrders: "live orders",
  pendingCooks: "merchant applications to review",
  pendingRiders: "rider applications to review",
  openMessages: "open messages",
};

/** The link that owns this path: exact match, else the longest prefix ("/merchants/x/edit" -> "/merchants"). */
function activeHref(pathname: string): string | null {
  if (ALL_HREFS.includes(pathname)) return pathname;
  const prefixes = ALL_HREFS.filter((h) => h !== "/" && pathname.startsWith(`${h}/`));
  return prefixes.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Badge counts, re-counted on every navigation and whenever Realtime reports
 * a change to the tables behind them. RLS only lets admins count; on error a
 * badge is simply hidden.
 */
function useNavCounts(): Counts {
  const pathname = usePathname();
  const [counts, setCounts] = useState<Counts>({
    liveOrders: null,
    pendingCooks: null,
    pendingRiders: null,
    openMessages: null,
  });

  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      const [liveOrders, pendingCooks, pendingRiders, openMessages] = await Promise.all([
        countLiveOrders(supabase),
        countWhere(supabase, "cook_applications", "status", "pending"),
        countWhere(supabase, "rider_applications", "status", "pending"),
        countWhere(supabase, "admin_messages", "status", "open"),
      ]);
      if (!disposed) setCounts({ liveOrders, pendingCooks, pendingRiders, openMessages });
    }

    void load();
    let channel = supabase.channel("ops:nav-badges");
    for (const table of ["admin_messages", "orders", "delivery_requests", "cook_applications", "rider_applications"]) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 500);
      });
    }
    channel.subscribe();

    return () => {
      disposed = true;
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [pathname]);

  return counts;
}

function NavLink({
  href,
  label,
  active,
  badge,
}: {
  href: string;
  label: string;
  active: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[var(--oc-ink-raised)]"
      style={
        active
          ? { background: "var(--oc-accent)", color: "white", fontWeight: 600 }
          : { color: "var(--oc-on-ink-soft)" }
      }
    >
      <span className="truncate">{label}</span>
      {badge}
    </Link>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3 px-2" aria-label="Kopi Boy Operations Centre — Overview">
      <span className="flex size-10 items-center justify-center rounded-xl bg-white">
        <Logo size={26} showWordmark={false} />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold">Kopi Boy</span>
        <span className="block text-xs" style={{ color: "var(--oc-on-ink-soft)" }}>
          Operations Centre
        </span>
      </span>
    </Link>
  );
}

/** Desktop: fixed sidebar. Phone/tablet: top bar whose Menu button opens the same links as a drawer. */
export function OpsSidebar() {
  const pathname = usePathname();
  const counts = useNavCounts();
  const [openOn, setOpenOn] = useState<string | null>(null);
  // The drawer belongs to the page it was opened on, so navigating closes it.
  const menuOpen = openOn === pathname;

  return (
    <>
      <div
        className="sticky top-0 z-[1200] flex items-center justify-between px-3 py-2.5 lg:hidden"
        style={{ background: "var(--oc-ink)", color: "var(--oc-on-ink)" }}
      >
        <Brand />
        <button
          type="button"
          onClick={() => setOpenOn(menuOpen ? null : pathname)}
          aria-expanded={menuOpen}
          aria-controls="ops-mobile-menu"
          className="rounded-lg px-3 py-1.5 text-sm font-medium"
          style={{ background: "var(--oc-ink-raised)" }}
        >
          {menuOpen ? "Close" : "Menu"}
        </button>
      </div>
      {menuOpen && (
        <div
          id="ops-mobile-menu"
          className="fixed inset-x-0 top-[60px] bottom-0 z-[1200] overflow-y-auto px-3 pb-6 lg:hidden"
          style={{ background: "var(--oc-ink)", color: "var(--oc-on-ink)" }}
        >
          <NavLinks pathname={pathname} counts={counts} />
        </div>
      )}
      <aside
        className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto px-3 py-5 lg:flex"
        style={{ background: "var(--oc-ink)", color: "var(--oc-on-ink)" }}
      >
        <Brand />
        <NavLinks pathname={pathname} counts={counts} />
      </aside>
    </>
  );
}

function NavLinks({ pathname, counts }: { pathname: string; counts: Counts }) {
  const current = activeHref(pathname);
  return (
    <div className="flex flex-1 flex-col">
      <nav className="mt-7 space-y-0.5" aria-label="Operations Centre">
        {MAIN_LINKS.map((link) => {
          const label = link.count ? badgeLabel(counts[link.count]) : null;
          return (
            <NavLink
              key={link.href}
              href={link.href}
              label={link.label}
              active={current === link.href}
              badge={
                label &&
                link.count && (
                  <span
                    className="min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] leading-none font-semibold"
                    style={BADGE_STYLE[link.tone ?? "neutral"]}
                    aria-label={`${label} ${BADGE_HINT[link.count]}`}
                  >
                    {label}
                  </span>
                )
              }
            />
          );
        })}
      </nav>

      <p
        className="mt-6 px-3 text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--oc-on-ink-soft)" }}
      >
        More
      </p>
      <nav className="mt-1 space-y-0.5" aria-label="More admin screens">
        {MORE_LINKS.map((link) => (
          <NavLink key={link.href} href={link.href} label={link.label} active={current === link.href} />
        ))}
      </nav>

      <div className="mt-auto pt-6">
        <SignOutButton />
      </div>
    </div>
  );
}
