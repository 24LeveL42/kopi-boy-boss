import { PageSkeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Past orders">
      <TableSkeleton columns={7} />
    </PageSkeleton>
  );
}
