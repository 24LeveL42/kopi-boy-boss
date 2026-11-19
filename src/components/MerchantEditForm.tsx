"use client";

import { useState, useTransition } from "react";
import { saveKitchenProfile } from "@/lib/actions";
import { CUISINE_TYPES, DESCRIPTION_MAX, MERCHANT_CATEGORIES, type KitchenProfile } from "@/lib/kitchen-admin";
import type { Kitchen } from "@/lib/types-kitchen";
import { KitchenPhotoField } from "./KitchenPhotoField";
import { Spinner } from "./Spinner";

/**
 * HQ edits a kitchen's public profile. Saves through the saveKitchenProfile
 * server action (UPDATE only, explicit columns, stale-edit check); this
 * component never touches the database itself, except uploading a photo
 * file to storage. No PayNow, opening hours or anything the database fills in.
 */
export function MerchantEditForm({ existingKitchen }: { existingKitchen: Kitchen }) {
  const kitchenId = existingKitchen.id;
  const [businessName, setBusinessName] = useState(existingKitchen.business_name ?? "");
  const [category, setCategory] = useState(existingKitchen.category);
  const [cuisineType, setCuisineType] = useState(existingKitchen.cuisine_type);
  const [isHalal, setIsHalal] = useState(existingKitchen.is_halal === true);
  const [description, setDescription] = useState(existingKitchen.description ?? "");
  const [heroImage, setHeroImage] = useState(existingKitchen.hero_image ?? "");
  const [isLive, setIsLive] = useState(existingKitchen.is_live === true);
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState(existingKitchen.updated_at);

  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Values the database rejects (an old category, say) would otherwise show as a blank select.
  const categoryKnown = MERCHANT_CATEGORIES.some((c) => c.id === category);
  const cuisineKnown = CUISINE_TYPES.some((c) => c.id === cuisineType);

  function edited<T>(set: (v: T) => void) {
    return (v: T) => {
      setNotice(null);
      set(v);
    };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    setNotice(null);
    if (!businessName.trim()) {
      setError("Business name is required.");
      return;
    }
    const profile: KitchenProfile = {
      business_name: businessName,
      category,
      cuisine_type: cuisineType,
      is_halal: isHalal,
      description: description || null,
      hero_image: heroImage || null,
      is_live: isLive,
    };
    startSaving(async () => {
      try {
        const result = await saveKitchenProfile(kitchenId, loadedUpdatedAt, profile);
        if (result.ok) {
          setLoadedUpdatedAt(result.updatedAt);
          setStale(false);
          setNotice("Saved. The change is recorded in the change history.");
        } else {
          setError(result.message);
          setStale(result.stale === true);
        }
      } catch {
        // Only assertAdmin() throws (signed out, or not an admin).
        setError("Not saved: your admin session couldn't be confirmed. Please sign in again and retry.");
      }
    });
  }

  const inputStyle = { borderColor: "var(--oc-line)", background: "var(--oc-card)", color: "var(--oc-text)" };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Business name">
        <input
          value={businessName}
          onChange={(e) => edited(setBusinessName)(e.target.value)}
          required
          maxLength={80}
          disabled={saving}
          className="w-full rounded-lg border px-3 py-2 text-sm"
          style={inputStyle}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category">
          <select
            value={category}
            onChange={(e) => edited(setCategory)(e.target.value as Kitchen["category"])}
            disabled={saving}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          >
            {!categoryKnown && <option value={category}>{category} (no longer offered, pick one)</option>}
            {MERCHANT_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cuisine">
          <select
            value={cuisineType}
            onChange={(e) => edited(setCuisineType)(e.target.value as Kitchen["cuisine_type"])}
            disabled={saving}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          >
            {!cuisineKnown && <option value={cuisineType}>{cuisineType} (pick one)</option>}
            {CUISINE_TYPES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm" style={{ color: "var(--oc-text)" }}>
        <input type="checkbox" checked={isHalal} disabled={saving} onChange={(e) => edited(setIsHalal)(e.target.checked)} />
        Halal
      </label>
      <Field label={`Description (optional, up to ${DESCRIPTION_MAX} characters)`}>
        <textarea
          value={description}
          onChange={(e) => edited(setDescription)(e.target.value)}
          rows={3}
          maxLength={DESCRIPTION_MAX}
          disabled={saving}
          className="w-full rounded-lg border px-3 py-2 text-sm"
          style={inputStyle}
        />
      </Field>
      <KitchenPhotoField
        kitchenId={kitchenId}
        label="Kitchen photo"
        value={heroImage}
        onChange={edited(setHeroImage)}
        disabled={saving}
      />
      <div>
        <label className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--oc-text)" }}>
          <input type="checkbox" checked={isLive} disabled={saving} onChange={(e) => edited(setIsLive)(e.target.checked)} />
          Live in the Customer app
        </label>
        <p className="mt-1 text-xs" style={{ color: "var(--oc-text-soft)" }}>
          To go live, the cook must have accepted the partner terms and saved a pickup address in the Partner app, and the
          menu needs at least one item that isn&apos;t hidden.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          <p>{error}</p>
          {stale && (
            <button type="button" onClick={() => window.location.reload()} className="mt-1 font-semibold underline">
              Reload the page
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-green-bg)", color: "var(--oc-green-fg)" }}>
          {notice}
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        aria-busy={saving}
        className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        style={{ background: "var(--oc-accent)" }}
      >
        {saving && <Spinner className="size-3.5" />}
        {saving ? "Saving…" : "Save kitchen details"}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
