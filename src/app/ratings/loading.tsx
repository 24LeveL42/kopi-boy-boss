import { CardListSkeleton, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Ratings">
      <CardListSkeleton rows={1} />
    </PageSkeleton>
  );
}
