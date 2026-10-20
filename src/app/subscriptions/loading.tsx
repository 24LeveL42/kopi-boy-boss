import { PageSkeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Subscriptions">
      <TableSkeleton rows={1} columns={5} />
    </PageSkeleton>
  );
}
