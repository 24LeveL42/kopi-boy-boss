import Image from "next/image";

interface LogoProps {
  size?: number;
  showWordmark?: boolean;
  /** "admin" swaps in the KB ADMIN skin (mark + ADMIN label). */
  variant?: "default" | "admin";
  className?: string;
}

// Source crops (px) — preserve each asset's aspect ratio.
const ASSETS = {
  default: { src: "/brand/logo-icon.png", w: 427, h: 367 },
  admin: { src: "/brand/logo-admin.png", w: 252, h: 259 },
} as const;

/**
 * KB logomark — the real approved artwork (public/brand/, background removed).
 * Do not redraw this as SVG; if the asset changes, replace the PNG instead.
 * The admin variant is the KB_admin_skin artwork with the ADMIN label already
 * recoloured for the navy background.
 */
export function Logo({ size = 40, showWordmark = true, variant = "default", className = "" }: LogoProps) {
  const asset = ASSETS[variant];
  const height = size;
  const width = Math.round(size * (asset.w / asset.h));

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <Image
        src={asset.src}
        alt={variant === "admin" ? "Kopi Boy Admin" : "Kopi Boy"}
        width={width}
        height={height}
        style={{ height, width: "auto" }}
        priority
      />
      {showWordmark && (
        <span
          className="font-display font-semibold tracking-tight leading-none"
          style={{ fontSize: variant === "admin" ? size * 0.32 : size * 0.5 }}
        >
          <span style={{ color: "var(--kb-purple)" }}>KOPI</span>{" "}
          <span style={{ color: "var(--kb-green)" }}>BOY</span>
        </span>
      )}
    </div>
  );
}
