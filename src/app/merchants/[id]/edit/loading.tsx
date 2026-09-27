import { Bone, PageSkeleton } from "@/components/Skeleton";

/** Mirrors MerchantEditForm: kitchen details card, menu items card, save button. */
export default function Loading() {
  return (
    <PageSkeleton>
      <div className="space-y-5">
        <section className="space-y-4 rounded-2xl bg-white p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <Bone className="h-3 w-24" />
              <Bone className="h-10 w-full rounded-xl" />
            </div>
          ))}
        </section>
        <section className="space-y-3 rounded-2xl bg-white p-4">
          <Bone className="h-3.5 w-24" />
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex gap-2">
              <Bone className="h-10 flex-[2] rounded-xl" />
              <Bone className="h-10 flex-1 rounded-xl" />
              <Bone className="h-10 flex-[2] rounded-xl" />
            </div>
          ))}
        </section>
        <Bone onNavy className="h-12 w-full rounded-2xl" />
      </div>
    </PageSkeleton>
  );
}
