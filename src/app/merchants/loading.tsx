import { CardListSkeleton, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton>
      <CardListSkeleton rows={4} actions={3} />
    </PageSkeleton>
  );
}
