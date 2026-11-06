import { Bone, PageSkeleton } from "@/components/Skeleton";

/** Mirrors the rider edit page: one card with four region checkboxes and a save button. */
export default function Loading() {
  return (
    <PageSkeleton>
      <section className="space-y-4 rounded-2xl bg-white p-5">
        <Bone className="h-3.5 w-48" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Bone key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
        <Bone className="h-9 w-32 rounded-lg" />
      </section>
    </PageSkeleton>
  );
}
