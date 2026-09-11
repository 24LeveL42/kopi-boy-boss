import { TopBar } from "./TopBar";
import { SidebarNav } from "./SidebarNav";
import { createClient } from "@/lib/supabase/server";
import {
  approveCookApplication,
  rejectCookApplication,
  approveRiderApplication,
  rejectRiderApplication,
  approvePickerApplication,
  rejectPickerApplication,
} from "@/lib/actions";
import type { CookApplication, RiderApplication, PickerApplication } from "@/lib/types-auth";
import { METRICS } from "@/lib/demo-data";

export async function HqDashboard() {
  const supabase = await createClient();

  const [{ data: pendingCooks }, { data: pendingRiders }, { data: pendingPickers }] = await Promise.all([
    supabase
      .from("cook_applications")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .returns<CookApplication[]>(),
    supabase
      .from("rider_applications")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .returns<RiderApplication[]>(),
    supabase
      .from("picker_applications")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .returns<PickerApplication[]>(),
  ]);

  const cooks = pendingCooks ?? [];
  const riders = pendingRiders ?? [];
  const pickers = pendingPickers ?? [];
  const totalPending = cooks.length + riders.length + pickers.length;

  return (
    <div className="min-h-screen md:flex" style={{ background: "var(--kb-navy)" }}>
      <aside
        className="shrink-0 border-b p-4 md:w-56 md:border-b-0 md:border-r"
        style={{ borderColor: "var(--kb-navy-line)" }}
      >
        <TopBar />
        <SidebarNav />
      </aside>

      <main className="flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-xl font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Command Centre
        </h1>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {METRICS.map((m) => (
            <div key={m.label} className="rounded-2xl bg-white p-4 shadow-lg" style={{ color: "var(--kb-ink)" }}>
              <p className="text-xs" style={{ color: "var(--kb-ink-soft)" }}>{m.label}</p>
              <p className="mt-1 text-2xl font-bold">{m.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--kb-on-navy-soft)" }}>
          Metrics above are placeholders — real numbers land with Features #005-#010 (orders, subscriptions, complaints).
        </p>

        <h2 className="mt-6 font-display text-lg font-bold" style={{ color: "var(--kb-on-navy)" }}>
          Pending
