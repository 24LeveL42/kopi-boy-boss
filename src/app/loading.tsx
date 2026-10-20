import { Bone, PageSkeleton, TableSkeleton } from "@/components/Skeleton";

/** Overview while its counts, attention list and feed load. Mirrors components/ops/Overview. */
export default function Loading() {
  return (
    <PageSkeleton title="Overview">
      <div className="grid grid-cols-6 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-[14px] border bg-white px-4 py-4" style={{ borderColor: "var(--oc-line)" }}>
            <Bone className="h-3 w-24" />
            <Bone className="mt-3 h-8 w-12" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-3 gap-6">
        <div className="col-span-2">
          <TableSkeleton rows={5} columns={3} />
        </div>
        <TableSkeleton rows={5} columns={1} />
      </div>
    </PageSkeleton>
  );
}
