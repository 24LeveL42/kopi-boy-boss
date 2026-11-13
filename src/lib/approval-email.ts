/**
 * The "you're approved" email for merchants (cook applications) and riders.
 *
 * Server-only: it reads RESEND_API_KEY / EMAIL_FROM / PARTNER_APP_URL from
 * process.env and is imported only by approvals.ts, which only the "use
 * server" actions file imports (approval-email.test.ts checks this). Never
 * give these variables a NEXT_PUBLIC_ prefix.
 *
 * sendApprovalEmail NEVER throws: approval has already been saved when it
 * runs, so every problem (missing env, network, Resend refusing, timeout)
 * comes back as an outcome for the admin notice and the logs.
 *
 * Plain fetch to the Resend HTTP API (no npm package). Pure module with no
 * runtime imports, so `node --test` can load it with a fake fetch.
 */

export type ApprovalKind = "merchant" | "rider";

export const SUPPORT_EMAIL = "kopiboysupport@gmail.com";
export const LEGAL_LINE = "Kopi Boy is a trading name of KOPIE BOY (UEN 53535194A), Singapore.";
export const DEFAULT_PARTNER_APP_URL = "https://kopi-boy-partner-cgpt-version.vercel.app";
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

export type EmailOutcome =
  | { status: "sent"; id: string | null }
  | { status: "skipped" | "failed"; reason: string };

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

export type EmailDeps = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: Log;
  timeoutMs?: number;
};

export const defaultEmailDeps = (): EmailDeps => ({ env: process.env, fetch: globalThis.fetch, log: console });

/** `${PARTNER_APP_URL}/welcome`; falls back to the default unless the value is an https URL. */
export function partnerWelcomeUrl(raw: string | undefined): string {
  const value = raw?.trim().replace(/\/+$/, "");
  const base = value && /^https:\/\/[^\s/]+/i.test(value) ? value : DEFAULT_PARTNER_APP_URL;
  return `${base}/welcome`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "a***@gmail.com": enough to tell addresses apart in logs without logging them. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

function firstName(fullName: string | null | undefined): string {
  const first = fullName?.trim().split(/\s+/)[0];
  return first || "there";
}

type Content = { subject: string; intro: string[]; bullets: string[]; signOff: string };

function content(kind: ApprovalKind, businessName: string | null | undefined): Content {
  if (kind === "merchant") {
    const business = businessName?.trim() || "your business";
    return {
      subject: `You're approved: welcome to Kopi Boy, ${business}!`,
      intro: [
        `Good news: ${business} has been approved as a Kopi Boy merchant.`,
        "You can now open the Partner app, sign in with the same Google account you applied with, and set up your kitchen and menu.",
        "A quick reminder of how it works:",
      ],
      bullets: [
        "0% commission on your orders.",
        "Your subscription is S$29.95/month, with no commission. We'll tell you your billing dates in writing before your first payment.",
        "If a rider delivers your order, you pay the rider the delivery fee you agree with them.",
      ],
      signOff: "See you on Kopi Boy!",
    };
  }
  return {
    subject: "You're approved: welcome to the Kopi Boy rider team!",
    intro: [
      "Good news: your Kopi Boy rider application has been approved.",
      "Open the Partner app and sign in with the same Google account you applied with to start taking deliveries.",
    ],
    bullets: ["The rider app is free to use.", "You're paid by the merchant for each delivery."],
    signOff: "Ride safe!",
  };
}

export function buildApprovalEmail(
  kind: ApprovalKind,
  { name, businessName, partnerUrl }: { name?: string | null; businessName?: string | null; partnerUrl: string }
): { subject: string; html: string; text: string } {
  const c = content(kind, businessName);
  const hello = `Hi ${firstName(name)},`;
  const button = "Open the Partner app";
  const footerAsk = `Questions? Just reply to this email, or write to ${SUPPORT_EMAIL}`;

  const text = [
    hello,
    "",
    ...c.intro.flatMap((p) => [p, ""]),
    ...c.bullets.map((b) => `  - ${b}`),
    "",
    `${button}: ${partnerUrl}`,
    "",
    c.signOff,
    "The Kopi Boy team",
    "",
    "--",
    footerAsk,
    LEGAL_LINE,
    "",
  ].join("\n");

  const p = (s: string) => `<p style="margin:0 0 16px">${escapeHtml(s)}</p>`;
  const href = escapeHtml(partnerUrl);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f3ee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ee">
<tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2933">
${p(hello)}
${c.intro.map(p).join("\n")}
<ul style="margin:0 0 20px;padding-left:20px">
${c.bullets.map((b) => `<li style="margin:0 0 6px">${escapeHtml(b)}</li>`).join("\n")}
</ul>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td style="border-radius:8px;background:#1f6f43">
<a href="${href}" style="display:inline-block;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">${button}</a>
</td></tr></table>
<p style="margin:0 0 4px">${escapeHtml(c.signOff)}</p>
<p style="margin:0 0 24px">The Kopi Boy team</p>
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #e6e2d8;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6b7280">
<p style="margin:0 0 6px">Questions? Just reply to this email, or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:#6b7280">${SUPPORT_EMAIL}</a></p>
<p style="margin:0">${escapeHtml(LEGAL_LINE)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject: c.subject, html, text };
}

export type ApprovalEmailInput = {
  kind: ApprovalKind;
  to: string | null | undefined;
  name?: string | null;
  businessName?: string | null;
  /** Same key for the same application, so Resend never delivers it twice. */
  idempotencyKey: string;
  /** Short label for logs, e.g. "cook app=<id>". */
  ref: string;
};

/** Sends the approval email once. Never throws; see the module comment. */
export async function sendApprovalEmail(input: ApprovalEmailInput, deps: EmailDeps = defaultEmailDeps()): Promise<EmailOutcome> {
  const { log } = deps;
  const skip = (reason: string): EmailOutcome => {
    log.warn(`[approval-email] skipped ${input.ref} reason=${reason}`);
    return { status: "skipped", reason };
  };
  const failed = (reason: string): EmailOutcome => {
    log.error(`[approval-email] failed ${input.ref} ${reason}`);
    return { status: "failed", reason };
  };

  try {
    const apiKey = deps.env.RESEND_API_KEY?.trim();
    const from = deps.env.EMAIL_FROM?.trim();
    if (!apiKey) return skip("email isn't set up (RESEND_API_KEY missing)");
    if (!from) return skip("email isn't set up (EMAIL_FROM missing)");
    const to = input.to?.trim();
    if (!to) return skip("no email address on file");

    const partnerUrl = partnerWelcomeUrl(deps.env.PARTNER_APP_URL);
    const { subject, html, text } = buildApprovalEmail(input.kind, { name: input.name, businessName: input.businessName, partnerUrl });

    let res: Response;
    try {
      res = await deps.fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({ from, to: [to], reply_to: SUPPORT_EMAIL, subject, html, text }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") return failed("Resend timed out");
      return failed("couldn't reach Resend");
    }

    let body: { id?: unknown; message?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }

    if (!res.ok) {
      const message = typeof body.message === "string" ? body.message.slice(0, 200) : `HTTP ${res.status}`;
      return failed(`Resend said (${res.status}): ${message}`);
    }

    const id = typeof body.id === "string" ? body.id : null;
    log.info(`[approval-email] sent ${input.ref} to=${maskEmail(to)} id=${id ?? "?"}`);
    return { status: "sent", id };
  } catch {
    return failed("unexpected error while sending");
  }
}
