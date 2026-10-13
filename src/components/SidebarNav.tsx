"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { badgeLabel } from "@/lib/admin-messages";

const NAV_LINKS = [
  { label: "Command Centre", href: "/" },
  { label: "Messages", href: "/messages" },
  { label: "Merchants", href: "/merchants" },
  { label: "Riders", href: "/riders" },
  { label: "Orders", href: "/orders" },
  { label: "Complaints", href: "/complaints" },
  { label: "Refunds", href: "/refunds" },
  { label: "Ratings", href: "/ratings" },
  { label: "Subscriptions", href: "/subscriptions" },
  { label: "Delivery Pricing", href: "/delivery-pricing" },
  { label: "Platform Settings", href: "/settings" },
  { label: "Manage Partners", href: "/partners" },
];

/**
 * How many admin_messages are still 'open'. Re-counted on every navigation and
 * on any change Realtime reports (if the table is in the publication). RLS
 * only lets admins count; for anyone else, or on error, there's no badge.
 */
function useOpenMessageCount() {
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      const { count: open, error } = await supabase
        .from("admin_messages")
        .select("id", { count: "exact", head: true })
        .eq("status", "open");
      if (!disposed) setCount(error ? null : open);
    }

    void load();
    const channel = supabase
      .channel("admin_messages:nav-badge")
      .on("postgres_changes", { event: "*", schema: "public", table: "admin_messages" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 300);
      })
      .subscribe();

    return () => {
      disposed = true;
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [pathname]);

  return count;
}

export function SidebarNav() {
  const pathname = usePathname();
  const openBadge = badgeLabel(useOpenMessageCount());

  return (
    <nav className="mt-6 space-y-1">
      {NAV_LINKS.map((link) => {
        const active = pathname === link.href;
        const badge = link.href === "/messages" ? openBadge : null;
        return (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center justify-between rounded-lg px-3 py-2 text-sm"
            style={
              active
                ? { background: "var(--kb-navy-raised)", color: "var(--kb-on-navy)", fontWeight: 600 }
                : { color: "var(--kb-on-navy-soft)" }
            }
          >
            {link.label}
            {badge && (
              <span
                className="ml-2 min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] leading-none font-semibold text-white"
                style={{ background: "var(--kb-danger)" }}
                aria-label={`${badge} open message${badge === "1" ? "" : "s"}`}
              >
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
