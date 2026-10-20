import {
  approveCookApplication,
  rejectCookApplication,
  approveRiderApplication,
  rejectRiderApplication,
} from "@/lib/actions";
import type { CookApplication, Profile, RiderApplication } from "@/lib/types-auth";
import { fetchEmailsById } from "@/lib/contacts";
import type { createClient } from "@/lib/supabase/server";
import { formatSgTime } from "@/lib/complaints";
import { ActionButton } from "../ActionButton";
import { ApplicantPhoto } from "../ApplicantPhoto";
import { ContactLine } from "../ContactLine";
import { Card } from "./EmptyState";
import { StatusPill } from "./StatusPill";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Pending applications of one kind, oldest first, with each applicant's profile and email. */
export async function loadPendingApplications<T extends CookApplication | RiderApplication>(
  supabase: Supabase,
  table: "cook_applications" | "rider_applications"
) {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .returns<T[]>();
  const apps = data ?? [];
  const ids = apps.map((a) => a.user_id);
  const [{ data: profiles }, emailById] = await Promise.all([
    ids.length
      ? supabase.from("profiles").select("*").in("id", ids).returns<Profile[]>()
      : Promise.resolve({ data: [] as Profile[] }),
    fetchEmailsById(supabase, ids),
  ]);
  return {
    apps,
    error: error?.message ?? null,
    applicantById: new Map((profiles ?? []).map((p) => [p.id, p])),
    emailById,
  };
}

type Loaded<T extends CookApplication | RiderApplication> = Awaited<ReturnType<typeof loadPendingApplications<T>>>;

function Shell({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <Card className="mb-6 overflow-hidden">
      <header className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
        <h2 className="text-sm font-semibold">{title}</h2>
        <StatusPill tone="blue">{count} to check</StatusPill>
      </header>
      <ul>{children}</ul>
    </Card>
  );
}

const rowClass = "flex items-center justify-between gap-6 border-b px-4 py-3 last:border-b-0";
const soft = { color: "var(--oc-text-soft)" };

/** Cook sign-ups waiting for HQ, with the same Approve / Reject actions the old Command Centre had. */
export function PendingCookApplications({ loaded }: { loaded: Loaded<CookApplication> }) {
  const { apps, applicantById, emailById } = loaded;
  if (apps.length === 0) return null;
  return (
    <Shell title="Merchants waiting for approval" count={apps.length}>
      {apps.map((app) => {
        const applicant = applicantById.get(app.user_id);
        return (
          <li key={app.id} className={rowClass} style={{ borderColor: "var(--oc-line)" }}>
            <div className="grid min-w-0 flex-1 grid-cols-3 gap-6 text-sm">
              <div className="min-w-0">
                <p className="font-semibold">{app.business_name}</p>
                <p className="text-xs" style={soft}>
                  {[app.business_type, app.neighbourhood].filter(Boolean).join(" · ") || "No business type given"}
                </p>
                {app.business_uen && (
                  <p className="text-xs" style={soft}>
                    UEN <span className="font-mono font-semibold" style={{ color: "var(--oc-text)" }}>{app.business_uen}</span>
                    {" "}· check on ACRA BizFile before approving
                  </p>
                )}
                {app.description && <p className="mt-1 text-xs" style={soft}>{app.description}</p>}
              </div>
              <div className="min-w-0">
                <p className="font-medium">{applicant?.full_name || "(no name on file)"}</p>
                <ContactLine phone={applicant?.phone} email={emailById.get(app.user_id)} />
              </div>
              <div className="min-w-0 text-xs" style={soft}>
                <p style={{ color: "var(--oc-text)" }}>{app.business_address || "No pickup address given"}</p>
                {app.postal_code && <p>Singapore {app.postal_code}</p>}
                <p className="mt-1">Applied {formatSgTime(app.created_at)}</p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <ActionButton
                action={approveCookApplication.bind(null, app.id, app.user_id)}
                label="Approve"
                pendingLabel="Approving…"
                background="var(--kb-green-deep)"
              />
              <ActionButton
                action={rejectCookApplication.bind(null, app.id)}
                label="Reject"
                pendingLabel="Rejecting…"
                background="var(--oc-grey-bg)"
                color="var(--oc-text)"
              />
            </div>
          </li>
        );
      })}
    </Shell>
  );
}

/** Rider sign-ups waiting for HQ, photo first so identity can be checked before approving. */
export function PendingRiderApplications({ loaded }: { loaded: Loaded<RiderApplication> }) {
  const { apps, applicantById, emailById } = loaded;
  if (apps.length === 0) return null;
  return (
    <Shell title="Riders waiting for approval" count={apps.length}>
      {apps.map((app) => {
        const applicant = applicantById.get(app.user_id);
        return (
          <li key={app.id} className={rowClass} style={{ borderColor: "var(--oc-line)" }}>
            <div className="flex min-w-0 flex-1 items-center gap-4 text-sm">
              <ApplicantPhoto url={app.photo_url} userId={app.user_id} name={applicant?.full_name || "the applicant"} />
              <div className="min-w-0">
                <p className="font-semibold">{applicant?.full_name || "(no name on file)"}</p>
                <p className="text-xs" style={soft}>
                  {app.vehicle_type || "No vehicle given"}
                  {app.license_plate && ` · ${app.license_plate}`}
                </p>
                <ContactLine phone={applicant?.phone} email={emailById.get(app.user_id)} />
                <p className="text-xs" style={soft}>Applied {formatSgTime(app.created_at)}</p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <ActionButton
                action={approveRiderApplication.bind(null, app.id, app.user_id)}
                label="Approve"
                pendingLabel="Approving…"
                background="var(--kb-green-deep)"
              />
              <ActionButton
                action={rejectRiderApplication.bind(null, app.id)}
                label="Reject"
                pendingLabel="Rejecting…"
                background="var(--oc-grey-bg)"
                color="var(--oc-text)"
              />
            </div>
          </li>
        );
      })}
    </Shell>
  );
}
