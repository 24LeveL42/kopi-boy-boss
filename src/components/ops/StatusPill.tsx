import type { Tone } from "@/lib/ops";

/**
 * Coloured status pill: green delivered/active, amber waiting, red
 * cancelled/problem, blue to check, purple in progress, grey neutral.
 */
export function StatusPill({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ background: `var(--oc-${tone}-bg)`, color: `var(--oc-${tone}-fg)` }}
    >
      {children}
    </span>
  );
}

/** Active / Blocked from profiles.is_active, shared by every people table. */
export function ActivePill({ active }: { active: boolean }) {
  return <StatusPill tone={active ? "green" : "red"}>{active ? "Active" : "Blocked"}</StatusPill>;
}
