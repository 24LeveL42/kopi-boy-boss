"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  COMPLAINT_BODY_MAX_LENGTH,
  COMPLAINT_PHOTO_BUCKET,
  COMPLAINT_PHOTO_URL_TTL_SECONDS,
  COMPLAINT_THREAD_FETCH_LIMIT,
  formatSgTime,
  mergeMessages,
  normalizeReply,
  type ComplaintMessageRow,
} from "@/lib/complaints";

type ThreadStatus = "loading" | "ready" | "error";

/**
 * HQ's side of one order's complaint thread. Same Realtime pattern as the
 * Customer app's SupportChat and the rider chat: subscribe first, fetch on
 * SUBSCRIBED, de-dupe by id, fetch-only fallback on CHANNEL_ERROR/TIMED_OUT,
 * and a sent reply reaches this screen (and the customer's) via the Realtime
 * echo rather than an optimistic insert.
 *
 * Messages from anyone other than the order's customer are HQ's (any admin),
 * shown on the right. Evidence photos are keys in the private
 * complaint-photos bucket, rendered through short-lived signed URLs.
 */
export function ComplaintThread({
  orderId,
  customerId,
  customerName,
  currentUserId,
}: {
  orderId: string;
  customerId: string;
  customerName: string;
  currentUserId: string;
}) {
  const [status, setStatus] = useState<ThreadStatus>("loading");
  const [messages, setMessages] = useState<ComplaintMessageRow[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesRef = useRef<ComplaintMessageRow[]>([]);
  const requestedPathsRef = useRef<Set<string>>(new Set());
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const applyMessages = useCallback((update: (prev: ComplaintMessageRow[]) => ComplaintMessageRow[]) => {
    const next = update(messagesRef.current);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let disposed = false;

    async function load() {
      const { data, error } = await supabase
        .from("complaint_messages")
        .select("*")
        .eq("order_id", orderId)
        .order("created_at", { ascending: false })
        .limit(COMPLAINT_THREAD_FETCH_LIMIT);
      if (disposed) return;
      if (error) {
        setStatus("error");
        return;
      }
      applyMessages((prev) => mergeMessages(prev, (data ?? []) as ComplaintMessageRow[]));
      setStatus("ready");
    }

    let loadedWithoutRealtime = false;
    const channel = supabase
      .channel(`complaint_messages:${orderId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "complaint_messages", filter: `order_id=eq.${orderId}` },
        (payload) => {
          applyMessages((prev) => mergeMessages(prev, [payload.new as ComplaintMessageRow]));
        }
      )
      .subscribe((subscribeStatus) => {
        if (disposed) return;
        if (subscribeStatus === "SUBSCRIBED") {
          void load();
        } else if ((subscribeStatus === "CHANNEL_ERROR" || subscribeStatus === "TIMED_OUT") && !loadedWithoutRealtime) {
          loadedWithoutRealtime = true;
          void load();
        }
      });

    return () => {
      disposed = true;
      supabase.removeChannel(channel);
    };
  }, [orderId, applyMessages]);

  // Sign any photo keys we haven't signed yet, in one batch per change.
  useEffect(() => {
    const missing = messages
      .map((m) => m.photo_path)
      .filter((p): p is string => Boolean(p) && !requestedPathsRef.current.has(p!));
    if (missing.length === 0) return;
    for (const p of missing) requestedPathsRef.current.add(p);
    let cancelled = false;
    createClient()
      .storage.from(COMPLAINT_PHOTO_BUCKET)
      .createSignedUrls(missing, COMPLAINT_PHOTO_URL_TTL_SECONDS)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const signed: Record<string, string> = {};
        for (const item of data) if (item.path && item.signedUrl) signed[item.path] = item.signedUrl;
        setPhotoUrls((prev) => ({ ...prev, ...signed }));
      });
    return () => {
      cancelled = true;
    };
  }, [messages]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const body = normalizeReply(draft);
    if (body === null || sending) return;
    setSending(true);
    setSendError(null);
    const { error } = await createClient()
      .from("complaint_messages")
      .insert({ order_id: orderId, sender_id: currentUserId, body });
    setSending(false);
    if (error) {
      setSendError(`Reply couldn't be sent — ${error.message}`);
      return;
    }
    setDraft("");
  }

  const canSend = !sending && normalizeReply(draft) !== null;

  return (
    <div data-testid="complaint-thread" className="rounded-2xl bg-white shadow-lg" style={{ color: "var(--kb-ink)" }}>
      <div className="max-h-[60vh] min-h-48 space-y-3 overflow-y-auto p-4">
        {status === "loading" && (
          <p className="text-sm" style={{ color: "var(--kb-ink-soft)" }}>
            Loading conversation…
          </p>
        )}
        {status === "error" && (
          <p className="text-sm" style={{ color: "var(--kb-danger)" }}>
            Couldn&apos;t load this conversation.
          </p>
        )}
        {status === "ready" && messages.length === 0 && (
          <p className="text-sm" style={{ color: "var(--kb-ink-soft)" }}>
            No messages on this order yet. A reply here will open the thread for the customer.
          </p>
        )}
        {messages.map((m) => {
          const fromCustomer = m.sender_id === customerId;
          const url = m.photo_path ? photoUrls[m.photo_path] : undefined;
          const label = fromCustomer ? customerName : m.sender_id === currentUserId ? "You (HQ)" : "HQ";
          return (
            <div
              key={m.id}
              data-testid="complaint-message"
              data-from={fromCustomer ? "customer" : "hq"}
              className={`flex flex-col ${fromCustomer ? "items-start" : "items-end"}`}
            >
              <span className="mb-0.5 text-[11px] font-semibold" style={{ color: "var(--kb-ink-soft)" }}>
                {label} · {formatSgTime(m.created_at)}
              </span>
              <div
                className="max-w-[80%] overflow-hidden rounded-2xl text-sm break-words"
                style={
                  fromCustomer
                    ? { background: "var(--kb-cream)", color: "var(--kb-ink)" }
                    : { background: "var(--kb-green-deep)", color: "white" }
                }
              >
                {m.photo_path &&
                  (url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {/* Short-lived signed URL from a private bucket — next/image can't (and shouldn't) cache it. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="Photo attached by the customer" data-testid="complaint-photo" className="max-h-80 w-full object-contain" />
                    </a>
                  ) : (
                    <span className="block px-3 py-1.5 text-xs opacity-80">Loading photo…</span>
                  ))}
                {m.body && <p className="whitespace-pre-wrap px-3 py-1.5">{m.body}</p>}
              </div>
            </div>
          );
        })}
        <div ref={listEndRef} />
      </div>

      <form onSubmit={handleSend} className="flex items-end gap-2 border-t p-3" style={{ borderColor: "var(--kb-cream)" }}>
        <textarea
          value={draft}
          onChange={(e) => {
            setSendError(null);
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
          maxLength={COMPLAINT_BODY_MAX_LENGTH}
          placeholder={`Reply to ${customerName} as Kopi Boy Support…`}
          aria-label="Reply"
          className="min-w-0 flex-1 resize-y rounded-xl border px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--kb-cream)", color: "var(--kb-ink)" }}
        />
        <button
          type="submit"
          disabled={!canSend}
          className="shrink-0 rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: "var(--kb-green-deep)" }}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
      {sendError && (
        <p className="px-3 pb-3 text-xs" style={{ color: "var(--kb-danger)" }}>
          {sendError}
        </p>
      )}
    </div>
  );
}
