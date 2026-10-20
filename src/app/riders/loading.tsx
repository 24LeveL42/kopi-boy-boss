import { PageSkeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Riders">
      <TableSkeleton columns={7} />
    </PageSkeleton>
  );
}
