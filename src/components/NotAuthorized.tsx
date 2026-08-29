import { Logo } from "./Logo";
import { SignOutButton } from "./SignOutButton";

export function NotAuthorized() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center px-6 text-center" style={{ background: "var(--kb-navy)" }}>
      <Logo size={48} />
      <h1 className="mt-6 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
        Not authorized
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--kb-on-navy-soft)" }}>
        This account doesn&apos;t have HQ admin access. If you believe this is a
        mistake, contact the Kopi Boy team.
      </p>
      <div className="mt-6 w-full max-w-[200px]">
        <SignOutButton />
      </div>
    </div>
  );
}
