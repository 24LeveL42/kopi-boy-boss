import { CardListSkeleton, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Orders">
      <CardListSkeleton rows={6} actions={1} />
    </PageSkeleton>
  );
}
