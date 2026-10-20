import { PageSkeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Refunds and disputes">
      <TableSkeleton rows={1} columns={7} />
    </PageSkeleton>
  );
}
