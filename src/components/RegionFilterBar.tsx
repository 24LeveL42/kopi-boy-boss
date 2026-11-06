import Link from "next/link";
import { REGION_CODES, REGION_COLOURS, REGION_LABEL, type RegionCounts, type RegionFilter } from "@/lib/regions";

/** /merchants?region=…, keeping the search text. */
export function merchantsHref(region: RegionFilter, q?: string) {
  const params = new URLSearchParams();
  if (region !== "all") params.set("region", region);
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/merchants?${qs}` : "/merchants";
}

/** All / North / South / East / West, each with its count, plus how many have no region. */
export function RegionFilterBar({ active, counts, q }: { active: RegionFilter; counts: RegionCounts; q?: string }) {
  const options: { id: RegionFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all },
    ...REGION_CODES.map((code) => ({ id: code, label: REGION_LABEL[code], count: counts[code] })),
  ];
  return (
    <nav aria-label="Filter by region" className="mb-4 flex flex-wrap items-center gap-2">
      {options.map((o) => {
        const on = o.id === active;
        return (
          <Link
            key={o.id}
            href={merchantsHref(o.id, q)}
            aria-current={on ? "page" : undefined}
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium"
            style={
              on
                ? { background: "var(--oc-accent)", borderColor: "var(--oc-accent)", color: "white" }
                : { background: "var(--oc-card)", borderColor: "var(--oc-line)", color: "var(--oc-text)" }
            }
          >
            {o.id !== "all" && (
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: REGION_COLOURS[o.id].text }} />
            )}
            {o.label}
            <span className="tabular-nums opacity-75">{o.count}</span>
          </Link>
        );
      })}
      <span className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
        No region: <span className="tabular-nums">{counts.none}</span>
      </span>
    </nav>
  );
}
