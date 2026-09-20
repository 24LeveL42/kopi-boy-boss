import Link from "next/link";
import { Logo } from "./Logo";

export function TopBar() {
  return (
    <div className="flex items-center">
      <Link href="/" aria-label="Go to Command Centre">
        <Logo variant="admin" size={64} />
      </Link>
    </div>
  );
}
