import { CardListSkeleton, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Platform Settings">
      <CardListSkeleton rows={1} />
    </PageSkeleton>
  );
}
