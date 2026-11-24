import { PageSkeleton, TableSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Assisted onboarding">
      <TableSkeleton columns={5} />
    </PageSkeleton>
  );
}
