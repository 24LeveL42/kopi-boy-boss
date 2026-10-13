import { Bone, PageSkeleton } from "@/components/Skeleton";

/** Mirrors the inbox: Open/Replied/Closed/All tabs, then one card per message. */
export default function Loading() {
  return (
    <PageSkeleton title="Messages">
      <div className="mb-4 flex gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Bone key={i} onNavy className="h-8 w-24 rounded-full" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <section key={i} className="rounded-2xl bg-white p-4 shadow-lg">
            <div className="flex items-center justify-between gap-3">
              <Bone className="h-3.5 w-40" />
              <Bone className="h-6 w-16 rounded-full" />
            </div>
            <Bone className="mt-3 h-12 w-full" />
            <Bone className="mt-3 h-14 w-full" />
          </section>
        ))}
      </div>
    </PageSkeleton>
  );
}
