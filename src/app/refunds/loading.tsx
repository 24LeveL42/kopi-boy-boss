import { CardListSkeleton, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Refunds">
      <CardListSkeleton rows={1} />
    </PageSkeleton>
  );
}
