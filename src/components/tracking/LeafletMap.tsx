"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { SINGAPORE_CENTER } from "@/lib/rider-tracking";

export type MapMarker = {
  id: string;
  position: [number, number];
  kind: "rider" | "pickup" | "dropoff" | "point";
  /** Fill colour for rider/point dots. */
  color?: string;
  label: string;
  selected?: boolean;
};

const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Lettered pin for pickup (P) and drop-off (D); drawn with CSS so there are no image assets to serve. */
function pinIcon(L: typeof Leaflet, letter: string, background: string) {
  return L.divIcon({
    className: "",
    html: `<span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9999px;background:${background};color:white;font:600 12px/1 Inter,system-ui,sans-serif;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.35)">${letter}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

/**
 * OpenStreetMap via Leaflet (loaded in the browser only). Redraws markers and
 * the optional route line whenever they change, but only moves the view when
 * `viewKey` changes, so live updates don't yank the map away from the admin.
 */
export function LeafletMap({
  markers,
  route,
  viewKey,
  viewPoints,
  onMarkerClick,
  className = "",
}: {
  markers: MapMarker[];
  route?: [number, number][];
  viewKey: string;
  /** Points to fit when `viewKey` changes; none = all of Singapore. */
  viewPoints: [number, number][];
  onMarkerClick?: (id: string) => void;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const leaflet = useRef<{ L: typeof Leaflet; map: Leaflet.Map; layer: Leaflet.LayerGroup } | null>(null);
  const clickRef = useRef(onMarkerClick);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    clickRef.current = onMarkerClick;
  }, [onMarkerClick]);

  useEffect(() => {
    let disposed = false;
    let map: Leaflet.Map | undefined;
    void import("leaflet").then((mod) => {
      const L = (mod.default ?? mod) as typeof Leaflet;
      if (disposed || !container.current) return;
      map = L.map(container.current, { center: SINGAPORE_CENTER, zoom: 11, zoomControl: true });
      L.tileLayer(OSM_TILES, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      leaflet.current = { L, map, layer: L.layerGroup().addTo(map) };
      setReady(true);
    });
    return () => {
      disposed = true;
      map?.remove();
      leaflet.current = null;
    };
  }, []);

  useEffect(() => {
    const ctx = leaflet.current;
    if (!ready || !ctx) return;
    const { L, layer } = ctx;
    layer.clearLayers();
    if (route && route.length > 1) {
      L.polyline(route, { color: "#5B3FD0", weight: 4, opacity: 0.85 }).addTo(layer);
    }
    for (const m of markers) {
      let mk: Leaflet.Layer;
      if (m.kind === "pickup") mk = L.marker(m.position, { icon: pinIcon(L, "P", "#137A47"), zIndexOffset: 500 });
      else if (m.kind === "dropoff") mk = L.marker(m.position, { icon: pinIcon(L, "D", "#B42318"), zIndexOffset: 500 });
      else
        mk = L.circleMarker(m.position, {
          radius: m.kind === "point" ? 6 : m.selected ? 11 : 8,
          color: "white",
          weight: m.selected ? 3 : 2,
          fillColor: m.color ?? "#5B3FD0",
          fillOpacity: 1,
        });
      mk.bindTooltip(m.label);
      if (m.kind === "rider") mk.on("click", () => clickRef.current?.(m.id));
      mk.addTo(layer);
    }
  }, [ready, markers, route]);

  // Only re-frame when the subject changes (e.g. a different rider is picked).
  const pointsKey = viewPoints.length;
  const pointsRef = useRef(viewPoints);
  useEffect(() => {
    pointsRef.current = viewPoints;
  }, [viewPoints]);
  useEffect(() => {
    const ctx = leaflet.current;
    if (!ready || !ctx) return;
    const pts = pointsRef.current;
    if (pts.length === 0) ctx.map.setView(SINGAPORE_CENTER, 11);
    else if (pts.length === 1) ctx.map.setView(pts[0], 15);
    else ctx.map.fitBounds(ctx.L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
  }, [ready, viewKey, pointsKey]);

  return <div ref={container} className={`isolate z-0 ${className}`} role="region" aria-label="Map" />;
}
