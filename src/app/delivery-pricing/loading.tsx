import { CardListSkeleton, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Delivery Pricing">
      <CardListSkeleton rows={1} />
    </PageSkeleton>
  );
}
