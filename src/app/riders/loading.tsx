import { PageSkeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Riders">
      <TableSkeleton columns={8} />
    </PageSkeleton>
  );
}
