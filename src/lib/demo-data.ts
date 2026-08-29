// DEMO DATA ONLY — replaces with real Supabase aggregate queries in Feature #011.
// Pending approvals are no longer demo data — see HqDashboard.tsx, which
// queries cook_applications/rider_applications directly.

export const METRICS = [
  { label: "Orders today", value: "312" },
  { label: "Active merchants", value: "48" },
  { label: "Active riders", value: "26" },
  { label: "Subscription revenue (MTD)", value: "$1,080" },
  { label: "Open complaints", value: "3" },
  { label: "Refunds this month", value: "$62.50" },
  { label: "Delivery incidents", value: "1" },
];

export const NAV_SECTIONS = [
  "Merchants",
  "Riders",
  "Orders",
  "Complaints",
  "Refunds",
  "Ratings",
  "Subscriptions",
  "Delivery Pricing",
  "Platform Settings",
];
