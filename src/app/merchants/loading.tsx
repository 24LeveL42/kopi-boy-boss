import { PageSkeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Merchants and addresses">
      <TableSkeleton columns={8} />
    </PageSkeleton>
  );
}
