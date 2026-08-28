# Kopi Boy HQ

Admin control center — merchants, riders, orders, complaints, refunds,
ratings, subscriptions, delivery pricing, platform settings (handover doc
section 22). Next.js 16 + TypeScript + Tailwind v4, same design tokens as
Kopi Boy Customer and Kopi Boy Partner.

## Getting started
```bash
npm install
npm run dev   # http://localhost:3000
npm run build
```

## Current status: Feature #001-equivalent — Foundation + shell

- Sidebar nav for all 9 admin sections from the spec (links are
  placeholders — each becomes a real screen in Feature #011)
- Dashboard metrics cards (orders, active merchants/riders, subscription
  revenue, complaints, refunds, incidents) — demo numbers
- Pending approvals list with Approve/Reject buttons (not yet wired to a
  backend)
- No RBAC yet (Super Admin / Operations Admin / Support Admin) — that's
  Feature #002

Demo data only — `src/lib/demo-data.ts`.
