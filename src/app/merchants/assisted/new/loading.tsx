import { Bone, PageSkeleton } from "@/components/Skeleton";

/** Mirrors AssistedShopForm: the shop and owner fields, and the create button. */
export default function Loading() {
  return (
    <PageSkeleton title="New assisted shop">
      <section className="space-y-4 rounded-2xl bg-white p-4">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Bone className="h-3 w-24" />
            <Bone className="h-10 w-full rounded-xl" />
          </div>
        ))}
      </section>
    </PageSkeleton>
  );
}
