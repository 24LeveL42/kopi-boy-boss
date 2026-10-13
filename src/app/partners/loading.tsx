import { Bone, CardListSkeleton, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Manage Partners">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Bone onNavy className="h-10 rounded-xl sm:w-48" />
        <Bone onNavy className="h-10 flex-1 rounded-xl" />
      </div>
      <div className="mt-6">
        <CardListSkeleton rows={3} actions={2} />
      </div>
    </PageSkeleton>
  );
}
