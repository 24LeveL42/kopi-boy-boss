import { Bone, PageSkeleton } from "@/components/Skeleton";

/** Mirrors the complaints list: Active/Resolved tabs, then one card per customer. */
export default function Loading() {
  return (
    <PageSkeleton title="Complaints">
      <div className="mb-4 flex gap-2">
        <Bone onNavy className="h-8 w-24 rounded-full" />
        <Bone onNavy className="h-8 w-28 rounded-full" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 2 }, (_, i) => (
          <section key={i} className="rounded-2xl bg-white p-4 shadow-lg">
            <Bone className="h-3.5 w-48" />
            <div className="mt-4 space-y-4">
              {Array.from({ length: 2 }, (_, j) => (
                <div key={j} className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Bone className="h-3.5 w-2/5" />
                    <Bone className="h-3 w-4/5" />
                  </div>
                  <Bone className="h-6 w-20 rounded-full" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </PageSkeleton>
  );
}
