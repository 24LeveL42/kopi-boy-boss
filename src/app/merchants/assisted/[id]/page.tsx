import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Card, LoadError } from "@/components/ops/EmptyState";
import { AssistedShopForm } from "@/components/AssistedShopForm";
import { AssistedMenuEditor } from "@/components/AssistedMenuEditor";
import { ClaimLinkPanel } from "@/components/ClaimLinkPanel";
import { CancelAssistedShop } from "@/components/CancelAssistedShop";
import { AssistedAuditLog } from "@/components/AssistedAuditLog";
import { getViewer, hasAdminRole } from "@/lib/require-admin";
import {
  ASSISTED_AUDIT_COLUMNS,
  ASSISTED_ITEM_COLUMNS,
  ASSISTED_SHOP_COLUMNS,
  claimReadiness,
  formatSgt,
  loadClaimLinksWith,
  toDraftItem,
  type AssistedAuditRow,
  type AssistedShop,
} from "@/lib/assisted-onboarding";
import type { MenuItem } from "@/lib/types-kitchen";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function BackLink() {
  return (
    <Link href="/merchants/assisted" className="text-sm font-medium underline" style={{ color: "var(--oc-accent)" }}>
      Back to assisted onboarding
    </Link>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-4 p-5">
      <h2 className="mb-1 text-base font-semibold" style={{ color: "var(--oc-text)" }}>
        {title}
      </h2>
      {hint && (
        <p className="mb-4 text-sm" style={{ color: "var(--oc-text-soft)" }}>
          {hint}
        </p>
      )}
      {!hint && <div className="mb-3" />}
      {children}
    </Card>
  );
}

export default async function AssistedShopPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const notFound = (
    <AdminShell title="Assisted shop not found" subtitle="Check the link, or open it from the assisted onboarding list.">
      <Card className="mb-4 p-5 text-sm">No assisted shop with this ID.</Card>
      <BackLink />
    </AdminShell>
  );
  if (!UUID.test(id)) return notFound;

  const [shopResult, itemsResult, linksResult, auditResult] = await Promise.all([
    supabase.from("assisted_shops").select(ASSISTED_SHOP_COLUMNS).eq("id", id).maybeSingle<AssistedShop>(),
    supabase.from("assisted_shop_items").select(ASSISTED_ITEM_COLUMNS).eq("shop_id", id).order("created_at"),
    loadClaimLinksWith(supabase, id),
    supabase
      .from("assisted_onboarding_audit")
      .select(ASSISTED_AUDIT_COLUMNS)
      .eq("shop_id", id)
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<AssistedAuditRow[]>(),
  ]);

  if (shopResult.error) {
    return (
      <AdminShell title="Can't open this assisted shop" subtitle="The draft didn't load, so editing is switched off to protect it.">
        <LoadError what="the assisted shop" message={shopResult.error.message} />
        <BackLink />
      </AdminShell>
    );
  }
  const shop = shopResult.data;
  if (!shop) return notFound;

  const items = ((itemsResult.data ?? []) as Record<string, unknown>[]).map(toDraftItem).filter((i): i is MenuItem => i !== null);
  const isDraft = shop.status === "draft";
  const missing = claimReadiness(shop, items);
  const audit = auditResult.data ?? [];

  // Names for the history: the admins, and the owner once claimed.
  const actorIds = [...new Set(audit.map((r) => r.actor_id).filter((a): a is string => !!a))];
  const { data: people } = actorIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", actorIds).returns<{ id: string; full_name: string | null }[]>()
    : { data: [] as { id: string; full_name: string | null }[] };
  const names = new Map((people ?? []).map((p) => [p.id, p.full_name?.trim() || "Admin"]));

  const subtitle = isDraft
    ? "A draft: nothing is visible to customers. When it's ready, create the claim link and send it to the owner on WhatsApp."
    : shop.status === "claimed"
      ? "The owner has claimed this shop. Edit the live kitchen from its merchant page; this draft is kept as a record."
      : "This draft was cancelled. It's kept as a record and can't be changed.";

  return (
    <AdminShell title={shop.business_name} subtitle={subtitle}>
      {shop.status === "claimed" && (
        <Card className="mb-4 p-5 text-sm">
          <p style={{ color: "var(--oc-text)" }}>
            Claimed {shop.claimed_at ? formatSgt(shop.claimed_at) : ""}
            {shop.acknowledged_at && <> · partner terms acknowledged {formatSgt(shop.acknowledged_at)}</>}
          </p>
          <p className="mt-1" style={{ color: "var(--oc-text-soft)" }}>
            The kitchen goes live when the owner saves their PayNow details in the Partner app.
          </p>
          {shop.claimed_user_id && (
            <Link
              href={`/merchants/${shop.claimed_user_id}/edit`}
              className="mt-2 inline-block font-medium underline"
              style={{ color: "var(--oc-accent)" }}
            >
              Open the merchant&apos;s kitchen
            </Link>
          )}
        </Card>
      )}

      <Section title="Shop details">
        <AssistedShopForm shop={shop} readOnly={!isDraft} />
      </Section>

      <Section
        title="Menu"
        hint={isDraft ? "Visible items become the shop's menu when the owner claims it. Hidden items aren't copied." : undefined}
      >
        {itemsResult.error ? (
          // Never show the editor over a failed read: the menu would look empty.
          <LoadError what="the draft menu" message={itemsResult.error.message} />
        ) : isDraft ? (
          <AssistedMenuEditor shopId={shop.id} initialItems={items} />
        ) : (
          <ul className="space-y-1 text-sm" style={{ color: "var(--oc-text)" }}>
            {items.map((i) => (
              <li key={i.id} style={{ opacity: i.is_hidden ? 0.6 : 1 }}>
                {i.name} · ${Number(i.price).toFixed(2)}
                {i.is_hidden && " (hidden, not copied)"}
              </li>
            ))}
            {items.length === 0 && <li style={{ color: "var(--oc-text-soft)" }}>No items.</li>}
          </ul>
        )}
      </Section>

      <Section title="Claim link">
        <ClaimLinkPanel
          shopId={shop.id}
          businessName={shop.business_name}
          ownerName={shop.owner_name}
          ownerMobile={shop.owner_mobile}
          isDraft={isDraft}
          missing={itemsResult.error ? ["The draft menu didn't load. Reload the page."] : missing}
          links={linksResult.ok ? linksResult.links : []}
          linksError={linksResult.ok ? null : linksResult.message}
        />
      </Section>

      <Section title="History">
        {auditResult.error ? (
          <LoadError what="the history" message={auditResult.error.message} />
        ) : (
          <AssistedAuditLog rows={audit} names={names} />
        )}
      </Section>

      {isDraft && (
        <Card className="mb-4 p-5">
          <CancelAssistedShop shopId={shop.id} />
        </Card>
      )}

      <BackLink />
    </AdminShell>
  );
}
