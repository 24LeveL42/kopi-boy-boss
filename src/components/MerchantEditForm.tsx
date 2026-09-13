"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Kitchen, MenuItem, MerchantCategory, CuisineType } from "@/lib/types-kitchen";

const CATEGORIES: { id: MerchantCategory; label: string }[] = [
  { id: "home-cook", label: "Home Cook" },
  { id: "hawker", label: "Hawker" },
  { id: "bakery", label: "Bakery" },
  { id: "bulk-orders", label: "Bulk Orders" },
  { id: "drinks", label: "Desserts & Drinks" },
];

const CUISINES: { id: CuisineType; label: string }[] = [
  { id: "chinese", label: "Chinese" },
  { id: "halal", label: "Halal" },
  { id: "indian", label: "Indian" },
  { id: "western", label: "Western" },
];

interface DraftItem {
  key: string;
  name: string;
  price: string;
  photo_url: string;
}

function emptyItem(): DraftItem {
  return { key: crypto.randomUUID(), name: "", price: "", photo_url: "" };
}

export function MerchantEditForm({
  merchantId,
  merchantName,
  existingKitchen,
  existingItems,
}: {
  merchantId: string;
  merchantName: string;
  existingKitchen: Kitchen | null;
  existingItems: MenuItem[];
}) {
  const router = useRouter();
  const supabase = createClient();

  const [businessName, setBusinessName] = useState(existingKitchen?.business_name ?? merchantName);
  const [category, setCategory] = useState<MerchantCategory>(existingKitchen?.category ?? "home-cook");
  const [cuisineType, setCuisineType] = useState<CuisineType>(existingKitchen?.cuisine_type ?? "chinese");
  const [neighbourhood, setNeighbourhood] = useState(existingKitchen?.neighbourhood ?? "");
  const [description, setDescription] = useState(existingKitchen?.description ?? "");
  const [heroImage, setHeroImage] = useState(existingKitchen?.hero_image ?? "");
  const [isLive, setIsLive] = useState(existingKitchen?.is_live ?? true);
  const [items, setItems] = useState<DraftItem[]>(
    existingItems.length > 0
      ? existingItems.map((i) => ({ key: i.id, name: i.name, price: String(i.price), photo_url: i.photo_url ?? "" }))
      : [emptyItem()]
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateItem(key: string, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }
  function addItem() {
    setItems((prev) => [...prev, emptyItem()]);
  }
  function removeItem(key: string) {
    setItems((prev) => (prev.length > 1 ? prev.filter((it) => it.key !== key) : prev));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const validItems = items
      .map((it) => ({ ...it, name: it.name.trim(), price: parseFloat(it.price) }))
      .filter((it) => it.name.length > 0 && !Number.isNaN(it.price) && it.price > 0);

    if (!businessName.trim() || !neighbourhood.trim()) {
      setError("Business name and neighbourhood are required.");
      return;
    }

    setLoading(true);

    const { error: kitchenError } = await supabase.from("kitchens").upsert({
      id: merchantId,
      business_name: businessName.trim(),
      category,
      cuisine_type: cuisineType,
      neighbourhood: neighbourhood.trim(),
      description: description.trim() || null,
      hero_image: heroImage.trim() || null,
      is_live: isLive,
    });

    if (kitchenError) {
      setError(kitchenError.message);
      setLoading(false);
      return;
    }

    await supabase.from("menu_items").delete().eq("kitchen_id", merchantId);
    if (validItems.length > 0) {
      const { error: itemsError } = await supabase.from("menu_items").insert(
        validItems.map((it) => ({
          kitchen_id: merchantId,
          name: it.name,
          price: it.price,
          photo_url: it.photo_url.trim() || null,
        }))
      );
      if (itemsError) {
        setError(itemsError.message);
        setLoading(false);
        return;
      }
    }

    setLoading(false);
    router.push("/merchants");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mt-5 space-y-5">
      <section className="space-y-3 rounded-2xl bg-white p-4" style={{ color: "var(--kb-ink)" }}>
        <Field label="Business name">
          <input
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            required
            className="w-full rounded-xl border px-3 py-2.5 text-sm"
            style={{ borderColor: "#E5E7EB" }}
          />
        </Field>
        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as MerchantCategory)}
            className="w-full rounded-xl border px-3 py-2.5 text-sm"
            style={{ borderColor: "#E5E7EB" }}
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cuisine">
          <select
            value={cuisineType}
            onChange={(e) => setCuisineType(e.target.value as CuisineType)}
            className="w-full rounded-xl border px-3 py-2.5 text-sm"
            style={{ borderColor: "#E5E7EB" }}
          >
            {CUISINES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Neighbourhood">
          <input
            value={neighbourhood}
            onChange={(e) => setNeighbourhood(e.target.value)}
            required
            className="w-full rounded-xl border px-3 py-2.5 text-sm"
            style={{ borderColor: "#E5E7EB" }}
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-xl border px-3 py-2.5 text-sm"
            style={{ borderColor: "#E5E7EB" }}
          />
        </Field>
        <Field label="Kitchen photo URL (optional)">
          <input
            value={heroImage}
            onChange={(e) => setHeroImage(e.target.value)}
            placeholder="https://..."
            className="w-full rounded-xl border px-3 py-2.5 text-sm"
            style={{ borderColor: "#E5E7EB" }}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--kb-ink)" }}>
          <input type="checkbox" checked={isLive} onChange={(e) => setIsLive(e.target.checked)} />
          Live in Customer app
        </label>
      </section>

      <section className="space-y-3 rounded-2xl bg-white p-4" style={{ color: "var(--kb-ink)" }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Menu items</h2>
          <button type="button" onClick={addItem} className="text-sm font-semibold" style={{ color: "var(--kb-purple)" }}>
            + Add item
          </button>
        </div>
        {items.map((it, i) => (
          <div key={it.key} className="flex items-end gap-2 border-b pb-3 last:border-0" style={{ borderColor: "#E5E7EB" }}>
            <Field label={`Item ${i + 1} name`} className="flex-[2]">
              <input
                value={it.name}
                onChange={(e) => updateItem(it.key, { name: e.target.value })}
                className="w-full rounded-xl border px-3 py-2.5 text-sm"
                style={{ borderColor: "#E5E7EB" }}
              />
            </Field>
            <Field label="Price ($)" className="flex-1">
              <input
                value={it.price}
                onChange={(e) => updateItem(it.key, { price: e.target.value })}
                inputMode="decimal"
                className="w-full rounded-xl border px-3 py-2.5 text-sm"
                style={{ borderColor: "#E5E7EB" }}
              />
            </Field>
            <Field label="Photo URL" className="flex-[2]">
              <input
                value={it.photo_url}
                onChange={(e) => updateItem(it.key, { photo_url: e.target.value })}
                placeholder="https://..."
                className="w-full rounded-xl border px-3 py-2.5 text-sm"
                style={{ borderColor: "#E5E7EB" }}
              />
            </Field>
            <button
              type="button"
              onClick={() => removeItem(it.key)}
              disabled={items.length === 1}
              className="mb-0.5 shrink-0 rounded-xl px-3 py-2.5 text-sm disabled:opacity-30"
              style={{ background: "var(--kb-cream)" }}
            >
              Remove
            </button>
          </div>
        ))}
      </section>

      {error && (
        <p className="rounded-xl px-3 py-2 text-sm" style={{ background: "rgba(239,68,68,0.15)", color: "#B91C1C" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-2xl py-3.5 text-[15px] font-semibold text-white disabled:opacity-60"
        style={{ background: "linear-gradient(90deg, var(--kb-purple) 0%, var(--kb-green) 100%)" }}
      >
        {loading ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-xs font-medium ${className ?? ""}`} style={{ color: "var(--kb-ink-soft)" }}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
