"use client";

import { useState, useTransition } from "react";
import { setRiderRegions } from "@/lib/actions";
import {
  PICK_A_REGION_MESSAGE,
  REGION_CODES,
  REGION_COLOURS,
  REGION_LABEL,
  normalizeRegions,
  type RegionCode,
} from "@/lib/regions";
import { Spinner } from "./Spinner";

/** Four checkboxes (at least one) saved through setRiderRegions -> admin_set_rider_regions. */
export function RiderRegionsForm({ riderId, initial }: { riderId: string; initial: RegionCode[] }) {
  const [picked, setPicked] = useState<RegionCode[]>(initial);
  const [saved, setSaved] = useState<RegionCode[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const changed = picked.join() !== saved.join();

  function toggle(code: RegionCode, on: boolean) {
    setNotice(null);
    setError(null);
    setPicked((current) => normalizeRegions(on ? [...current, code] : current.filter((c) => c !== code)));
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (picked.length === 0) {
      setError(PICK_A_REGION_MESSAGE);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await setRiderRegions(riderId, picked);
        if (result.ok) {
          setSaved(result.regions);
          setPicked(result.regions);
          setNotice(`Saved: ${result.regions.map((r) => REGION_LABEL[r]).join(", ")}.`);
        } else {
          setError(result.message);
        }
      } catch {
        // Only assertAdmin() throws (signed out, or not an admin).
        setError("Not saved: your admin session couldn't be confirmed. Please sign in again and retry.");
      }
    });
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
          Regions this rider usually rides in <span style={{ color: "var(--oc-text-soft)" }}>(pick at least one)</span>
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {REGION_CODES.map((code) => {
            const on = picked.includes(code);
            return (
              <label
                key={code}
                className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium"
                style={{
                  borderColor: on ? REGION_COLOURS[code].text : "var(--oc-line)",
                  background: on ? REGION_COLOURS[code].background : "var(--oc-card)",
                  color: on ? REGION_COLOURS[code].text : "var(--oc-text)",
                }}
              >
                <input
                  type="checkbox"
                  name="region"
                  value={code}
                  checked={on}
                  disabled={pending}
                  onChange={(e) => toggle(code, e.target.checked)}
                  className="size-4"
                  style={{ accentColor: REGION_COLOURS[code].text }}
                />
                {REGION_LABEL[code]}
              </label>
            );
          })}
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-green-bg)", color: "var(--oc-green-fg)" }}>
          {notice}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || !changed}
        aria-busy={pending}
        className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        style={{ background: "var(--oc-accent)" }}
      >
        {pending && <Spinner className="size-3.5" />}
        {pending ? "Saving…" : "Save regions"}
      </button>
    </form>
  );
}
