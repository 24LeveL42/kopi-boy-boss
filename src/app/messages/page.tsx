import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { AdminMessageCard } from "@/components/AdminMessageCard";
import { AdminMessagesRealtimeRefresher } from "@/components/AdminMessagesRealtimeRefresher";
import { hasAdminRole, requireAdmin } from "@/lib/require-admin";
import { formatSgTime } from "@/lib/complaints";
import {
  ADMIN_MESSAGES_FETCH_LIMIT,
  INBOX_VIEWS,
  countByStatus,
  messagesForView,
  parseInboxView,
  senderRoleLabel,
  type AdminMessageRow,
} from "@/lib/admin-messages";

type SenderRow = { id: string; full_name: string | null; role: string; is_active: boolean };

const SUBTITLE = "Messages riders and cooks send to HQ from the Partner app. Reply, close them when sorted, or unblock a blocked sender.";

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const view = parseInboxView((await searchParams).view);
  const { supabase, user } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const { data: messages, error } = await supabase
    .from("admin_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(ADMIN_MESSAGES_FETCH_LIMIT)
    .returns<AdminMessageRow[]>();

  if (error) {
    return (
      <AdminShell title="Messages" subtitle={SUBTITLE}>
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-danger)" }}>
          Couldn&apos;t load messages: {error.message}
        </p>
      </AdminShell>
    );
  }

  const all = messages ?? [];
  const senderIds = [...new Set(all.map((m) => m.sender_id))];
  const { data: senders } = senderIds.length
    ? await supabase.from("profiles").select("id, full_name, role, is_active").in("id", senderIds).returns<SenderRow[]>()
    : { data: [] as SenderRow[] };
  const senderById = new Map((senders ?? []).map((s) => [s.id, s]));

  const counts = countByStatus(all);
  const shown = messagesForView(all, view);

  return (
    <AdminShell title="Messages" subtitle={SUBTITLE}>
      <nav className="mb-4 flex flex-wrap items-center gap-2 text-sm" aria-label="Message filter">
        {INBOX_VIEWS.map((t) => (
          <Link
            key={t.view}
            href={t.view === "open" ? "/messages" : `/messages?view=${t.view}`}
            aria-current={view === t.view ? "page" : undefined}
            className="rounded-full px-3 py-1.5 font-medium"
            style={
              view === t.view
                ? { background: "var(--kb-green)", color: "var(--kb-navy)" }
                : { background: "var(--kb-navy-raised)", color: "var(--kb-on-navy-soft)" }
            }
          >
            {t.label} ({counts[t.view]})
          </Link>
        ))}
        <AdminMessagesRealtimeRefresher />
      </nav>

      {shown.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
          {all.length === 0
            ? "No messages yet. They appear here when a rider or cook writes to HQ from the Partner app."
            : view === "all"
              ? "No messages."
              : `No ${view} messages.`}
        </p>
      ) : (
        <div className="space-y-3">
          {shown.map((m) => {
            const sender = senderById.get(m.sender_id);
            return (
              <AdminMessageCard
                key={m.id}
                message={m}
                senderName={sender?.full_name || `Partner ${m.sender_id.slice(0, 8)}`}
                senderRole={senderRoleLabel(m.sender_role || sender?.role)}
                senderBlocked={sender ? !sender.is_active : false}
                sentAt={formatSgTime(m.created_at)}
                repliedAt={m.replied_at ? formatSgTime(m.replied_at) : null}
              />
            );
          })}
        </div>
      )}
    </AdminShell>
  );
}
