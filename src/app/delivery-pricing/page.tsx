import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { requireAdmin } from "@/lib/require-admin";

export default async function DeliveryPricingPage() {
  const { user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  return (
    <AdminShell
      title="Delivery Pricing"
      subtitle="Locked formula — app may only show it as a suggested/estimated fee; cook and helper agree the final amount."
    >
      <div className="rounded-2xl bg-white p-5 shadow-lg" style={{ color: "var(--kb-ink)" }}>
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <dt style={{ color: "var(--kb-ink-soft)" }}>Base fee</dt>
            <dd className="font-semibold">$3.00 (first 2km total helper travel)</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt style={{ color: "var(--kb-ink-soft)" }}>Beyond base distance</dt>
            <dd className="font-semibold">$0.60 / km</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt style={{ color: "var(--kb-ink-soft)" }}>Minimum fee</dt>
            <dd className="font-semibold">$3.00</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt style={{ color: "var(--kb-ink-soft)" }}>Rounding</dt>
            <dd className="font-semibold">Nearest $0.50</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs" style={{ color: "var(--kb-ink-soft)" }}>
          &ldquo;Total helper travel&rdquo; = helper&apos;s current location to kitchen, plus kitchen to customer, combined.
          100% of the delivery fee goes to the rider. Not yet editable here — update in code when the formula changes.
        </p>
      </div>
    </AdminShell>
  );
}
