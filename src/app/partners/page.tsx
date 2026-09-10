import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { TopBar } from "@/components/TopBar";
import { setPartnerActive } from "@/lib/actions";
import type { Profile } from "@/lib/types-auth";

export default async function PartnersPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return <LoginForm />;

  const { data: viewerProfile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single<Profile>();

  if (!viewerProfile || viewerProfile.role !== "admin") return <NotAuthorized />;

  const { data: partners } = await supabase
    .from("profiles")
    .select("*")
    .in("role", ["cook", "rider", "picker"])
    .order("created_at", { ascending: false })
    .returns<Profile[]>();

  const list = partners ?? [];
  const cooks = list.filter((p) => p.role === "cook");
  const riders = list.filter((p) => p.role === "rider");
  const pickers = list.filter((p) => p.role === "picker");

  return (
    <div className="min-h-screen px-4 py-6 sm:px-6" style={{ background: "var(--kb-navy)" }}>
      <div className="mx-auto max-w-2xl">
        <TopBar />
        <Link href="/" className="mt-4 inline-block text-sm" style={{ color: "var(--kb-green)" }}>
          &larr; Back to Command Centre
        </Link>

        <h1 className="mt-4 font-display text-xl font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Manage Partners
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--kb-on-navy-soft)" }}>
          Disabling a partner blocks them from accepting new orders/deliveries without deleting their account (handover doc section 16/21 — temporary block, not permanent deletion).
        </p>

        <h2 className="mt-6 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Cooks ({cooks.length})
        </h2>
        <div className="mt-3 space-y-2">
          {cooks.length === 0 && (
            <p className="rounded-2xl bg-white p-4 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
              No approved cooks yet.
            </p>
          )}
          {cooks.map((p) => (
            <PartnerRow key={p.id} profile={p} />
          ))}
        </div>

        <h2 className="mt-6 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Riders ({riders.length})
        </h2>
        <div className="mt-3 space-y-2">
          {riders.length === 0 && (
            <p className="rounded-2xl bg-white p-4 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
              No approved riders yet.
            </p>
          )}
          {riders.map((p) => (
            <PartnerRow key={p.id} profile={p} />
          ))}
        </div>

        <h2 className="mt-6 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Pickers ({pickers.length})
        </h2>
        <div className="mt-3 space-y-2">
          {pickers.length === 0 && (
            <p className="rounded-2xl bg-white p-4 text-sm shadow-lg" style={{ color: "var(--kb-ink-soft)" }}>
              No approved pickers yet.
            </p>
          )}
          {pickers.map((p) => (
            <PartnerRow key={p.id} profile={p} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PartnerRow({ profile }: { profile: Profile }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
      <div>
        <p className="text-sm font-semibold">{profile.full_name || "(no name on file)"}</p>
        <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>
          {profile.is_active ? "Active" : "Blocked"}
        </p>
      </div>
      <form action={setPartnerActive.bind(null, profile.id, !profile.is_active)}>
        <button
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
          style={{ background: profile.is_active ? "var(--kb-danger)" : "var(--kb-green-deep)" }}
        >
          {profile.is_active ? "Block" : "Reinstate"}
        </button>
      </form>
    </div>
  );
}