// DEMO DATA ONLY — replaces with real Supabase aggregate queries in Feature #011.

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

export const PENDING_APPROVALS = [
  { id: "APP-201", name: "Serangoon Curry Puff Co.", type: "Home Cook", submitted: "2 days ago" },
  { id: "APP-200", name: "Bishan Roti Prata Stall", type: "Hawker", submitted: "3 days ago" },
  { id: "RID-088", name: "Hafiz Rahman (Rider)", type: "Rider", submitted: "5 hours ago" },
];
