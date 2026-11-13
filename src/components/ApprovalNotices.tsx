"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { ActionButton, type ActionNotice } from "./ActionButton";

/*
 * After Approve, revalidatePath re-renders the list and the approved row (with
 * its button) disappears, so a notice under the button would vanish with it.
 * ApprovalNotices sits ABOVE the list and stays mounted even when the list
 * becomes empty, so "Approved. Email not sent: ..." stays visible until
 * dismissed.
 */

type Shown = ActionNotice & { key: number; who: string };

const NoticeContext = createContext<((notice: ActionNotice, who: string) => void) | null>(null);

export function ApprovalNotices({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState<Shown[]>([]);
  const push = useCallback((notice: ActionNotice, who: string) => {
    setShown((list) => [{ ...notice, who, key: Date.now() + Math.random() }, ...list].slice(0, 5));
  }, []);

  return (
    <NoticeContext.Provider value={push}>
      {shown.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2" aria-live="polite">
          {shown.map((n) => (
            <li
              key={n.key}
              className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs"
              style={
                n.tone === "warn"
                  ? { background: "#FFFBEB", borderColor: "#FCD34D", color: "#92400E" }
                  : { background: "#ECFDF5", borderColor: "#A7F3D0", color: "#065F46" }
              }
            >
              <span>
                <span className="font-semibold">{n.who}:</span> {n.notice}
              </span>
              <button
                type="button"
                onClick={() => setShown((list) => list.filter((x) => x.key !== n.key))}
                className="shrink-0 font-semibold"
                aria-label="Dismiss"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {children}
    </NoticeContext.Provider>
  );
}

/** The green Approve button; its result goes to the ApprovalNotices banner. */
export function ApproveButton({ action, who }: { action: () => Promise<void | ActionNotice>; who: string }) {
  const push = useContext(NoticeContext);
  return (
    <ActionButton
      action={action}
      label="Approve"
      pendingLabel="Approving…"
      background="var(--kb-green-deep)"
      onResult={push ? (notice) => push(notice, who) : undefined}
    />
  );
}
