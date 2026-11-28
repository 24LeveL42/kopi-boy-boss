"use client";

import { useState, useTransition } from "react";
import { issueAssistedSigninLink } from "@/lib/actions";
import { formatMobile, formatSgt, SIGNIN_LINK_HOURS, signinMessage, whatsappUrl } from "@/lib/assisted-onboarding";
import { Spinner } from "./Spinner";

type Fresh = { link: string; expiresAt: string };

const SESSION_ERROR = "Your admin session couldn't be confirmed. Please sign in again and retry.";

/**
 * HQ sends a locked-out owner a one-time link back into their EXISTING
 * account (docs/supabase-assisted-signin-link.sql). Only for a claimed shop.
 *
 * The link comes back from issueAssistedSigninLink once and lives only in
 * this component's state: it is never stored, logged or shown again.
 * Issuing another link stops the earlier unused one from working.
 */
export function SigninLinkPanel({
  shopId,
  businessName,
  ownerName,
  mobile,
  mobileSource,
}: {
  shopId: string;
  businessName: string;
  ownerName: string;
  /** The owner's number on file, or null when none is a valid Singapore mobile. */
  mobile: string | null;
  mobileSource: "profile" | "draft" | null;
}) {
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [issuing, startIssuing] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function issue() {
    setError(null);
    setCopied(false);
    startIssuing(async () => {
      try {
        const result = await issueAssistedSigninLink(shopId);
        if (result.ok) setFresh({ link: result.link, expiresAt: result.expiresAt });
        else setError(result.message);
      } catch {
        setError(`Couldn't create the sign-in link: ${SESSION_ERROR}`);
      }
    });
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  let waHref: string | null = null;
  if (fresh && mobile) {
    try {
      waHref = whatsappUrl(mobile, signinMessage({ ownerName, businessName, link: fresh.link, expiresAt: fresh.expiresAt }));
    } catch {
      waHref = null;
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
        For an owner who can&apos;t get back into the Partner app. The link signs them in to their existing account. It
        works once and expires after {SIGNIN_LINK_HOURS} hours. Creating a new link stops any earlier unused one from
        working. Send it only to the owner&apos;s own number.
      </p>

      {fresh ? (
        <div className="space-y-3 rounded-lg border-2 p-4" style={{ borderColor: "var(--oc-accent)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
            Sign-in link for {ownerName}: shown once
          </p>
          <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
            Boss can&apos;t show this link again. Anyone who has it can open this shop&apos;s account, so send it straight to
            the owner. Expires {formatSgt(fresh.expiresAt)}.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={fresh.link}
              aria-label="Sign-in link"
              onFocus={(e) => e.target.select()}
              className="min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-xs"
              style={{ borderColor: "var(--oc-line)", background: "var(--oc-bg)", color: "var(--oc-text)" }}
            />
            <button
              type="button"
              onClick={() => copy(fresh.link)}
              className="rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {waHref && mobile ? (
              <a
                href={waHref}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: "#1FA855" }}
              >
                Open WhatsApp to {formatMobile(mobile)}
              </a>
            ) : (
              <p className="text-sm" style={{ color: "var(--oc-red-fg)" }}>
                There&apos;s no valid Singapore mobile on file for this owner, so WhatsApp can&apos;t be opened.
              </p>
            )}
            <button
              type="button"
              onClick={() => setFresh(null)}
              className="rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
            >
              Done, hide the link
            </button>
          </div>
          {mobile && mobileSource && (
            <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
              Number from {mobileSource === "profile" ? "the owner's Partner profile" : "the shop draft (the owner's profile has no valid mobile)"}.
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={issuing}
          aria-busy={issuing}
          onClick={issue}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--oc-accent)" }}
        >
          {issuing && <Spinner className="size-3.5" />}
          {issuing ? "Creating…" : "Issue sign-in link"}
        </button>
      )}

      {error && (
        <p role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
