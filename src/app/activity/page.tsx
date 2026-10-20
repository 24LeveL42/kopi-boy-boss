import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { DataTable } from "@/components/ops/DataTable";
import { Card, EmptyState } from "@/components/ops/EmptyState";
import { requireAdmin } from "@/lib/require-admin";

const COLUMNS = [{ label: "Time" }, { label: "Who" }, { label: "Action" }, { label: "Details" }];

export default async function ActivityLogPage() {
  const { user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  return (
    <AdminShell title="Activity log" subtitle="A record of what HQ admins did: approvals, blocks, replies and edits.">
      <Card className="overflow-hidden">
        <DataTable
          columns={COLUMNS}
          rows={[]}
          noun="entries"
          searchPlaceholder="Search who, action or details…"
          empty={
            <EmptyState>
              Admin actions aren&apos;t written to an activity table in the database yet, so there&apos;s nothing to list.
              For what&apos;s happening with orders right now, see{" "}
              <Link href="/" className="font-medium underline" style={{ color: "var(--oc-accent)" }}>
                Live activity on the Overview
              </Link>
              .
            </EmptyState>
          }
        />
      </Card>
    </AdminShell>
  );
}
