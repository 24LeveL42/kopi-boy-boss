"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createAssistedShop, saveAssistedShop } from "@/lib/actions";
import { CUISINE_TYPES, DESCRIPTION_MAX, MERCHANT_CATEGORIES } from "@/lib/kitchen-admin";
import { ADDRESS_MAX, assistedPhotoPath, OWNER_NAME_MAX, UEN_LATER_NOTE, type AssistedShop } from "@/lib/assisted-onboarding";
import type { CuisineType, MerchantCategory } from "@/lib/types-kitchen";
import { KitchenPhotoField } from "./KitchenPhotoField";
import { Spinner } from "./Spinner";

/**
 * HQ creates or edits an assisted-onboarding draft. Saves through the
 * createAssistedShop / saveAssistedShop server actions (explicit columns,
 * stale-edit check); this component never touches the database itself,
 * except uploading a photo to kitchen-photos/assisted/<shopId>/.
 * No PayNow here: the owner adds it in the Partner app after claiming.
 * The UEN is optional for every category (docs/supabase-assisted-uen-later.sql):
 * if it's left empty the owner adds it in Kitchen Setup after claiming, and the
 * database won't let the shop go live without it. A typed UEN is still checked.
 * The photo can be added once the draft exists (the upload path needs its id).
 */
export function AssistedShopForm({ shop, readOnly = false }: { shop?: AssistedShop; readOnly?: boolean }) {
  const router = useRouter();
  const [businessName, setBusinessName] = useState(shop?.business_name ?? "");
  const [category, setCategory] = useState<MerchantCategory>(shop?.category ?? "hawker");
  const [cuisineType, setCuisineType] = useState<CuisineType>(shop?.cuisine_type ?? "chinese");
  const [isHalal, setIsHalal] = useState(shop?.is_halal === true);
  const [description, setDescription] = useState(shop?.description ?? "");
  const [heroImage, setHeroImage] = useState(shop?.hero_image ?? "");
  const [ownerName, setOwnerName] = useState(shop?.owner_name ?? "");
  const [ownerMobile, setOwnerMobile] = useState(shop?.owner_mobile ?? "");
  const [uen, setUen] = useState(shop?.business_uen ?? "");
  const [address, setAddress] = useState(shop?.business_address ?? "");
  const [postalCode, setPostalCode] = useState(shop?.postal_code ?? "");
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState(shop?.updated_at ?? "");

  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const disabled = saving || readOnly;

  function edited<T>(set: (v: T) => void) {
    return (v: T) => {
      setNotice(null);
      set(v);
    };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    setError(null);
    setNotice(null);
    const fields = {
      business_name: businessName,
      category,
      cuisine_type: cuisineType,
      is_halal: isHalal,
      description: description || null,
      hero_image: heroImage || null,
      owner_name: ownerName,
      owner_mobile: ownerMobile,
      business_uen: uen || null,
      business_address: address || null,
      postal_code: postalCode || null,
    };
    startSaving(async () => {
      try {
        if (!shop) {
          const result = await createAssistedShop(fields);
          if (result.ok) router.push(`/merchants/assisted/${result.id}`);
          else setError(result.message);
          return;
        }
        const result = await saveAssistedShop(shop.id, loadedUpdatedAt, fields);
        if (result.ok) {
          setLoadedUpdatedAt(result.updatedAt);
          setStale(false);
          setNotice("Saved. The change is recorded in the history below.");
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
  const input = "w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-70";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <fieldset className="space-y-4" disabled={disabled}>
        <legend className="mb-2 text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
          The shop
        </legend>
        <Field label="Business name">
          <input value={businessName} onChange={(e) => edited(setBusinessName)(e.target.value)} required maxLength={80} className={input} style={inputStyle} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category">
            <select value={category} onChange={(e) => edited(setCategory)(e.target.value as MerchantCategory)} className={input} style={inputStyle}>
              {MERCHANT_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cuisine">
            <select value={cuisineType} onChange={(e) => edited(setCuisineType)(e.target.value as CuisineType)} className={input} style={inputStyle}>
              {CUISINE_TYPES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--oc-text)" }}>
          <input type="checkbox" checked={isHalal} onChange={(e) => edited(setIsHalal)(e.target.checked)} />
          Halal
        </label>
        <Field label={`Description (optional, up to ${DESCRIPTION_MAX} characters)`}>
          <textarea value={description} onChange={(e) => edited(setDescription)(e.target.value)} rows={3} maxLength={DESCRIPTION_MAX} className={input} style={inputStyle} />
        </Field>
        {shop ? (
          !readOnly && (
            <KitchenPhotoField
              kitchenId={shop.id}
              label="Shop photo"
              value={heroImage}
              onChange={edited(setHeroImage)}
              disabled={disabled}
              uploadPath={(file, uuid) => assistedPhotoPath(shop.id, file, uuid)}
            />
          )
        ) : (
          <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
            You can add the shop photo and menu after you create the draft.
          </p>
        )}
        {readOnly && heroImage && (
          // eslint-disable-next-line @next/next/no-img-element -- user-uploaded Supabase Storage URL, not a static asset
          <img src={heroImage} alt="" className="size-24 rounded-lg border object-cover" style={{ borderColor: "var(--oc-line)" }} />
        )}
      </fieldset>

      <fieldset className="space-y-4" disabled={disabled}>
        <legend className="mb-2 text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
          The owner
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Owner name">
            <input value={ownerName} onChange={(e) => edited(setOwnerName)(e.target.value)} required maxLength={OWNER_NAME_MAX} className={input} style={inputStyle} />
          </Field>
          <Field label="Owner mobile (WhatsApp, Singapore)">
            <input
              value={ownerMobile}
              onChange={(e) => edited(setOwnerMobile)(e.target.value)}
              required
              inputMode="tel"
              placeholder="8123 4567"
              className={input}
              style={inputStyle}
            />
          </Field>
        </div>
        <div>
          <Field label={category === "home-cook" ? "Business UEN (not needed for a Home Cook)" : "Business UEN (optional)"}>
            <input value={uen} onChange={(e) => edited(setUen)(e.target.value)} maxLength={10} placeholder="53123456A" className={`${input} uppercase`} style={inputStyle} />
          </Field>
          {category !== "home-cook" && (
            <p className="mt-1 text-xs" style={{ color: "var(--oc-text-soft)" }}>
              {UEN_LATER_NOTE}
            </p>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-[3fr_1fr]">
          <Field label="Pickup address (needed before you send the link)">
            <input value={address} onChange={(e) => edited(setAddress)(e.target.value)} maxLength={ADDRESS_MAX} placeholder="Blk 123 Example Street #01-23" className={input} style={inputStyle} />
          </Field>
          <Field label="Postal code">
            <input value={postalCode} onChange={(e) => edited(setPostalCode)(e.target.value)} inputMode="numeric" maxLength={6} placeholder="310123" className={input} style={inputStyle} />
          </Field>
        </div>
        <p className="rounded-lg px-3 py-2 text-xs" style={{ background: "var(--oc-blue-bg)", color: "var(--oc-blue-fg)" }}>
          No PayNow here: the owner adds their own PayNow details in the Partner app after claiming, and the shop goes live
          when they save them.
        </p>
      </fieldset>

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

      {!readOnly && (
        <button
          type="submit"
          disabled={saving}
          aria-busy={saving}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--oc-accent)" }}
        >
          {saving && <Spinner className="size-3.5" />}
          {saving ? "Saving…" : shop ? "Save draft" : "Create draft"}
        </button>
      )}
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
