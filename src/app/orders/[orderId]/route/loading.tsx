import { Bone, PageSkeleton } from "@/components/Skeleton";

/** Mirrors the route replay: three time cards, then the map. */
export default function Loading() {
  return (
    <PageSkeleton>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="rounded-[14px] border bg-white px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
            <Bone className="h-2.5 w-20" />
            <Bone className="mt-2 h-4 w-36" />
          </div>
        ))}
      </div>
      <Bone className="h-[55vh] w-full rounded-[14px] lg:h-[520px]" />
    </PageSkeleton>
  );
}
