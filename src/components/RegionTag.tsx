import { NO_REGION_LABEL, REGION_COLOURS, REGION_LABEL, RIDER_NO_REGIONS_LABEL, type RegionCode } from "@/lib/regions";

/**
 * A region as a small tag: the word itself (never colour alone) in the same
 * colours as the Customer app. Screen readers hear "Region: East".
 */
export function RegionTag({ region }: { region: RegionCode }) {
  const { text, background } = REGION_COLOURS[region];
  return (
    <span
      data-region={region}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold leading-4"
      style={{ background, color: text }}
    >
      <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: text }} />
      <span className="sr-only">Region: </span>
      {REGION_LABEL[region]}
    </span>
  );
}

function Muted({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className="text-xs" style={{ color: "var(--oc-text-soft)" }} title={title}>
      {children}
    </span>
  );
}

/** A merchant's region, or "No region" (no postal code or an unmapped sector). */
export function MerchantRegion({ region }: { region: RegionCode | null }) {
  if (!region) return <Muted title="No postal code on file, or its sector isn't mapped to a region">{NO_REGION_LABEL}</Muted>;
  return <RegionTag region={region} />;
}

/** A rider's regions as tags, "Not set" when none, or a clear note when they couldn't be read. */
export function RiderRegions({ regions }: { regions: RegionCode[] | "error" }) {
  if (regions === "error") return <Muted title="The rider regions didn't load; see the notice above">Couldn&apos;t load</Muted>;
  if (regions.length === 0) return <Muted title="This rider hasn't chosen any regions yet">{RIDER_NO_REGIONS_LABEL}</Muted>;
  return (
    <span className="flex flex-wrap gap-1">
      {regions.map((r) => (
        <RegionTag key={r} region={r} />
      ))}
    </span>
  );
}
