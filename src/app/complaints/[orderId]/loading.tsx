import { Bone, PageSkeleton } from "@/components/Skeleton";

/** Mirrors ComplaintThread: alternating chat bubbles above the reply box. */
export default function Loading() {
  return (
    <PageSkeleton>
      <div className="mb-3 flex items-center justify-between">
        <Bone onNavy className="h-4 w-36" />
        <Bone onNavy className="h-7 w-32 rounded-full" />
      </div>
      <div className="rounded-2xl bg-white shadow-lg">
        <div className="min-h-48 space-y-4 p-4">
          {["items-start", "items-end", "items-start"].map((align, i) => (
            <div key={i} className={`flex flex-col gap-1 ${align}`}>
              <Bone className="h-2.5 w-28" />
              <Bone className={`h-10 rounded-2xl ${i === 1 ? "w-1/2" : "w-2/3"}`} />
            </div>
          ))}
        </div>
        <div className="flex gap-2 border-t p-3" style={{ borderColor: "var(--kb-cream)" }}>
          <Bone className="h-14 flex-1 rounded-xl" />
          <Bone className="h-9 w-16 self-end rounded-full" />
        </div>
      </div>
    </PageSkeleton>
  );
}
