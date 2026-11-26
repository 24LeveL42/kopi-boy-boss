import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Card, LoadError } from "@/components/ops/EmptyState";
import { StatusPill } from "@/components/ops/StatusPill";
import { getViewer, hasAdminRole } from "@/lib/require-admin";
import { billingStateFrom, PILOT_TERMS, PILOT_TERMS_VERSION } from "@/lib/pilot-terms";

export default async function BillingPage() {
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const { data, error } = await supabase.from("billing_settings").select("billing_enabled").eq("id", true).maybeSingle();
  const state = billingStateFrom(data, error);

  return (
    <AdminShell
      title="Billing (off)"
      subtitle="Kopi Boy is free for merchants during the pilot. Billing is switched off. Any future commission is capped at 15% of food sales after discounts, delivery fee excluded, with at least 30 days' written notice."
    >
      {state.kind === "error" && <LoadError what="the billing switch" message={state.message} />}
      <Card className="p-5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
          {state.kind === "off" && (
            <StatusPill tone="green" title="billing_settings.billing_enabled = false">
              Billing: OFF · {PILOT_TERMS_VERSION}
            </StatusPill>
          )}
          {state.kind === "on" && (
            <StatusPill tone="red" title="billing_settings.billing_enabled = true">
              Billing: ON · this should not happen during the pilot
            </StatusPill>
          )}
          {state.kind === "error" && (
            <StatusPill tone="amber" title="The billing switch could not be read">
              Billing: unknown · {PILOT_TERMS_VERSION}
            </StatusPill>
          )}
        </p>
        <p className="mt-3 text-sm" style={{ color: "var(--oc-text-soft)" }}>
          Billing is off for the pilot. No merchant is charged.
        </p>
        <h2 className="mt-5 text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
          Pilot Partner Terms
        </h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm" style={{ color: "var(--oc-text-soft)" }}>
          {PILOT_TERMS.map((term) => (
            <li key={term}>{term}</li>
          ))}
        </ol>
      </Card>
    </AdminShell>
  );
}
