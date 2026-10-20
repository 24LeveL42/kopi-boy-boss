import { PageSkeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Activity log">
      <TableSkeleton rows={1} columns={4} />
    </PageSkeleton>
  );
}
