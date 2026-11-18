import { Bone, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Registration analytics">
      <div className="mb-5 rounded-[14px] border bg-white px-4 py-3" style={{ borderColor: "var(--oc-line)" }}>
        <Bone className="h-8 w-full sm:w-[28rem]" />
      </div>
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-2 rounded-[14px] border bg-white px-4 py-3.5" style={{ borderColor: "var(--oc-line)" }}>
            <Bone className="h-3 w-2/3" />
            <Bone className="h-6 w-1/4" />
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-[14px] border bg-white px-4 py-4" style={{ borderColor: "var(--oc-line)" }}>
        {Array.from({ length: 6 }, (_, i) => (
          <Bone key={i} className="h-3.5 w-full" />
        ))}
      </div>
    </PageSkeleton>
  );
}
