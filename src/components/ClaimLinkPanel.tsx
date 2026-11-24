"use client";

import { useState, useTransition } from "react";
import { issueAssistedClaimLink, markAssistedClaimLinkSent, revokeAssistedClaimLink } from "@/lib/actions";
import {
  CLAIM_LINK_HOURS,
  claimMessage,
  formatSgt,
  LINK_STATE_LABEL,
  REASON_MAX,
  whatsappUrl,
  type ClaimLink,
  type ClaimLinkState,
} from "@/lib/assisted-onboarding";
import { StatusPill } from "./ops/StatusPill";
import { Spinner } from "./Spinner";

const STATE_TONE: Record<ClaimLinkState, "green" | "grey" | "blue" | "red"> = {
  live: "green",
  expired: "grey",
  used: "blue",
  revoked: "red",
};

type Fresh = { tokenId: string; link: string; expiresAt: string };

const SESSION_ERROR = "Your admin session couldn't be confirmed. Please sign in again and retry.";

/**
 * HQ creates the one-time claim link and sends it on WhatsApp.
 *
 * The link (with its raw token) comes back from issueAssistedClaimLink once
 * and lives only in this component's state: it is never stored, logged or
 * shown again. Losing it means creating a new link, which revokes the old one.
 * "Send on WhatsApp" opens wa.me with the message filled in and records the
 * send in the audit. Every live link can be revoked, with a reason.
 */
export function ClaimLinkPanel({
  shopId,
  businessName,
  ownerName,
  ownerMobile,
  isDraft,
  missing,
  links,
  linksError,
}: {
  shopId: string;
  businessName: string;
  ownerName: string;
  ownerMobile: string;
  isDraft: boolean;
  /** What claimReadiness says is still missing; empty = ready. */
  missing: string[];
  links: ClaimLink[];
  linksError: string | null;
}) {
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [issuing, startIssuing] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const live = links.filter((l) => l.state === "live");
  // A fresh link that has since been revoked, replaced or used is no longer offered.
  // (Not yet in the list, e.g. the list didn't reload: still shown, it's the only copy.)
  const freshState = fresh ? links.find((l) => l.id === fresh.tokenId)?.state : undefined;
  const freshLink = fresh && (freshState === undefined || freshState === "live") ? fresh : null;
  const ready = isDraft && missing.length === 0 && !linksError;

  function issue() {
    setError(null);
    setConfirmReplace(false);
    startIssuing(async () => {
      try {
        const result = await issueAssistedClaimLink(shopId);
        if (result.ok) setFresh({ tokenId: result.tokenId, link: result.link, expiresAt: result.expiresAt });
        else setError(result.message);
      } catch {
        setError(`Couldn't create the link: ${SESSION_ERROR}`);
      }
    });
  }

  if (!isDraft) {
    return (
      <div className="space-y-4">
        <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
          This shop is no longer a draft, so no new links can be created.
        </p>
        <LinkList shopId={shopId} links={links} linksError={linksError} canRevoke={false} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
        The link works once and expires after {CLAIM_LINK_HOURS} hours. When the owner opens it, they check the shop, read
        the partner terms and privacy policy, and tap &ldquo;I acknowledge&rdquo; to claim it. Then they add their PayNow
        details and the shop goes live.
      </p>

      {missing.length > 0 && (
        <div className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-amber-bg)", color: "var(--oc-amber-fg)" }}>
          <p className="font-medium">Before you can send a link, add:</p>
          <ul className="mt-1 list-disc pl-5">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {freshLink ? (
        <FreshLink
          shopId={shopId}
          fresh={freshLink}
          businessName={businessName}
          ownerName={ownerName}
          ownerMobile={ownerMobile}
          onDone={() => setFresh(null)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {live.length > 0 && !confirmReplace ? (
            <button
              type="button"
              disabled={!ready || issuing}
              onClick={() => setConfirmReplace(true)}
              className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
              style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
            >
              Create a new link
            </button>
          ) : (
            <button
              type="button"
              disabled={!ready || issuing}
              aria-busy={issuing}
              onClick={issue}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--oc-accent)" }}
            >
              {issuing && <Spinner className="size-3.5" />}
              {issuing ? "Creating…" : live.length > 0 ? "Yes, replace the live link" : "Create claim link"}
            </button>
          )}
          {confirmReplace && (
            <>
              <span className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
                The live link will stop working.
              </span>
              <button
                type="button"
                disabled={issuing}
                onClick={() => setConfirmReplace(false)}
                className="text-sm underline disabled:opacity-50"
                style={{ color: "var(--oc-text-soft)" }}
              >
                Keep it
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          {error}
        </p>
      )}
      <LinkList shopId={shopId} links={links} linksError={linksError} canRevoke />
    </div>
  );
}

function FreshLink({
  shopId,
  fresh,
  businessName,
  ownerName,
  ownerMobile,
  onDone,
}: {
  shopId: string;
  fresh: Fresh;
  businessName: string;
  ownerName: string;
  ownerMobile: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);

  const message = claimMessage({ ownerName, businessName, link: fresh.link, expiresAt: fresh.expiresAt });
  let waHref: string | null = null;
  try {
    waHref = whatsappUrl(ownerMobile, message);
  } catch {
    waHref = null;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(fresh.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function recordSend() {
    setSendError(null);
    // The tap opens WhatsApp straight away (the link's own target); this only records it.
    markAssistedClaimLinkSent(shopId, fresh.tokenId)
      .then((r) => (r.ok ? setSentNote("WhatsApp opened. Check the message went through, then tap Done.") : setSendError(r.message)))
      .catch(() => setSendError(`Couldn't record the send: ${SESSION_ERROR}`));
  }

  return (
    <div className="space-y-3 rounded-lg border-2 p-4" style={{ borderColor: "var(--oc-accent)" }}>
      <p className="text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
        Claim link for {ownerName}: shown once
      </p>
      <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
        Boss can&apos;t show this link again. Send it now. If it gets lost, create a new link and the old one stops working.
        Expires {formatSgt(fresh.expiresAt)}.
      </p>
      <div className="flex gap-2">
        <input
          readOnly
          value={fresh.link}
          aria-label="Claim link"
          onFocus={(e) => e.target.select()}
          className="min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-xs"
          style={{ borderColor: "var(--oc-line)", background: "var(--oc-bg)", color: "var(--oc-text)" }}
        />
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {waHref ? (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            onClick={recordSend}
            className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium text-white"
            style={{ background: "#1FA855" }}
          >
            Send on WhatsApp to {ownerMobile.slice(0, 4)} {ownerMobile.slice(4)}
          </a>
        ) : (
          <p className="text-sm" style={{ color: "var(--oc-red-fg)" }}>
            The owner mobile isn&apos;t a valid Singapore number, so WhatsApp can&apos;t be opened. Fix it in the shop details.
          </p>
        )}
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          Done, hide the link
        </button>
      </div>
      {sentNote && (
        <p role="status" className="text-sm" style={{ color: "var(--oc-green-fg)" }}>
          {sentNote}
        </p>
      )}
      {sendError && (
        <p role="alert" className="text-sm" style={{ color: "var(--oc-red-fg)" }}>
          {sendError}
        </p>
      )}
    </div>
  );
}

function LinkList({
  shopId,
  links,
  linksError,
  canRevoke,
}: {
  shopId: string;
  links: ClaimLink[];
  linksError: string | null;
  canRevoke: boolean;
}) {
  if (linksError) {
    return (
      <p role="alert" className="text-sm" style={{ color: "var(--oc-red-fg)" }}>
        Couldn&apos;t load the claim links: {linksError}
      </p>
    );
  }
  if (links.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
        No links created yet.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border" style={{ borderColor: "var(--oc-line)" }}>
      {links.map((l) => (
        <LinkRow key={l.id} shopId={shopId} link={l} canRevoke={canRevoke && l.state === "live"} />
      ))}
    </ul>
  );
}

function LinkRow({ shopId, link, canRevoke }: { shopId: string; link: ClaimLink; canRevoke: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function revoke(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      try {
        const r = await revokeAssistedClaimLink(shopId, link.id, reason);
        if (r.ok) setOpen(false);
        else setError(r.message);
      } catch {
        setError(`Not revoked: ${SESSION_ERROR}`);
      }
    });
  }

  const detail = [
    `Created ${formatSgt(link.created_at)}`,
    link.sent_at ? `sent ${formatSgt(link.sent_at)}` : "not sent",
    link.used_at
      ? `claimed ${formatSgt(link.used_at)}`
      : link.revoked_at
        ? `revoked ${formatSgt(link.revoked_at)}${link.revoke_reason ? ` (${link.revoke_reason})` : ""}`
        : `expires ${formatSgt(link.expires_at)}`,
  ].join(" · ");

  return (
    <li className="p-3 text-sm" style={{ borderColor: "var(--oc-line)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={STATE_TONE[link.state] ?? "grey"}>{LINK_STATE_LABEL[link.state] ?? link.state}</StatusPill>
        <span className="flex-1 text-xs" style={{ color: "var(--oc-text-soft)" }}>
          {detail}
        </span>
        {canRevoke && !open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
          >
            Revoke
          </button>
        )}
      </div>
      {open && (
        <form onSubmit={revoke} className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            maxLength={REASON_MAX}
            placeholder="Reason, e.g. sent to the wrong number"
            aria-label="Reason for revoking"
            disabled={pending}
            className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--oc-line)", background: "var(--oc-card)", color: "var(--oc-text)" }}
          />
          <button
            type="submit"
            disabled={pending || !reason.trim()}
            aria-busy={pending}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "var(--oc-red-fg)" }}
          >
            {pending && <Spinner className="size-3.5" />}
            Revoke link
          </button>
          <button type="button" disabled={pending} onClick={() => setOpen(false)} className="text-sm underline" style={{ color: "var(--oc-text-soft)" }}>
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-1 text-sm" style={{ color: "var(--oc-red-fg)" }}>
          {error}
        </p>
      )}
    </li>
  );
}
