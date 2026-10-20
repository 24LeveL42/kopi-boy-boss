"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { loadJobDetails, type JobDetails } from "@/lib/ops-data";
import { shortId } from "@/lib/ops";
import {
  DOT_COLOR,
  DOT_LABEL,
  HIDE_AFTER_MS,
  POLL_INTERVAL_MS,
  applyLocationChange,
  dotState,
  formatAccuracy,
  isShown,
  timeAgo,
  toLatLng,
  visibleRiders,
  type LiveLocation,
} from "@/lib/rider-tracking";
import { LeafletMap, type MapMarker } from "./LeafletMap";

export type RiderInfo = { name: string; phone: string | null };

const soft = { color: "var(--oc-text-soft)" };

function formatPoint(p: [number, number] | null) {
  return p ? `${p[0].toFixed(5)}, ${p[1].toFixed(5)}` : "Not recorded";
}

/** Second-by-second clock for "12 seconds ago" and the freshness colours. */
function useClock(serverNow: number) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Keeps rider_live_location current: Realtime changes are merged as they
 * arrive; while the channel isn't connected, the table is re-read every 15
 * seconds instead. Read-only.
 */
function useLiveLocations(initial: LiveLocation[]) {
  const [locations, setLocations] = useState(initial);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("ops:rider-live-location")
      .on("postgres_changes", { event: "*", schema: "public", table: "rider_live_location" }, (payload) => {
        const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as Partial<LiveLocation>;
        setLocations((cur) => applyLocationChange(cur, { eventType: payload.eventType, row }));
      })
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (connected) return;
    const supabase = createClient();
    const timer = setInterval(async () => {
      const { data, error } = await supabase
        .from("rider_live_location")
        .select("*")
        .gte("updated_at", new Date(Date.now() - HIDE_AFTER_MS).toISOString());
      if (!error && data) setLocations(data as LiveLocation[]);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connected]);

  return { locations, connected };
}

/** Pickup/drop-off for the selected rider's current job, re-read when the job changes. */
function useJob(deliveryRequestId: string | null) {
  const [state, setState] = useState<{ id: string | null; job: JobDetails | null; error: string | null }>({
    id: null,
    job: null,
    error: null,
  });
  useEffect(() => {
    if (!deliveryRequestId) return;
    let disposed = false;
    void loadJobDetails(createClient(), deliveryRequestId).then(({ job, error }) => {
      if (!disposed) setState({ id: deliveryRequestId, job, error });
    });
    return () => {
      disposed = true;
    };
  }, [deliveryRequestId]);
  const current = state.id === deliveryRequestId && deliveryRequestId !== null;
  return { job: current ? state.job : null, error: current ? state.error : null, loading: !!deliveryRequestId && !current };
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={soft}>
      {(["delivery", "idle", "stale"] as const).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: DOT_COLOR[s] }} aria-hidden />
          {DOT_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wide" style={soft}>
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export function RiderMap({
  initialLocations,
  riders,
  serverNow,
  initialRiderId,
}: {
  initialLocations: LiveLocation[];
  riders: Record<string, RiderInfo>;
  serverNow: number;
  initialRiderId?: string;
}) {
  const now = useClock(serverNow);
  const { locations, connected } = useLiveLocations(initialLocations);
  const [selectedId, setSelectedId] = useState<string | null>(initialRiderId ?? null);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    // Keep the URL shareable without re-running the server page.
    const url = new URL(window.location.href);
    url.searchParams.set("view", "map");
    if (id) url.searchParams.set("rider", id);
    else url.searchParams.delete("rider");
    window.history.replaceState(null, "", url);
  }, []);

  const visible = visibleRiders(locations, now);
  const selected = selectedId ? locations.find((l) => l.rider_id === selectedId) ?? null : null;
  const selectedShown = selected ? isShown(selected, now) && toLatLng(selected.lat, selected.lng) !== null : false;
  const { job, error: jobError, loading: jobLoading } = useJob(selectedShown ? selected!.delivery_request_id : null);
  const nameOf = (id: string) => riders[id]?.name || `Rider ${id.slice(0, 8)}`;

  const riderPos = selectedShown ? toLatLng(selected!.lat, selected!.lng) : null;
  const markers: MapMarker[] = visible.map((l) => {
    const state = dotState(l, now);
    return {
      id: l.rider_id,
      kind: "rider",
      position: toLatLng(l.lat, l.lng)!,
      color: DOT_COLOR[state],
      label: `${nameOf(l.rider_id)} · ${DOT_LABEL[state]}`,
      selected: l.rider_id === selectedId,
    };
  });
  if (job?.pickup) markers.push({ id: "pickup", kind: "pickup", position: job.pickup, label: `Pickup · ${job.merchant}` });
  if (job?.dropoff) markers.push({ id: "dropoff", kind: "dropoff", position: job.dropoff, label: "Drop-off · customer" });

  const viewPoints = useMemo(
    () => (riderPos ? [riderPos, job?.pickup, job?.dropoff].filter((p): p is [number, number] => !!p) : []),
    // Re-frame on rider change or when the job's points arrive, not on every GPS tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, selectedShown, job?.deliveryId]
  );

  const panel = selectedId ? (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold">{nameOf(selectedId)}</p>
          {riders[selectedId]?.phone && (
            <a href={`tel:${riders[selectedId].phone!.replace(/\s+/g, "")}`} className="text-xs hover:underline" style={soft}>
              📞 {riders[selectedId].phone}
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={() => select(null)}
          className="rounded-lg border px-2.5 py-1 text-xs font-medium"
          style={{ borderColor: "var(--oc-line)" }}
        >
          Close
        </button>
      </div>

      {!selected || !selectedShown ? (
        <p className="mt-4 text-sm" style={soft}>
          This rider isn&apos;t sharing their location right now
          {selected ? ` (last update ${timeAgo(selected.updated_at, now)}).` : "."}
        </p>
      ) : (
        <dl className="mt-3 divide-y" style={{ borderColor: "var(--oc-line)" }}>
          <Detail label="Status">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: DOT_COLOR[dotState(selected, now)] }} aria-hidden />
              {DOT_LABEL[dotState(selected, now)]}
            </span>
          </Detail>
          <Detail label="Current order">
            {!selected.delivery_request_id ? (
              <span style={soft}>No job</span>
            ) : jobLoading ? (
              <span style={soft}>Loading…</span>
            ) : job ? (
              <>
                <Link
                  href={`/orders?q=${job.orderId.slice(0, 8)}`}
                  className="font-medium underline"
                  style={{ color: "var(--oc-accent)" }}
                >
                  Order {shortId(job.orderId)}
                </Link>
                <span style={soft}> · {job.merchant}</span>
                {job.pickedUpAt && (
                  <span className="block text-xs" style={soft}>
                    Food collected {timeAgo(job.pickedUpAt, now)}
                  </span>
                )}
              </>
            ) : (
              <span style={soft}>{jobError ? `Couldn't load the job: ${jobError}` : "Job not found"}</span>
            )}
          </Detail>
          {job && (
            <>
              <Detail label="Pickup (P)">
                {job.pickupAddress && <span className="block">{job.pickupAddress}</span>}
                <span className="font-mono text-xs" style={soft}>
                  {formatPoint(job.pickup)}
                </span>
              </Detail>
              <Detail label="Drop-off (D)">
                <span className="font-mono text-xs" style={soft}>
                  {formatPoint(job.dropoff)}
                </span>
              </Detail>
            </>
          )}
          <Detail label="Last update">
            <span className="tabular-nums">{timeAgo(selected.updated_at, now)}</span>
          </Detail>
          <Detail label="GPS accuracy">{formatAccuracy(selected.accuracy_m)}</Detail>
        </dl>
      )}
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1">
        <div
          className="relative overflow-hidden rounded-[14px] border"
          style={{ borderColor: "var(--oc-line)", background: "var(--oc-card)" }}
        >
          <LeafletMap
            className="h-[60vh] w-full lg:h-[calc(100vh-220px)] lg:min-h-[480px]"
            markers={markers}
            viewKey={selectedId && selectedShown ? `rider:${selectedId}` : "all"}
            viewPoints={viewPoints}
            onMarkerClick={select}
          />
          {visible.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-[500] flex justify-center px-4">
              <p
                className="rounded-[14px] border px-4 py-2.5 text-sm font-medium shadow-sm"
                style={{ background: "var(--oc-card)", borderColor: "var(--oc-line)" }}
              >
                No riders are sharing location right now
              </p>
            </div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <Legend />
          <span className="text-xs" style={soft}>
            {connected ? "Live" : `Updating every ${POLL_INTERVAL_MS / 1000} seconds`} · riders silent for over 15 minutes are hidden
          </span>
        </div>
      </div>

      <aside className="lg:w-80 lg:shrink-0">
        {/* Phone: the selected rider slides up as a bottom sheet over the map. Desktop: side panel. */}
        {panel && (
          <div
            className="fixed inset-x-0 bottom-0 z-[1100] max-h-[65vh] overflow-y-auto rounded-t-2xl border-t p-4 shadow-2xl lg:static lg:z-auto lg:mb-4 lg:max-h-none lg:rounded-[14px] lg:border lg:shadow-none"
            style={{ background: "var(--oc-card)", borderColor: "var(--oc-line)" }}
            role="dialog"
            aria-label="Rider details"
          >
            {panel}
          </div>
        )}
        <section className="rounded-[14px] border" style={{ background: "var(--oc-card)", borderColor: "var(--oc-line)" }}>
          <h2 className="border-b px-4 py-3 text-sm font-semibold" style={{ borderColor: "var(--oc-line)" }}>
            Sharing location ({visible.length})
          </h2>
          {visible.length === 0 ? (
            <p className="px-4 py-6 text-sm" style={soft}>
              No riders are sharing location right now.
            </p>
          ) : (
            <ul>
              {visible.map((l) => {
                const state = dotState(l, now);
                return (
                  <li key={l.rider_id} className="border-b last:border-b-0" style={{ borderColor: "var(--oc-line)" }}>
                    <button
                      type="button"
                      onClick={() => select(l.rider_id)}
                      aria-pressed={l.rider_id === selectedId}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--oc-bg)]"
                      style={l.rider_id === selectedId ? { background: "var(--oc-accent-soft)" } : undefined}
                    >
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: DOT_COLOR[state] }} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{nameOf(l.rider_id)}</span>
                      <span className="shrink-0 text-xs tabular-nums" style={soft}>
                        {timeAgo(l.updated_at, now)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
