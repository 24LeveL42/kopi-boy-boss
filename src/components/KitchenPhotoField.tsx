"use client";

import { useId, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { hqPhotoPath } from "@/lib/kitchen-admin";
import { Spinner } from "./Spinner";

/**
 * A photo for a kitchen or menu item: upload a file, or paste a link.
 * Uploads go to the kitchen-photos bucket at <kitchenId>/hq/<uuid>.<ext>,
 * the only path the admin storage policy allows (insert only; HQ never
 * overwrites or deletes the cook's photos). The URL is saved later by the
 * form's own Save, through a server action.
 */
export function KitchenPhotoField({
  kitchenId,
  label,
  value,
  onChange,
  disabled,
}: {
  kitchenId: string;
  label: string;
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    const target = hqPhotoPath(kitchenId, file, crypto.randomUUID());
    if (!target.ok) {
      setError(target.message);
      return;
    }
    setUploading(true);
    try {
      const storage = createClient().storage.from("kitchen-photos");
      const { error: uploadError } = await storage.upload(target.path, file, { contentType: file.type, upsert: false });
      if (uploadError) {
        setError(`Upload failed: ${uploadError.message}`);
        return;
      }
      onChange(storage.getPublicUrl(target.path).data.publicUrl);
    } catch (err) {
      setError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
        {label}
      </span>
      <div className="flex items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element -- user-uploaded Supabase Storage URL, not a static asset
          <img src={value} alt="" className="size-16 shrink-0 rounded-lg border object-cover" style={{ borderColor: "var(--oc-line)" }} />
        ) : (
          <span
            className="flex size-16 shrink-0 items-center justify-center rounded-lg border text-[11px]"
            style={{ borderColor: "var(--oc-line)", color: "var(--oc-text-soft)" }}
          >
            No photo
          </span>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={inputId}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${disabled || uploading ? "pointer-events-none opacity-50" : ""}`}
            style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
          >
            {uploading && <Spinner className="size-3.5" />}
            {uploading ? "Uploading…" : value ? "Replace photo" : "Upload photo"}
          </label>
          <input
            id={inputId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={disabled || uploading}
            onChange={upload}
          />
          {value && (
            <button
              type="button"
              disabled={disabled || uploading}
              onClick={() => onChange("")}
              className="text-sm underline disabled:opacity-50"
              style={{ color: "var(--oc-text-soft)" }}
            >
              Remove photo
            </button>
          )}
        </div>
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || uploading}
        placeholder="or paste a link: https://…"
        aria-label={`${label} link`}
        className="w-full rounded-lg border px-3 py-2 text-sm"
        style={{ borderColor: "var(--oc-line)", background: "var(--oc-card)", color: "var(--oc-text)" }}
      />
      {error && (
        <p role="alert" className="text-sm" style={{ color: "var(--oc-red-fg)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
