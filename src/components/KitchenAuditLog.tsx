import { AUDIT_ACTION_LABEL, auditValue, type AuditRow } from "@/lib/kitchen-admin";

const WHEN = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * The kitchen's change history from kitchen_admin_audit: who (admin), what
 * (field, old -> new) and when. Rows are written by database triggers only
 * and can't be edited or deleted. PayNow values arrive already masked.
 */
export function KitchenAuditLog({
  rows,
  adminNames,
  itemNames,
}: {
  rows: AuditRow[];
  adminNames: Map<string, string>;
  itemNames: Map<string, string>;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
        No HQ changes yet.
      </p>
    );
  }
  return (
    <ol className="space-y-3">
      {rows.map((row) => {
        const fields = Object.entries(row.changes ?? {});
        const itemName =
          row.target_table === "menu_items"
            ? itemNames.get(row.target_id) ?? (typeof row.changes?.name?.new === "string" ? row.changes.name.new : null)
            : null;
        return (
          <li key={row.id} className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--oc-line)" }}>
            <p style={{ color: "var(--oc-text)" }}>
              <span className="font-semibold">{AUDIT_ACTION_LABEL[row.action] ?? row.action}</span>
              {itemName && <> · {itemName}</>}
            </p>
            <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
              {adminNames.get(row.admin_id) ?? "Admin"} · {WHEN.format(new Date(row.created_at))}
              {row.reason && <> · Reason: {row.reason}</>}
            </p>
            {fields.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-xs" style={{ color: "var(--oc-text)" }}>
                {fields.map(([field, change]) => (
                  <li key={field}>
                    <span className="font-mono">{field}</span>: {auditValue(change?.old)} → {auditValue(change?.new)}
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
