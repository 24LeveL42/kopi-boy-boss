import { ASSISTED_AUDIT_LABEL, bulkAuditSummary, type AssistedAuditRow } from "@/lib/assisted-onboarding";
import { auditValue } from "@/lib/kitchen-admin";

const WHEN = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type Change = { old?: unknown; new?: unknown };

/** Field changes from a draft or item row's details ({field: {old, new}}, items nested under "changes"). */
function changesOf(row: AssistedAuditRow): [string, Change][] {
  const d = row.details ?? {};
  const source = (row.action.startsWith("item_") ? d.changes : d) as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return [];
  return Object.entries(source).filter(
    (e): e is [string, Change] => !!e[1] && typeof e[1] === "object" && ("old" in (e[1] as object) || "new" in (e[1] as object))
  );
}

/** One-line extras: a reason, an expiry, or what the claim recorded. Never a token (none is stored). */
function extraOf(row: AssistedAuditRow): string | null {
  const d = row.details ?? {};
  const parts: string[] = [];
  const bulk = bulkAuditSummary(row.action, d);
  if (bulk) parts.push(bulk);
  if (typeof d.reason === "string" && d.reason) parts.push(`Reason: ${d.reason}`);
  if (row.action === "link_issued" && typeof d.expires_at === "string") parts.push(`Expires ${WHEN.format(new Date(d.expires_at))}`);
  if (row.action === "claimed") {
    if (typeof d.acknowledged_terms_at === "string") parts.push(`Terms acknowledged ${WHEN.format(new Date(d.acknowledged_terms_at))}`);
    if (typeof d.privacy_policy_version === "string") parts.push(`Privacy policy ${d.privacy_policy_version}`);
    if (typeof d.menu_items === "number") parts.push(`${d.menu_items} menu item${d.menu_items === 1 ? "" : "s"} copied`);
    if (typeof d.user_agent === "string" && d.user_agent) parts.push(`Device: ${auditValue(d.user_agent)}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The draft's history from assisted_onboarding_audit: create, edits, links
 * issued / sent / revoked, cancel and the owner's claim. Rows are written by
 * the database only and can't be edited or deleted. The owner mobile
 * arrives already masked.
 */
export function AssistedAuditLog({ rows, names }: { rows: AssistedAuditRow[]; names: Map<string, string> }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
        No history yet.
      </p>
    );
  }
  return (
    <ol className="space-y-3">
      {rows.map((row) => {
        const fields = changesOf(row);
        const extra = extraOf(row);
        const who = row.actor_kind === "owner" ? `Owner${row.actor_id && names.get(row.actor_id) ? ` (${names.get(row.actor_id)})` : ""}` : (row.actor_id && names.get(row.actor_id)) || "Admin";
        return (
          <li key={row.id} className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--oc-line)" }}>
            <p className="font-semibold" style={{ color: "var(--oc-text)" }}>
              {ASSISTED_AUDIT_LABEL[row.action] ?? row.action}
            </p>
            <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
              {who} · {WHEN.format(new Date(row.created_at))}
              {extra && <> · {extra}</>}
            </p>
            {fields.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-xs" style={{ color: "var(--oc-text)" }}>
                {fields.map(([field, change]) => (
                  <li key={field}>
                    <span className="font-mono">{field}</span>:{" "}
                    {row.action === "shop_created" || row.action === "item_added" ? auditValue(change.new) : <>{auditValue(change.old)} → {auditValue(change.new)}</>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
