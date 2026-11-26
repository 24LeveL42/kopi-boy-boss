"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { importAssistedMenu } from "@/lib/actions";
import { CSV_MAX_ROWS, importNotice, planImport, previewCsv, replaceConfirmation, type ImportMode } from "@/lib/menu-csv";
import type { MenuItem } from "@/lib/types-kitchen";
import { Spinner } from "./Spinner";

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * CSV import for a draft menu: choose a .csv file or paste the text, see the
 * preview (nothing is saved), then Import. The server checks the text again
 * and saves it in one database call (importAssistedMenu).
 */
export function AssistedMenuImport({
  shopId,
  items,
  onImported,
}: {
  shopId: string;
  items: MenuItem[];
  onImported: (items: MenuItem[] | null) => void;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("add");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const preview = useMemo(() => (text.trim() ? previewCsv(text) : null), [text]);
  const plan = preview && preview.errors.length === 0 ? planImport(preview, items, mode) : null;
  const canImport = !!plan && preview!.total > 0 && !pending;

  async function readFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setNotice(null);
    setError(null);
    if (file.size > 200_000) {
      setError("That file is too big for a menu. Import at most 200 rows.");
      return;
    }
    setFileName(file.name);
    setText(await file.text());
  }

  function runImport() {
    if (!plan) return;
    if (mode === "replace" && !window.confirm(replaceConfirmation(plan.existingHidden))) return;
    setError(null);
    start(async () => {
      try {
        const result = await importAssistedMenu(shopId, text, mode);
        if (!result.ok) {
          setError(result.errors?.length ? `${result.message} ${result.errors.map((e) => (e.row ? `Row ${e.row}: ${e.message}` : e.message)).join(" ")}` : result.message);
          return;
        }
        setNotice(importNotice(result.counts, mode));
        setText("");
        setFileName(null);
        setMode("add");
        setOpen(false);
        onImported(result.items);
      } catch {
        setError("Not imported: your admin session couldn't be confirmed. Please sign in again and retry.");
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
          Import menu from CSV
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
        Import menu from CSV
      </h3>
      <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
        First row: <span className="font-mono">category,name,price,check_with_owner</span> (any order; name and price are required). Up to{" "}
        {CSV_MAX_ROWS} items. Rows with something in check_with_owner are imported hidden, with that text saved as a note for HQ (never copied to the shop). Nothing is saved until you press Import.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          className={`inline-flex cursor-pointer items-center rounded-lg border px-3 py-1.5 text-sm font-medium ${pending ? "pointer-events-none opacity-50" : ""}`}
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          Choose a .csv file
        </label>
        <input id={inputId} type="file" accept=".csv,text/csv" className="sr-only" disabled={pending} onChange={readFile} />
        {fileName && (
          <span className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
            {fileName}
          </span>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setFileName(null);
        }}
        disabled={pending}
        rows={6}
        placeholder={"or paste it here:\ncategory,name,price,check_with_owner\nNoodles,Laksa,6.50,"}
        aria-label="CSV text"
        className="w-full rounded-lg border px-3 py-2 font-mono text-xs"
        style={inputStyle}
      />

      {preview && <ImportPreview preview={preview} />}

      {plan && (
        <fieldset className="space-y-1 text-sm" style={{ color: "var(--oc-text)" }}>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${inputId}-mode`} checked={mode === "add"} onChange={() => setMode("add")} disabled={pending} />
            Add new items, skip ones already in the draft (visible or hidden)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${inputId}-mode`} checked={mode === "replace"} onChange={() => setMode("replace")} disabled={pending} />
            Replace all items in this draft (existing items are hidden, not deleted)
          </label>
          <p className="pt-1 text-xs" style={{ color: "var(--oc-text-soft)" }}>
            {mode === "add"
              ? `${plan.toImport} will be added${plan.hidden ? ` (${plan.hidden} hidden)` : ""}, ${plan.skipped} skipped because they're already in the draft.`
              : `${plan.toImport} will be added${plan.hidden ? ` (${plan.hidden} hidden)` : ""}. ${plan.existingHidden} existing item${plan.existingHidden === 1 ? "" : "s"} will be hidden.`}
          </p>
        </fieldset>
      )}

      {error && (
        <p role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={runImport}
          disabled={!canImport}
          aria-busy={pending}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--oc-accent)" }}
        >
          {pending && <Spinner className="size-3.5" />}
          {pending ? "Importing…" : "Import"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ImportPreview({ preview }: { preview: ReturnType<typeof previewCsv> }) {
  return (
    <div className="space-y-2 text-sm" style={{ color: "var(--oc-text)" }}>
      {preview.errors.length > 0 && (
        <div role="alert" className="rounded-lg px-3 py-2" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          <p className="font-semibold">Fix these first. Import is off until the file has no errors.</p>
          <ul className="mt-1 list-disc pl-5">
            {preview.errors.map((e, i) => (
              <li key={i}>{e.row ? `Row ${e.row}: ${e.message}` : e.message}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.unknownColumns.length > 0 && (
        <p className="text-xs" style={{ color: "var(--oc-text-soft)" }}>
          Ignored column{preview.unknownColumns.length === 1 ? "" : "s"}: {preview.unknownColumns.join(", ")}
        </p>
      )}
      {preview.total > 0 && (
        <>
          <p>
            <strong>{preview.total}</strong> item{preview.total === 1 ? "" : "s"}
            {preview.hidden > 0 && <> ({preview.hidden} hidden to check with the owner)</>} ·{" "}
            {preview.categories.map((c) => `${c.category ?? "No category"}: ${c.count}`).join(", ")}
            {preview.cheapest !== null && preview.dearest !== null && (
              <>
                {" "}
                · cheapest {money(preview.cheapest)}, dearest {money(preview.dearest)}
              </>
            )}
          </p>
          <div className="max-h-80 overflow-auto rounded-lg border" style={{ borderColor: "var(--oc-line)" }}>
            <table className="w-full text-left text-xs">
              <thead>
                <tr style={{ color: "var(--oc-text-soft)" }}>
                  <th className="px-2 py-1">Row</th>
                  <th className="px-2 py-1">Name</th>
                  <th className="px-2 py-1 text-right">Price</th>
                  <th className="px-2 py-1">Check with owner (saved as the note)</th>
                </tr>
              </thead>
              {preview.categories.map((c) => (
                <tbody key={(c.category ?? "").toLowerCase()}>
                  <tr>
                    <th colSpan={4} className="px-2 pt-2 pb-1 text-left font-semibold" style={{ color: "var(--oc-text)" }}>
                      {c.category ?? "No category"} ({c.count})
                    </th>
                  </tr>
                  {c.items.map((r) => (
                    <tr key={r.row} style={{ opacity: r.hidden ? 0.7 : 1 }}>
                      <td className="px-2 py-0.5">{r.row}</td>
                      <td className="px-2 py-0.5">
                        {r.name}
                        {r.hidden && " (hidden)"}
                      </td>
                      <td className="px-2 py-0.5 text-right">{money(r.price)}</td>
                      <td className="px-2 py-0.5">{r.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </>
      )}
    </div>
  );
}
