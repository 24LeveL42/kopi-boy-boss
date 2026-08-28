import { Logo } from "./Logo";

export function TopBar({ badge = "HQ Admin" }: { badge?: string }) {
  return (
    <div className="flex items-center justify-between">
      <Logo size={32} />
      <span
        className="rounded-full px-3 py-1 text-xs font-semibold"
        style={{ background: "var(--kb-navy)", color: "var(--kb-on-navy-soft)", border: "1px solid var(--kb-navy-line)" }}
      >
        {badge}
      </span>
    </div>
  );
}
