"use client";

import { useMemo, useState } from "react";
import { formatAccuracy, formatSgTimeWithSeconds, toLatLng, type RoutePoint } from "@/lib/rider-tracking";
import { LeafletMap, type MapMarker } from "./LeafletMap";

const soft = { color: "var(--oc-text-soft)" };

/**
 * The rider's recorded path for one delivery, with pickup (P) and drop-off (D)
 * pins. A slider steps a dot along the route so the admin can see where the
 * rider was at each saved time. `points` must already be in route order.
 */
export function RouteReplay({
  points,
  pickup,
  dropoff,
  merchant,
}: {
  points: RoutePoint[];
  pickup: [number, number] | null;
  dropoff: [number, number] | null;
  merchant: string;
}) {
  const path = useMemo(() => points.map((p) => toLatLng(p.lat, p.lng)!), [points]);
  const [step, setStep] = useState(path.length - 1);
  const current = points[step];

  const markers: MapMarker[] = [];
  if (pickup) markers.push({ id: "pickup", kind: "pickup", position: pickup, label: `Pickup · ${merchant}` });
  if (dropoff) markers.push({ id: "dropoff", kind: "dropoff", position: dropoff, label: "Drop-off · customer" });
  if (current) {
    markers.push({
      id: "position",
      kind: "point",
      position: path[step],
      color: "#5B3FD0",
      label: formatSgTimeWithSeconds(current.recorded_at),
    });
  }

  const viewPoints = useMemo(
    () => [...path, pickup, dropoff].filter((p): p is [number, number] => !!p),
    [path, pickup, dropoff]
  );

  return (
    <div>
      <div className="relative overflow-hidden rounded-[14px] border" style={{ borderColor: "var(--oc-line)" }}>
        <LeafletMap
          className="h-[55vh] w-full lg:h-[520px]"
          markers={markers}
          route={path}
          viewKey="route"
          viewPoints={viewPoints}
        />
        {path.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-[500] flex justify-center px-4">
            <p
              className="rounded-[14px] border px-4 py-2.5 text-sm font-medium shadow-sm"
              style={{ background: "var(--oc-card)", borderColor: "var(--oc-line)" }}
            >
              No route recorded
            </p>
          </div>
        )}
      </div>

      {current && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <label htmlFor="route-step" className="text-xs font-semibold" style={soft}>
            Position {step + 1} of {path.length}
          </label>
          <input
            id="route-step"
            type="range"
            min={0}
            max={path.length - 1}
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            className="flex-1 accent-[var(--oc-accent)]"
          />
          <span className="text-xs tabular-nums" style={soft}>
            {formatSgTimeWithSeconds(current.recorded_at)} · {formatAccuracy(current.accuracy_m)}
          </span>
        </div>
      )}
    </div>
  );
}
