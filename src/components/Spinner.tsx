/** Small ring spinner that inherits the surrounding text colour. Decorative — pair it with a pending label. */
export function Spinner({ className = "size-3.5" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin ${className}`}
    />
  );
}
