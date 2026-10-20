import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { NotAuthorized } from "@/components/NotAuthorized";
import { AdminShell } from "@/components/AdminShell";
import { Card, EmptyState, LoadError } from "@/components/ops/EmptyState";
import { RouteReplay } from "@/components/tracking/RouteReplay";
import { requireAdmin } from "@/lib/require-admin";
import { loadJobDetails, loadNames, loadRoutePoints } from "@/lib/ops-data";
import { currentDelivery, formatDuration, shortId, type DeliveryFacts } from "@/lib/ops";
import { formatSgTimeWithSeconds, orderRoute } from "@/lib/rider-tracking";

const soft = { color: "var(--oc-text-soft)" };

function Time({ label, at, note }: { label: string; at: string | null | undefined; note?: string }) {
  return (
    <div className="rounded-[14px] border px-4 py-3" style={{ borderColor: "var(--oc-line)", background: "var(--oc-card)" }}>
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={soft}>
        {label}
      </p>
      <p className="mt-1 text-sm font-medium tabular-nums">{at ? formatSgTimeWithSeconds(at) : "Not recorded"}</p>
      {note && (
        <p className="mt-0.5 text-xs" style={soft}>
          {note}
        </p>
      )}
    </div>
  );
}

export default async function RouteReplayPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const { supabase, user, profile } = await requireAdmin();
  if (!user) return <LoginForm />;
  if (!profile || profile.role !== "admin") return <NotAuthorized />;

  const title = `Route for order ${shortId(orderId)}`;
  const back = (
    <Link href="/orders/past" className="rounded-lg border px-3 py-1.5 text-xs font-medium" style={{ borderColor: "var(--oc-line)", background: "var(--oc-card)" }}>
      ← Past orders
    </Link>
  );

  const { data: deliveries, error } = await supabase
    .from("delivery_requests")
    .select("id, order_id, rider_id, status, created_at, accepted_at, completed_at")
    .eq("order_id", orderId)
    .returns<DeliveryFacts[]>();
  const delivery = currentDelivery(deliveries ?? []);

  if (error || !delivery) {
    return (
      <AdminShell title={title} actions={back}>
        {error && <LoadError what="the delivery" message={error.message} />}
        <Card>
          <EmptyState title="No route recorded">This order has no delivery request with a rider.</EmptyState>
        </Card>
      </AdminShell>
    );
  }

  const [{ job, error: jobError }, { points, error: pointsError }, names] = await Promise.all([
    loadJobDetails(supabase, delivery.id),
    loadRoutePoints(supabase, delivery.id),
    loadNames(supabase, [], delivery.rider_id ? [delivery.rider_id] : []),
  ]);
  const route = orderRoute(points);
  const rider = delivery.rider_id ? names.profile.get(delivery.rider_id)?.full_name || "Unknown rider" : "No rider";
  const first = route[0]?.recorded_at;
  const last = route[route.length - 1]?.recorded_at;

  return (
    <AdminShell
      title={title}
      subtitle={`${job?.merchant ?? "Unknown kitchen"} · ${rider}. The line joins the rider's saved positions in time order; P is the pickup, D the drop-off.`}
      actions={back}
    >
      {jobError && <LoadError what="pickup and drop-off" message={jobError} />}
      {pointsError && <LoadError what="route points" message={pointsError} />}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Time label="First point" at={first} note={route.length ? `${route.length} positions saved` : undefined} />
        <Time label="Picked up" at={job?.pickedUpAt} note="Rider tapped “I've collected the food”" />
        <Time
          label="Delivered"
          at={job?.completedAt ?? delivery.completed_at}
          note={first && last ? `Recorded for ${formatDuration(Date.parse(last) - Date.parse(first))}` : undefined}
        />
      </div>

      <RouteReplay points={route} pickup={job?.pickup ?? null} dropoff={job?.dropoff ?? null} merchant={job?.merchant ?? "kitchen"} />
    </AdminShell>
  );
}
