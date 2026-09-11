"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { label: "Command Centre", href: "/" },
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

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="mt-6 space-y-1">
      {NAV_LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className="block rounded-lg px-3 py-2 text-sm"
            style={
              active
                ? { background: "var(--kb-navy-raised)", color: "var(--kb-on-navy)", fontWeight: 600 }
                : { color: "var(--kb-on-navy-soft)" }
            }
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
