import { CardListSkeleton, PageSkeleton } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton title="Manage Partners">
      {["Cooks", "Riders", "Pickers"].map((heading, i) => (
        <section key={heading} className={i > 0 ? "mt-6" : undefined}>
          <h2 className="font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
            {heading}
          </h2>
          <div className="mt-3">
            <CardListSkeleton rows={2} actions={2} />
          </div>
        </section>
      ))}
    </PageSkeleton>
  );
}
