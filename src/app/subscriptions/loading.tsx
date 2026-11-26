import { PageSkeleton, CardListSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Billing (off)">
      <CardListSkeleton rows={1} />
    </PageSkeleton>
  );
}
