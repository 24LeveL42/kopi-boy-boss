import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Card, EmptyState, LoadError } from "@/components/ops/EmptyState";
import { getViewer, hasAdminRole } from "@/lib/require-admin";
import { formatSgTime } from "@/lib/complaints";
import {
  buildFunnel,
  errorLabel,
  errorsByField,
  fieldLabel,
  formatPct,
  normalizeReport,
  pct,
  rates,
  resolveRangeNow,
  signinRows,
  type Rate,
  type RegistrationReport,
  type ResolvedRange,
} from "@/lib/registration-analytics";

type Search = { range?: string | string[]; from?: string | string[]; to?: string | string[] };

/**
 * Cook sign-up funnel from the Partner app's anonymous registration events.
 * Read-only: one call to public.admin_registration_analytics(), which checks
 * admin itself and returns counts only (no rows, no session ids). Test
 * sessions are left out by the function.
 */
export default async function RegistrationAnalyticsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const { supabase, user } = await getViewer();
  if (!user) return <LoginForm />;
  if (!(await hasAdminRole(supabase))) return <NotAuthorized />;

  const range = resolveRangeNow(params);
  const { data, error } = await supabase.rpc("admin_registration_analytics", {
    p_from: range.fromIso,
    p_to: range.toIso,
  });
  const report = error ? null : normalizeReport(data);

  return (
    <AdminShell
      title="Registration analytics"
      subtitle="Where new cooks give up on the Partner app sign-up. Every number is a count of browser sessions; test sessions are left out."
    >
      <RangeFilter range={range} />
      {range.error && (
        <p className="mb-4 rounded-[14px] px-4 py-3 text-sm" style={{ background: "var(--oc-amber-bg)", color: "var(--oc-amber-fg)" }} role="alert">
          {range.error} Showing the last 7 days instead.
        </p>
      )}
      {error && <LoadError what="registration analytics" message={error.message} />}
      {!error && !report && <LoadError what="registration analytics" message="the report came back empty." />}
      {report && <Report report={report} range={range} />}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
] as const;

function RangeFilter({ range }: { range: ResolvedRange }) {
  return (
    <Card className="mb-5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <nav className="flex flex-wrap gap-1.5" aria-label="Date range">
          {PRESETS.map((p) => {
            const active = range.preset === p.key;
            return (
              <Link
                key={p.key}
                href={`/registration-analytics?range=${p.key}`}
                aria-current={active ? "page" : undefined}
                className="rounded-lg px-3 py-1.5 text-sm font-medium"
                style={
                  active
                    ? { background: "var(--oc-accent)", color: "white" }
                    : { background: "var(--oc-grey-bg)", color: "var(--oc-text)" }
                }
              >
                {p.label}
              </Link>
            );
          })}
        </nav>
        <form method="get" action="/registration-analytics" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="range" value="custom" />
          <label className="flex flex-col text-xs" style={{ color: "var(--oc-text-soft)" }}>
            From
            <input
              type="date"
              name="from"
              required
              defaultValue={range.fromDay}
              className="mt-0.5 rounded-lg border px-2 py-1 text-sm"
              style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)", background: "var(--oc-card)" }}
            />
          </label>
          <label className="flex flex-col text-xs" style={{ color: "var(--oc-text-soft)" }}>
            To
            <input
              type="date"
              name="to"
              required
              defaultValue={range.toDay}
              className="mt-0.5 rounded-lg border px-2 py-1 text-sm"
              style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)", background: "var(--oc-card)" }}
            />
          </label>
          <button
            type="submit"
            className="rounded-lg px-3 py-1.5 text-sm font-medium"
            style={
              range.preset === "custom"
                ? { background: "var(--oc-accent)", color: "white" }
                : { background: "var(--oc-grey-bg)", color: "var(--oc-text)" }
            }
          >
            Custom
          </button>
        </form>
      </div>
      <p className="mt-2 text-xs" style={{ color: "var(--oc-text-soft)" }}>
        Showing <strong style={{ color: "var(--oc-text)" }}>{range.label}</strong> (Singapore time). A session belongs to
        the day it started.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Report({ report, range }: { report: RegistrationReport; range: ResolvedRange }) {
  const meta = (
    <p className="mb-4 text-xs" style={{ color: "var(--oc-text-soft)" }}>
      {report.sessions} session{report.sessions === 1 ? "" : "s"} in this period
      {report.test_sessions_excluded > 0 &&
        ` · ${report.test_sessions_excluded} test session${report.test_sessions_excluded === 1 ? "" : "s"} left out`}
      {report.tracking_since ? ` · tracking since ${formatSgTime(report.tracking_since)}` : ""}
    </p>
  );

  if (report.sessions === 0) {
    return (
      <>
        {meta}
        <Card>
          <EmptyState title="No data yet">
            {report.tracking_since ? (
              <>No sign-up sessions started in this period ({range.label}). Try a longer range.</>
            ) : (
              <>
                No sign-up sessions have been recorded yet. Numbers appear here once someone opens the sign-in or cook
                registration screen in the Partner app (test devices and HQ accounts are never counted).
              </>
            )}
          </EmptyState>
        </Card>
      </>
    );
  }

  const r = rates(report);
  const funnel = buildFunnel(report);
  const visitors = report.events.cook_form_view ?? 0;

  return (
    <>
      {meta}
      {report.sessions < 30 && (
        <p
          className="mb-4 rounded-[14px] px-4 py-3 text-sm"
          style={{ background: "var(--oc-blue-bg)", color: "var(--oc-blue-fg)" }}
        >
          Small sample: {report.sessions} session{report.sessions === 1 ? "" : "s"}. One person more or less moves these
          percentages a lot, so read the counts beside them.
        </p>
      )}

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Visitors to the cook registration page"
          value={visitors}
          sub={`${report.events.page_view ?? 0} reached “Join as a partner” · ${report.events.signin_view ?? 0} saw sign-in`}
        />
        <Stat label="Form starts" value={report.started} sub="Focused at least one cook form field" />
        <Stat label="Submissions" value={report.submitted} sub="Application submitted" />
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <RateStat label="Conversion" rate={r.conversion} of="submitted of visitors" />
        <RateStat label="Completion" rate={r.completion} of="submitted of form starts" />
        <RateStat
          label="Estimated abandonment"
          rate={r.abandonment}
          of="started, not submitted, idle 30+ min, of form starts"
          sub={report.in_progress > 0 ? `${report.in_progress} still in progress (active in the last 30 min), not counted` : undefined}
        />
      </div>

      <Section title="Funnel" hint="In form order. Drop-off is against the step before it that everyone sees.">
        <ol className="divide-y" style={{ borderColor: "var(--oc-line)" }}>
          {funnel.map((s) => (
            <li key={s.key} className="px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium" style={{ color: "var(--oc-text)" }}>
                  {s.step !== undefined && (
                    <span className="mr-1.5 tabular-nums" style={{ color: "var(--oc-text-soft)" }}>
                      {s.step}.
                    </span>
                  )}
                  {s.label}
                </span>
                <span className="text-sm tabular-nums" style={{ color: "var(--oc-text)" }}>
                  <strong>{s.sessions}</strong>
                  <span style={{ color: "var(--oc-text-soft)" }}>
                    {" "}
                    · {formatPct(s.ofStartPct)} of {visitors}
                  </span>
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full" style={{ background: "var(--oc-grey-bg)" }} aria-hidden>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, s.ofStartPct ?? 0)}%`,
                    background: s.conditional ? "var(--oc-text-soft)" : "var(--oc-accent)",
                  }}
                />
              </div>
              {(s.lost !== null && s.baseLabel) || s.note ? (
                <p className="mt-1 text-xs" style={{ color: "var(--oc-text-soft)" }}>
                  {s.lost !== null && s.baseLabel && (
                    <>
                      <span style={{ color: s.lost > 0 ? "var(--oc-red-fg)" : undefined }}>
                        −{s.lost} ({formatPct(s.dropPct)} of {s.baseSessions})
                      </span>{" "}
                      dropped since “{s.baseLabel}”.{" "}
                    </>
                  )}
                  {s.note}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </Section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section
          title="Sign-in"
          hint="The sign-in screen is shared with rider applicants and partners signing back in, so these aren't all cooks."
        >
          <CountList
            rows={signinRows(report).map((x) => ({
              key: x.key,
              label: x.label,
              n: x.sessions,
              hint: x.hint,
              share:
                x.key === "in_app_browser" || x.key === "signin_error" || x.key === "signin_click"
                  ? { base: report.events.signin_view ?? 0, of: "sign-in views" }
                  : undefined,
            }))}
          />
          {report.signin_errors.length > 0 && (
            <>
              <SubHead>Sign-in errors by type</SubHead>
              <CountList rows={report.signin_errors.map((e) => ({ key: e.code, label: errorLabel(e.code), n: e.sessions }))} />
            </>
          )}
        </Section>

        <Section title="Validation errors by field" hint="Sessions that saw each error at least once.">
          {report.validation_errors.length === 0 ? (
            <EmptyState title="No validation errors">None in this period.</EmptyState>
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--oc-line)" }}>
              {errorsByField(report).map((f) => (
                <li key={f.field} className="px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium">{f.label}</span>
                    <span className="tabular-nums" style={{ color: "var(--oc-text-soft)" }}>
                      {f.codes.length > 1 ? `at least ${f.atLeast}` : f.atLeast} of {report.started} started
                    </span>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {f.codes.map((c) => (
                      <li key={c.code} className="flex justify-between gap-3 text-xs" style={{ color: "var(--oc-text-soft)" }}>
                        <span>{c.label}</span>
                        <span className="tabular-nums">{c.sessions}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {report.abandon_last_field.length > 0 && (
        <Section
          title="Last field before leaving"
          hint="From tabs closed mid-form (sent by the browser as it closes, so not every abandonment has one)."
        >
          <CountList
            rows={report.abandon_last_field.map((a) => ({
              key: a.field || "none",
              label: fieldLabel(a.field),
              n: a.sessions,
            }))}
          />
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && (
        <p className="mt-0.5 text-xs" style={{ color: "var(--oc-text-soft)" }}>
          {sub}
        </p>
      )}
    </Card>
  );
}

function RateStat({ label, rate, of, sub }: { label: string; rate: Rate; of: string; sub?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{formatPct(rate.value)}</p>
      <p className="mt-0.5 text-xs tabular-nums" style={{ color: "var(--oc-text-soft)" }}>
        {rate.n} of {rate.base} — {of}
      </p>
      {sub && (
        <p className="mt-0.5 text-xs" style={{ color: "var(--oc-text-soft)" }}>
          {sub}
        </p>
      )}
    </Card>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-5 overflow-hidden">
      <header className="border-b px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && (
          <p className="mt-0.5 text-xs" style={{ color: "var(--oc-text-soft)" }}>
            {hint}
          </p>
        )}
      </header>
      {children}
    </Card>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="border-t px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider"
      style={{ borderColor: "var(--oc-line)", color: "var(--oc-text-soft)" }}
    >
      {children}
    </p>
  );
}

function CountList({
  rows,
}: {
  rows: { key: string; label: string; n: number; hint?: string; share?: { base: number; of: string } }[];
}) {
  return (
    <ul className="divide-y" style={{ borderColor: "var(--oc-line)" }}>
      {rows.map((row) => (
        <li key={row.key} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm" style={{ borderColor: "var(--oc-line)" }}>
          <span className="min-w-0">
            {row.label}
            {row.hint && (
              <span className="block text-xs" style={{ color: "var(--oc-text-soft)" }}>
                {row.hint}
              </span>
            )}
          </span>
          <span className="shrink-0 text-right tabular-nums">
            <strong>{row.n}</strong>
            {row.share && (
              <span className="block text-xs" style={{ color: "var(--oc-text-soft)" }}>
                {formatPct(pct(row.n, row.share.base))} of {row.share.base} {row.share.of}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
