"use client";

import { useSyncExternalStore } from "react";
import { enableSound, getServerSoundState, getSoundState, setSoundMuted, subscribeSound } from "@/lib/alert-sound";

/**
 * Sidebar control for the new-application chime. Browsers block sound until
 * a click, so it starts as "Enable sound"; after that it's a mute toggle whose
 * choice is remembered in this browser when storage allows.
 */
export function AlertSoundControl() {
  const { enabled, muted } = useSyncExternalStore(subscribeSound, getSoundState, getServerSoundState);

  const label = !enabled ? "Enable sound" : muted ? "Sound off · Unmute" : "Sound on · Mute";
  const onClick = () => {
    if (!enabled) enableSound();
    else setSoundMuted(!muted);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={enabled ? !muted : undefined}
      title="Chime for new merchant and rider applications"
      className="mb-2 w-full rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-[var(--oc-ink-raised)]"
      style={{ color: "var(--oc-on-ink-soft)" }}
    >
      {enabled && !muted ? "🔔 " : "🔕 "}
      {label}
    </button>
  );
}
