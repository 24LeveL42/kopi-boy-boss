/**
 * Registration analytics (Boss): turns the aggregated report from
 * public.admin_registration_analytics() (docs/supabase-registration-analytics.sql)
 * into what the page shows — the SGT date range, the funnel in form order,
 * and the rates. No imports, so `node --test` can load it.
 *
 * Every number is a count of sessions (browser tabs). Nothing here makes a
 * number up: a percentage whose base is 0 is null ("—"), and every
 * percentage is shown with its counts beside it.
 */

export type RegistrationReport = {
  from: string;
  to: string;
  generated_at: string;
  tracking_since: string | null;
  sessions: number;
  test_sessions_excluded: number;
  events: Partial<Record<string, number>>;
  fields: { field: string; step: number | null; sessions: number }[];
  validation_errors: { field: string; code: string; sessions: number }[];
  signin_errors: { code: string; sessions: number }[];
  abandon_last_field: { field: string; sessions: number }[];
  started: number;
  submitted: number;
  abandoned: number;
  in_progress: number;
};

/** Same order as COOK_FORM_FIELDS in the Partner app (src/lib/registration-tracking.ts). */
export const COOK_FORM_FIELDS = [
  "full_name",
  "contact_number",
  "business_name",
  "business_type",
  "business_uen",
  "business_address",
  "postal_code",
  "paynow_mobile",
  "paynow_uen",
  "privacy_ack",
] as const;

/** Fields not everyone sees: business UEN is only asked of registered businesses (not Home Cook). */
const CONDITIONAL_FIELDS = new Set<string>(["business_uen"]);

export const FIELD_LABELS: Record<string, string> = {
  full_name: "Full name",
  contact_number: "Contact number",
  business_name: "Business name",
  business_type: "Business type",
  business_uen: "Business UEN",
  business_address: "Business address",
  postal_code: "Postal code",
  paynow_mobile: "PayNow mobile",
  paynow_uen: "PayNow UEN",
  privacy_ack: "Privacy acknowledgement",
};

export const ERROR_LABELS: Record<string, string> = {
  required: "Left empty",
  invalid_format: "Invalid format",
  invalid_postal_code: "Invalid postal code",
  invalid_business_uen: "Invalid business UEN",
  paynow_missing: "PayNow missing",
  invalid_mobile: "Invalid mobile number",
  invalid_uen: "Invalid UEN",
  privacy_required: "Privacy not ticked",
  server_error: "Server error on submit",
  google_error: "Google sign-in error",
  auth_failed: "Sign-in failed",
  google_slow: "Google too slow",
};

export const fieldLabel = (f: string) => (f === "" ? "No field (before any field)" : FIELD_LABELS[f] ?? f);
export const errorLabel = (c: string) => (c === "" ? "No code" : ERROR_LABELS[c] ?? c);

// ---------------------------------------------------------------------------
// Percentages
// ---------------------------------------------------------------------------

/** n as a percentage of base, one decimal. null when base is 0 (no data, not 0%). */
export function pct(n: number, base: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(base) || base <= 0) return null;
  return Math.round((n / base) * 1000) / 10;
}

export function formatPct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

// ---------------------------------------------------------------------------
// Date range (Singapore days)
// ---------------------------------------------------------------------------

export type RangePreset = "today" | "7d" | "30d" | "custom";

export type ResolvedRange = {
  preset: RangePreset;
  /** Inclusive SGT days, YYYY-MM-DD. */
  fromDay: string;
  toDay: string;
  /** What the function is called with: [fromIso, toIso). */
  fromIso: string;
  toIso: string;
  label: string;
  /** Set when a custom range was unusable and the default was used instead. */
  error?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SGT_MS = 8 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 400;

/** The SGT calendar day (YYYY-MM-DD) that contains this instant. */
export function sgDay(ms: number): string {
  return new Date(ms + SGT_MS).toISOString().slice(0, 10);
}

/** 00:00 SGT on this day, as an instant (ms). null if not a real YYYY-MM-DD date. */
function sgDayStartMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null;
  return ms - SGT_MS;
}

function presetRange(preset: "today" | "7d" | "30d", nowMs: number): ResolvedRange {
  const today = sgDay(nowMs);
  const todayStart = sgDayStartMs(today)!;
  const days = preset === "today" ? 1 : preset === "7d" ? 7 : 30;
  const fromMs = todayStart - (days - 1) * DAY_MS;
  return {
    preset,
    fromDay: sgDay(fromMs),
    toDay: today,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(todayStart + DAY_MS).toISOString(),
    label: preset === "today" ? "Today" : `Last ${days} days`,
  };
}

/**
 * Reads ?range=today|7d|30d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD (SGT days,
 * both inclusive). Anything missing or unusable falls back to the last 7
 * days; a bad custom range also says why.
 */
export function resolveRange(
  params: { range?: string | string[]; from?: string | string[]; to?: string | string[] },
  nowMs: number
): ResolvedRange {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const range = one(params.range);
  if (range === "today" || range === "7d" || range === "30d") return presetRange(range, nowMs);
  if (range !== "custom") return presetRange("7d", nowMs);

  const fromDay = one(params.from);
  const toDay = one(params.to);
  const fromMs = sgDayStartMs(fromDay);
  const toMs = sgDayStartMs(toDay);
  const fallback = (error: string) => ({ ...presetRange("7d", nowMs), error });
  if (fromMs === null || toMs === null) return fallback("Pick both a start and an end date.");
  if (toMs < fromMs) return fallback("The start date must be on or before the end date.");
  const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) return fallback(`A custom range can be at most ${MAX_RANGE_DAYS} days.`);
  return {
    preset: "custom",
    fromDay,
    toDay,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs + DAY_MS).toISOString(),
    label: fromDay === toDay ? formatDay(fromDay) : `${formatDay(fromDay)} – ${formatDay(toDay)}`,
  };
}

/** "18 Nov 2026" for a YYYY-MM-DD day. */
export function formatDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  return new Date(ms).toLocaleDateString("en-SG", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export type FunnelStage = {
  key: string;
  label: string;
  sessions: number;
  /** Step number in the cook form, for field stages. */
  step?: number;
  /** Not everyone sees this step (business UEN): no drop-off is worked out for it. */
  conditional?: boolean;
  /** The stage the drop-off is measured against (the previous stage everyone sees). */
  baseLabel?: string;
  baseSessions?: number;
  /** Sessions lost since the base stage, and that as a % of the base. null = not meaningful. */
  lost: number | null;
  dropPct: number | null;
  /** Share of the first stage (cook form opened) still here. */
  ofStartPct: number | null;
  note?: string;
};

const ev = (r: RegistrationReport, key: string) => r.events[key] ?? 0;

/**
 * The cook form funnel, in on-screen order: cook form opened → first field
 * → each field → Submit pressed → submitted. Drop-off is against the
 * previous stage that everyone sees, so the business UEN step (registered
 * businesses only) doesn't make the next step look like a gain.
 */
export function buildFunnel(r: RegistrationReport): FunnelStage[] {
  const reached = new Map(r.fields.map((f) => [f.field, f.sessions]));
  const raw: Omit<FunnelStage, "lost" | "dropPct" | "ofStartPct" | "baseLabel" | "baseSessions">[] = [
    { key: "cook_form_view", label: "Opened the cook form", sessions: ev(r, "cook_form_view") },
    { key: "form_start", label: "Started the form (any field)", sessions: ev(r, "form_start") },
    ...COOK_FORM_FIELDS.map((f, i) => ({
      key: `field:${f}`,
      label: FIELD_LABELS[f],
      step: i + 1,
      sessions: reached.get(f) ?? 0,
      conditional: CONDITIONAL_FIELDS.has(f),
    })),
    { key: "submit_attempt", label: "Pressed Submit", sessions: ev(r, "submit_attempt") },
    { key: "submit_success", label: "Application submitted", sessions: ev(r, "submit_success") },
  ];

  const first = raw[0].sessions;
  let base: { label: string; sessions: number } | null = null;
  return raw.map((s) => {
    const stage: FunnelStage = { ...s, lost: null, dropPct: null, ofStartPct: pct(s.sessions, first) };
    if (s.conditional) {
      stage.note = "Only asked of registered businesses (not Home Cook), so fewer sessions reach it by design.";
      if (base) {
        stage.baseLabel = base.label;
        stage.baseSessions = base.sessions;
      }
      return stage;
    }
    if (base) {
      stage.baseLabel = base.label;
      stage.baseSessions = base.sessions;
      const lost = base.sessions - s.sessions;
      if (lost >= 0) {
        stage.lost = lost;
        stage.dropPct = pct(lost, base.sessions);
      } else {
        // More sessions here than at the step before (e.g. a field focused out
        // of order, or a tab reloaded mid-form): a drop-off would be negative.
        stage.note = "More sessions than the step before (fields can be filled out of order), so no drop-off is shown.";
      }
    }
    base = { label: s.label, sessions: s.sessions };
    return stage;
  });
}

// ---------------------------------------------------------------------------
// Headline rates
// ---------------------------------------------------------------------------

export type Rate = { value: number | null; n: number; base: number };

export function rates(r: RegistrationReport) {
  const visitors = ev(r, "cook_form_view");
  const started = r.started;
  const submitted = r.submitted;
  return {
    /** Submitted ÷ opened the cook form. */
    conversion: { value: pct(submitted, visitors), n: submitted, base: visitors } satisfies Rate,
    /** Submitted ÷ started the form. */
    completion: { value: pct(submitted, started), n: submitted, base: started } satisfies Rate,
    /** Started, not submitted, idle 30+ min ÷ started. */
    abandonment: { value: pct(r.abandoned, started), n: r.abandoned, base: started } satisfies Rate,
  };
}

/** The sign-in screen rows, in the order they happen. Counts only; the screen is shared with riders and returning partners. */
export function signinRows(r: RegistrationReport): { key: string; label: string; sessions: number; hint?: string }[] {
  return [
    { key: "signin_view", label: "Saw the sign-in screen", sessions: ev(r, "signin_view") },
    {
      key: "in_app_browser",
      label: "…inside an in-app browser",
      sessions: ev(r, "in_app_browser"),
      hint: "Facebook, Instagram, Messenger, TikTok, WeChat or LINE — Google refuses sign-in there.",
    },
    { key: "chose_sign_up", label: "Tapped “Sign up — I'm new”", sessions: ev(r, "chose_sign_up") },
    { key: "chose_sign_in", label: "Tapped “Sign in — I already have an account”", sessions: ev(r, "chose_sign_in") },
    { key: "signin_click", label: "Tapped the Google button", sessions: ev(r, "signin_click") },
    { key: "signin_error", label: "Had a sign-in error", sessions: ev(r, "signin_error") },
    {
      key: "existing_account",
      label: "Was an existing partner signing back in",
      sessions: ev(r, "existing_account"),
      hint: "Not a new sign-up.",
    },
    { key: "page_view", label: "Reached “Join as a partner”", sessions: ev(r, "page_view") },
    { key: "rider_form_view", label: "Chose “I'm a rider”", sessions: ev(r, "rider_form_view"), hint: "Not tracked further." },
  ];
}

/** Defensive parse of the RPC result: anything missing becomes 0 / empty, never a made-up value. */
export function normalizeReport(data: unknown): RegistrationReport | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const events: Record<string, number> = {};
  if (d.events && typeof d.events === "object") {
    for (const [k, v] of Object.entries(d.events as Record<string, unknown>)) events[k] = num(v);
  }
  return {
    from: String(d.from ?? ""),
    to: String(d.to ?? ""),
    generated_at: String(d.generated_at ?? ""),
    tracking_since: typeof d.tracking_since === "string" ? d.tracking_since : null,
    sessions: num(d.sessions),
    test_sessions_excluded: num(d.test_sessions_excluded),
    events,
    fields: arr<RegistrationReport["fields"][number]>(d.fields).map((f) => ({
      field: String(f.field ?? ""),
      step: f.step === null || f.step === undefined ? null : num(f.step),
      sessions: num(f.sessions),
    })),
    validation_errors: arr<RegistrationReport["validation_errors"][number]>(d.validation_errors).map((e) => ({
      field: String(e.field ?? ""),
      code: String(e.code ?? ""),
      sessions: num(e.sessions),
    })),
    signin_errors: arr<RegistrationReport["signin_errors"][number]>(d.signin_errors).map((e) => ({
      code: String(e.code ?? ""),
      sessions: num(e.sessions),
    })),
    abandon_last_field: arr<RegistrationReport["abandon_last_field"][number]>(d.abandon_last_field).map((e) => ({
      field: String(e.field ?? ""),
      sessions: num(e.sessions),
    })),
    started: num(d.started),
    submitted: num(d.submitted),
    abandoned: num(d.abandoned),
    in_progress: num(d.in_progress),
  };
}

/**
 * Validation errors grouped by field, in form order: sessions per field
 * (a session with two different errors on one field counts once per code, so
 * the per-code counts are shown, and the field total is the largest of them
 * — the least it can be, never an over-count).
 */
export function errorsByField(
  r: RegistrationReport
): { field: string; label: string; atLeast: number; codes: { code: string; label: string; sessions: number }[] }[] {
  const byField = new Map<string, { code: string; label: string; sessions: number }[]>();
  for (const e of r.validation_errors) {
    const list = byField.get(e.field) ?? [];
    list.push({ code: e.code, label: errorLabel(e.code), sessions: e.sessions });
    byField.set(e.field, list);
  }
  const order = (f: string) => {
    const i = (COOK_FORM_FIELDS as readonly string[]).indexOf(f);
    return i < 0 ? COOK_FORM_FIELDS.length : i;
  };
  return [...byField.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([field, codes]) => ({
      field,
      label: fieldLabel(field),
      atLeast: Math.max(...codes.map((c) => c.sessions)),
      codes: codes.sort((a, b) => b.sessions - a.sessions || a.code.localeCompare(b.code)),
    }));
}

/** resolveRange() for the current moment (for the page: reads the clock outside render code). */
export function resolveRangeNow(params: Parameters<typeof resolveRange>[0]): ResolvedRange {
  return resolveRange(params, Date.now());
}
