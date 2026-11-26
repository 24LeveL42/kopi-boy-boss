"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { setAssistedItemPhotos } from "@/lib/actions";
import { assistedPhotoPath } from "@/lib/assisted-onboarding";
import { categoryGroups, categoryLabel } from "@/lib/draft-menu";
import {
  BULK_PHOTO_JPEG_QUALITY,
  BULK_PHOTO_MAX_BYTES,
  BULK_PHOTO_TYPES,
  BULK_UPLOAD_CONCURRENCY,
  bulkApplyNotice,
  jpegName,
  matchByName,
  needsResize,
  pairInMenuOrder,
  planBulkPhotos,
  resizedSize,
  runPool,
  type RowState,
} from "@/lib/bulk-photos";
import type { MenuItem } from "@/lib/types-kitchen";
import { Spinner } from "./Spinner";

type How = "name" | "ambiguous" | "order" | "manual" | null;
type Entry = {
  key: string;
  /** The name HQ chose (matching uses this, even after a resize renames it .jpg). */
  fileName: string;
  status: "uploading" | "done" | "failed";
  url: string | null;
  error: string | null;
  itemId: string | null;
  how: How;
};

const STATE_LABEL: Record<RowState, string> = {
  update: "Will be set",
  skipped: "Skipped: item already has a photo",
  unassigned: "Not assigned: won't be applied",
  conflict: "Two photos on this item: pick one",
  unchanged: "Already this photo",
};

const HOW_LABEL: Record<Exclude<How, null>, string> = {
  name: "matched by file name",
  ambiguous: "ambiguous: more than one item has this name",
  order: "paired in menu order",
  manual: "chosen by hand",
};

/** Decodes the photo and, if it's over 5 MB or over 1600 px on the long side, re-encodes it as a 1600 px JPEG. */
async function preparePhoto(file: File): Promise<File> {
  if (!(BULK_PHOTO_TYPES as readonly string[]).includes(file.type)) throw new Error("Not a JPG, PNG or WebP photo.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (file.size <= BULK_PHOTO_MAX_BYTES) return file;
    throw new Error("Couldn't open this photo to make it smaller.");
  }
  try {
    if (!needsResize({ size: file.size, width: bitmap.width, height: bitmap.height })) return file;
    const { width, height } = resizedSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't make this photo smaller in the browser.");
    ctx.fillStyle = "#fff"; // a transparent PNG gets a white background as a JPEG
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", BULK_PHOTO_JPEG_QUALITY));
    if (!blob) throw new Error("Couldn't make this photo smaller in the browser.");
    return new File([blob], jpegName(file.name), { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

/**
 * "Bulk photos" for a draft menu: choose many photos, they upload (3 at a
 * time, shrunk first if big) to kitchen-photos/assisted/<shopId>/, then a
 * preview pairs each photo with an item, by file name or in menu order, and
 * HQ can change any pairing. Nothing is saved to the menu until Apply.
 */
export function AssistedBulkPhotos({
  shopId,
  items,
  onApplied,
}: {
  shopId: string;
  items: MenuItem[];
  onApplied: (items: MenuItem[] | null) => void;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Entry[]>([]);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [pairCategory, setPairCategory] = useState<string>("*");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyFailures, setApplyFailures] = useState<string[]>([]);
  const [pending, start] = useTransition();
  // Auto-match reads the latest menu when each upload finishes.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const groups = useMemo(() => categoryGroups(items), [items]);
  const plan = useMemo(() => planBulkPhotos(rows, items, replaceExisting), [rows, items, replaceExisting]);
  const uploading = rows.filter((r) => r.status === "uploading").length;
  const done = rows.filter((r) => r.status === "done");
  const failed = rows.filter((r) => r.status === "failed");
  const busy = pending || uploading > 0;

  function patch(key: string, change: Partial<Entry>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }

  async function choose(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    setNotice(null);
    setError(null);
    const added: Entry[] = files.map((f) => ({
      key: crypto.randomUUID(),
      fileName: f.name,
      status: "uploading",
      url: null,
      error: null,
      itemId: null,
      how: null,
    }));
    setRows((prev) => [...prev, ...added]);
    const storage = createClient().storage.from("kitchen-photos");
    await runPool(
      files,
      BULK_UPLOAD_CONCURRENCY,
      async (file) => {
        const photo = await preparePhoto(file);
        const target = assistedPhotoPath(shopId, photo, crypto.randomUUID());
        if (!target.ok) throw new Error(target.message);
        const { error: uploadError } = await storage.upload(target.path, photo, { contentType: photo.type, upsert: false });
        if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
        return storage.getPublicUrl(target.path).data.publicUrl;
      },
      (i, result) => {
        const entry = added[i];
        if (!result.ok) {
          patch(entry.key, { status: "failed", error: result.message });
          return;
        }
        const match = matchByName(entry.fileName, itemsRef.current);
        patch(entry.key, {
          status: "done",
          url: result.value,
          itemId: match.itemId,
          how: match.itemId ? "name" : match.ambiguous ? "ambiguous" : null,
        });
      }
    );
  }

  function pairInOrder() {
    const pairs = pairInMenuOrder(
      done.map((r) => ({ key: r.key, fileName: r.fileName })),
      items,
      { replaceExisting, ...(pairCategory === "*" ? {} : { category: pairCategory }) }
    );
    setRows((prev) =>
      prev.map((r) => (pairs.has(r.key) ? { ...r, itemId: pairs.get(r.key) ?? null, how: pairs.get(r.key) ? "order" : null } : r))
    );
  }

  function apply() {
    if (!plan.updates.length || plan.conflicts) return;
    setError(null);
    setApplyFailures([]);
    start(async () => {
      try {
        const result = await setAssistedItemPhotos(shopId, plan.updates, replaceExisting);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        const name = new Map(items.map((i) => [i.id, i.name]));
        setApplyFailures(result.failed.map((f) => `${name.get(f.itemId) ?? "An item"}: ${f.message}`));
        setNotice(bulkApplyNotice(result.updated, result.skipped, result.failed.length));
        const fresh = result.items;
        if (fresh) {
          // Photos now on their item are done; the rest stay in the list.
          const set = new Set(fresh.filter((i) => i.photo_url).map((i) => `${i.id} ${i.photo_url}`));
          setRows((prev) => prev.filter((r) => !(r.itemId && set.has(`${r.itemId} ${r.url}`))));
        }
        onApplied(fresh);
      } catch {
        setError("Not saved: your admin session couldn't be confirmed. Please sign in again and retry.");
      }
    });
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setNotice(null);
          }}
          className="rounded-lg border px-3 py-1.5 text-sm font-medium"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          Bulk photos
        </button>
        {notice && (
          <p role="status" className="rounded-lg px-3 py-1.5 text-sm" style={{ background: "var(--oc-green-bg)", color: "var(--oc-green-fg)" }}>
            {notice}
          </p>
        )}
      </div>
    );
  }

  const inputStyle = { borderColor: "var(--oc-line)", background: "var(--oc-card)", color: "var(--oc-text)" };
  return (
    <div className="space-y-3 rounded-lg border p-3" style={{ borderColor: "var(--oc-line)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
        Bulk photos
      </h3>
      <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
        Choose many JPG, PNG or WebP photos. Big ones are made smaller first (1600 px, JPEG). A photo named like an item (egg-prata.jpg for
        “Egg Prata”) is paired with it automatically. Check the pairs below; nothing is saved to the menu until you press Apply. Photos you
        upload but don&apos;t apply stay in storage.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${pending ? "pointer-events-none opacity-50" : ""}`}
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          Choose photos
        </label>
        <input id={inputId} type="file" multiple accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={pending} onChange={choose} />
        {rows.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-sm" style={{ color: "var(--oc-text-soft)" }} aria-live="polite">
            {uploading > 0 && <Spinner className="size-3.5" />}
            {done.length + failed.length} of {rows.length} uploaded{failed.length > 0 && `, ${failed.length} failed`}
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <progress className="w-full" max={rows.length} value={done.length + failed.length} aria-label="Upload progress" />
      )}

      {failed.length > 0 && (
        <div role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          <p className="font-semibold">Not uploaded (the others carried on):</p>
          <ul className="mt-1 list-disc pl-5">
            {failed.map((r) => (
              <li key={r.key}>
                {r.fileName}: {r.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {done.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: "var(--oc-text)" }}>
            <button
              type="button"
              onClick={pairInOrder}
              disabled={busy}
              className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
              style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
            >
              Pair in menu order
            </button>
            <select
              value={pairCategory}
              onChange={(e) => setPairCategory(e.target.value)}
              disabled={busy}
              aria-label="Pair in menu order: which items"
              className="rounded-lg border px-2 py-1.5 text-sm"
              style={inputStyle}
            >
              <option value="*">All categories</option>
              {groups.map((g) => (
                <option key={g.key} value={g.category ?? ""}>
                  Only {categoryLabel(g.category)}
                </option>
              ))}
            </select>
            <span className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
              Photos sorted by file name (IMG_2 before IMG_10), one per item from the first item with no photo.
            </span>
          </div>

          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {done.map((r) => {
              const state = plan.rows.get(r.key) ?? "unassigned";
              const warn = state === "conflict" || state === "skipped" || state === "unassigned";
              return (
                <li key={r.key} className="flex gap-2 rounded-lg border p-2" style={{ borderColor: state === "conflict" ? "var(--oc-red-fg)" : "var(--oc-line)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- just-uploaded Supabase Storage URL */}
                  <img src={r.url!} alt="" className="size-16 shrink-0 rounded-lg border object-cover" style={{ borderColor: "var(--oc-line)" }} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-xs" style={{ color: "var(--oc-text-soft)" }} title={r.fileName}>
                      {r.fileName}
                      {r.how && ` · ${HOW_LABEL[r.how]}`}
                    </p>
                    <select
                      value={r.itemId ?? ""}
                      onChange={(e) => patch(r.key, { itemId: e.target.value || null, how: e.target.value ? "manual" : null })}
                      disabled={pending}
                      aria-label={`Menu item for ${r.fileName}`}
                      className="w-full rounded-lg border px-2 py-1 text-sm"
                      style={inputStyle}
                    >
                      <option value="">Not assigned</option>
                      {groups.map((g) => (
                        <optgroup key={g.key} label={categoryLabel(g.category)}>
                          {g.items.map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name}
                              {i.is_hidden ? " (hidden)" : ""}
                              {i.photo_url ? " · has photo" : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <p className="text-xs" style={{ color: warn ? "var(--oc-red-fg)" : "var(--oc-green-fg)" }}>
                      {STATE_LABEL[state]}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>

          <label className="flex items-center gap-2 text-sm" style={{ color: "var(--oc-text)" }}>
            <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} disabled={pending} />
            Also replace photos that are already set
          </label>
          <p className="text-sm" style={{ color: "var(--oc-text)" }}>
            <strong>{plan.toUpdate}</strong> item{plan.toUpdate === 1 ? "" : "s"} to update · <strong>{plan.skipped}</strong> skipped (already have a
            photo) · <strong>{plan.unmatched}</strong> unmatched photo{plan.unmatched === 1 ? "" : "s"}
            {plan.conflicts > 0 && (
              <span style={{ color: "var(--oc-red-fg)" }}>
                {" "}
                · {plan.conflicts} photos share an item: give each item one photo before applying
              </span>
            )}
          </p>
        </>
      )}

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
      {applyFailures.length > 0 && (
        <ul role="alert" className="list-disc rounded-lg py-2 pr-3 pl-8 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          {applyFailures.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={busy || plan.toUpdate === 0 || plan.conflicts > 0}
          aria-busy={pending}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--oc-accent)" }}
        >
          {pending && <Spinner className="size-3.5" />}
          {pending ? "Applying…" : `Apply to ${plan.toUpdate} item${plan.toUpdate === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setRows([]);
            setError(null);
            setApplyFailures([]);
          }}
          disabled={busy}
          className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
