import { readMuted, writeMuted } from "@/lib/application-alerts";

/**
 * The new-application chime: a short two-tone WebAudio sound (no audio file),
 * same tones as the Partner app's notification-sound.ts. Browsers only allow
 * audio after a click, so it stays silent until "Enable sound" is pressed in
 * the sidebar. The mute choice is kept in localStorage when that works.
 *
 * Module-level so it survives client-side navigation (the sidebar remounts on
 * every page). Read in React with useSyncExternalStore.
 */

export interface SoundState {
  /** Audio has been unlocked by a click in this tab. */
  enabled: boolean;
  muted: boolean;
}

const SERVER_STATE: SoundState = { enabled: false, muted: false };

let ctx: AudioContext | null = null;
let state: SoundState | null = null;
const listeners = new Set<() => void>();

const storage = () => (typeof window === "undefined" ? null : window.localStorage);

function current(): SoundState {
  state ??= { enabled: false, muted: readMuted(storage) };
  return state;
}

function set(next: Partial<SoundState>) {
  state = { ...current(), ...next };
  for (const l of listeners) l();
}

export function subscribeSound(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getSoundState = (): SoundState => current();
export const getServerSoundState = (): SoundState => SERVER_STATE;

/** Called from a click: unlocks audio, unmutes, and plays the chime once so you know it works. */
export function enableSound(): void {
  let resumed: Promise<void> | null = null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") resumed = ctx.resume();
  } catch {
    return; // no WebAudio here: sound just stays unavailable
  }
  writeMuted(storage, false);
  set({ enabled: true, muted: false });
  if (resumed) resumed.then(playChime, () => {});
  else playChime();
}

export function setSoundMuted(muted: boolean): void {
  writeMuted(storage, muted);
  set({ muted });
}

/** Plays the chime when sound is enabled and not muted; never throws. */
export function playChime(): void {
  try {
    const s = current();
    if (!ctx || !s.enabled || s.muted || ctx.state !== "running") return;
    const start = ctx.currentTime;
    for (const { freq, at } of [
      { freq: 880, at: 0 },
      { freq: 1175, at: 0.16 },
    ]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + at);
      gain.gain.exponentialRampToValueAtTime(0.25, start + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + at);
      osc.stop(start + at + 0.3);
    }
  } catch {
    // ignore: a missed chime must never break the page
  }
}
