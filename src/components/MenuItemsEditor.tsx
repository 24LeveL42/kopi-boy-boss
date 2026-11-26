"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { addMenuItem, setMenuItemHidden, updateMenuItem } from "@/lib/actions";
import type { MenuItemInput, MenuItemResult } from "@/lib/kitchen-admin";
import type { MenuItem } from "@/lib/types-kitchen";
import { categoryGroups, categoryLabel, categoryPhotoButtonLabel, categoryPhotoNotice, categoryPhotoTargets, type CategoryGroup } from "@/lib/draft-menu";
import { CATEGORY_MAX, NOTE_MAX } from "@/lib/menu-csv";
import type { CategoryPhotoResult } from "@/lib/assisted-onboarding";
import { KitchenPhotoField } from "./KitchenPhotoField";
import { Spinner } from "./Spinner";

type PhotoPath = (file: { type: string; size: number }, uuid: string) => { ok: true; path: string } | { ok: false; message: string };

/**
 * The three item saves. The default is the live kitchen's (menu_items); an
 * assisted-onboarding draft passes its own (assisted_shop_items), with the
 * same arguments and results.
 */
export type MenuEditorActions = {
  add: (ownerId: string, item: MenuItemInput) => Promise<MenuItemResult>;
  update: (ownerId: string, itemId: string, loadedUpdatedAt: string, item: MenuItemInput) => Promise<MenuItemResult>;
  setHidden: (ownerId: string, itemId: string, loadedUpdatedAt: string, hidden: boolean) => Promise<MenuItemResult>;
};

const KITCHEN_ACTIONS: MenuEditorActions = { add: addMenuItem, update: updateMenuItem, setHidden: setMenuItemHidden };

/** "Set photo for all [Category] items" (assisted drafts only). */
export type CategoryPhotoAction = (ownerId: string, category: string | null, photoUrl: string, replaceExisting: boolean) => Promise<CategoryPhotoResult>;

type EditorContext = { actions: MenuEditorActions; photoPath?: PhotoPath; draft: boolean; categories: string[] };

/**
 * HQ adds, edits and hides a kitchen's menu items, one item per save, through
 * server actions (each with the item's updated_at as a stale-edit check).
 * There is deliberately no delete: hiding keeps the item and its history, and
 * customers stop seeing it at once.
 */
export function MenuItemsEditor({
  kitchenId,
  initialItems,
  actions = KITCHEN_ACTIONS,
  photoPath,
  draft = false,
  setCategoryPhoto,
  onItemsChange,
}: {
  kitchenId: string;
  initialItems: MenuItem[];
  actions?: MenuEditorActions;
  photoPath?: PhotoPath;
  /** An assisted-onboarding draft: nothing is shown to customers yet, so the wording changes, items have a category and are grouped by it. */
  draft?: boolean;
  /** Drafts only: the category photo button on each category heading. */
  setCategoryPhoto?: CategoryPhotoAction;
  /** Told the current list after every change (the CSV import counts against it). */
  onItemsChange?: (items: MenuItem[]) => void;
}) {
  const [items, setItems] = useState<MenuItem[]>(initialItems);
  useEffect(() => {
    onItemsChange?.(items);
  }, [items, onItemsChange]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const groups = draft ? categoryGroups(items) : [];
  const ctx: EditorContext = { actions, photoPath, draft, categories: groups.map((g) => g.category).filter((c): c is string => c !== null) };

  const visible = items.filter((i) => !i.is_hidden);
  const hidden = items.filter((i) => i.is_hidden);

  function replace(item: MenuItem) {
    setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
  }

  if (draft) {
    return (
      <div className="space-y-5">
        {groups.length === 0 && (
          <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
            No items yet. Add them below or import a CSV file. Add at least one visible item before sending the claim link.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.key}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
                {categoryLabel(group.category)} ({group.items.length}
                {group.hiddenCount > 0 && `, ${group.hiddenCount} hidden: not copied to the shop`})
              </h3>
              {setCategoryPhoto && (
                <CategoryPhotoButton
                  group={group}
                  kitchenId={kitchenId}
                  photoPath={photoPath}
                  onApply={(url, replaceExisting) => setCategoryPhoto(kitchenId, group.category, url, replaceExisting)}
                  onItems={setItems}
                />
              )}
            </div>
            <ul className="divide-y rounded-lg border" style={{ borderColor: "var(--oc-line)" }}>
              {group.items.map((item) =>
                editingId === item.id ? (
                  <li key={item.id} className="p-3" style={{ borderColor: "var(--oc-line)" }}>
                    <EditItemForm
                      ctx={ctx}
                      kitchenId={kitchenId}
                      item={item}
                      onDone={(saved) => {
                        if (saved) replace(saved);
                        setEditingId(null);
                      }}
                    />
                  </li>
                ) : (
                  <ItemRow key={item.id} ctx={ctx} kitchenId={kitchenId} item={item} onEdit={() => setEditingId(item.id)} onSaved={replace} />
                )
              )}
            </ul>
          </section>
        ))}
        <AddItemForm ctx={ctx} kitchenId={kitchenId} onAdded={(item) => setItems((prev) => [...prev, item])} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ItemGroup
        title={`On the menu (${visible.length})`}
        empty={draft ? "No visible items yet. Add at least one before sending the claim link." : "No visible items. Customers see an empty menu."}
        items={visible}
        ctx={ctx}
        kitchenId={kitchenId}
        editingId={editingId}
        setEditingId={setEditingId}
        onSaved={replace}
      />
      {hidden.length > 0 && (
        <ItemGroup
          title={draft ? `Hidden: not copied to the shop (${hidden.length})` : `Hidden from customers (${hidden.length})`}
          empty=""
          items={hidden}
          ctx={ctx}
          kitchenId={kitchenId}
          editingId={editingId}
          setEditingId={setEditingId}
          onSaved={replace}
        />
      )}
      <AddItemForm ctx={ctx} kitchenId={kitchenId} onAdded={(item) => setItems((prev) => [...prev, item])} />
    </div>
  );
}

function ItemGroup(props: {
  title: string;
  empty: string;
  items: MenuItem[];
  ctx: EditorContext;
  kitchenId: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onSaved: (item: MenuItem) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
        {props.title}
      </h3>
      {props.items.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
          {props.empty}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border" style={{ borderColor: "var(--oc-line)" }}>
          {props.items.map((item) =>
            props.editingId === item.id ? (
              <li key={item.id} className="p-3" style={{ borderColor: "var(--oc-line)" }}>
                <EditItemForm
                  ctx={props.ctx}
                  kitchenId={props.kitchenId}
                  item={item}
                  onDone={(saved) => {
                    if (saved) props.onSaved(saved);
                    props.setEditingId(null);
                  }}
                />
              </li>
            ) : (
              <ItemRow
                key={item.id}
                ctx={props.ctx}
                kitchenId={props.kitchenId}
                item={item}
                onEdit={() => props.setEditingId(item.id)}
                onSaved={props.onSaved}
              />
            )
          )}
        </ul>
      )}
    </section>
  );
}

const money = (n: number) => `$${Number(n).toFixed(2)}`;

function useItemAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  function run(call: () => Promise<MenuItemResult>, onOk: (item: MenuItem) => void) {
    setError(null);
    setStale(false);
    start(async () => {
      try {
        const result = await call();
        if (result.ok) onOk(result.item);
        else {
          setError(result.message);
          setStale(result.stale === true);
        }
      } catch {
        setError("Not saved: your admin session couldn't be confirmed. Please sign in again and retry.");
      }
    });
  }
  return { pending, error, stale, run };
}

function ItemError({ error, stale }: { error: string | null; stale: boolean }) {
  if (!error) return null;
  return (
    <div role="alert" className="mt-2 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
      <p>{error}</p>
      {stale && (
        <button type="button" onClick={() => window.location.reload()} className="mt-1 font-semibold underline">
          Reload the page
        </button>
      )}
    </div>
  );
}

function ItemRow({
  ctx,
  kitchenId,
  item,
  onEdit,
  onSaved,
}: {
  ctx: EditorContext;
  kitchenId: string;
  item: MenuItem;
  onEdit: () => void;
  onSaved: (item: MenuItem) => void;
}) {
  const { pending, error, stale, run } = useItemAction();
  return (
    <li className="p-3" style={{ borderColor: "var(--oc-line)", opacity: item.is_hidden ? 0.75 : 1 }}>
      <div className="flex items-center gap-3">
        {item.photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- user-uploaded Supabase Storage URL, not a static asset
          <img src={item.photo_url} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="size-10 shrink-0 rounded-lg" style={{ background: "var(--oc-grey-bg)" }} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" style={{ color: "var(--oc-text)" }}>
            {item.name}
            {item.is_hidden && (
              <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ background: "var(--oc-grey-bg)", color: "var(--oc-grey-fg)" }}>
                Hidden
              </span>
            )}
          </p>
          <p className="text-sm" style={{ color: "var(--oc-text-soft)" }}>
            {money(item.price)}
          </p>
          {ctx.draft && item.owner_note && (
            <p className="mt-0.5 text-xs" style={{ color: "var(--oc-amber-fg)" }}>
              Check with owner: {item.owner_note}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onEdit}
          disabled={pending}
          className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={pending}
          aria-busy={pending}
          onClick={() => run(() => ctx.actions.setHidden(kitchenId, item.id, item.updated_at, !item.is_hidden), onSaved)}
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          {pending && <Spinner className="size-3.5" />}
          {item.is_hidden ? "Show again" : "Hide"}
        </button>
      </div>
      <ItemError error={error} stale={stale} />
    </li>
  );
}

function ItemFields({
  photoPath,
  kitchenId,
  name,
  price,
  photo,
  setName,
  setPrice,
  setPhoto,
  disabled,
  category,
  setCategory,
  categories,
  note,
  setNote,
}: {
  photoPath?: PhotoPath;
  kitchenId: string;
  name: string;
  price: string;
  photo: string;
  setName: (v: string) => void;
  setPrice: (v: string) => void;
  setPhoto: (v: string) => void;
  disabled: boolean;
  /** Drafts only: shown when setCategory is passed. */
  category?: string;
  setCategory?: (v: string) => void;
  categories?: string[];
  /** Drafts only: shown when setNote is passed. */
  note?: string;
  setNote?: (v: string) => void;
}) {
  const inputStyle = { borderColor: "var(--oc-line)", background: "var(--oc-card)", color: "var(--oc-text)" };
  const listId = useId();
  return (
    <div className="space-y-3">
      {setCategory && (
        <label className="block text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
          Category (optional)
          <input
            value={category ?? ""}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={CATEGORY_MAX}
            list={listId}
            placeholder="e.g. Noodles, Drinks"
            disabled={disabled}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          />
          <datalist id={listId}>
            {(categories ?? []).map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <label className="block text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
          Item name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            disabled={disabled}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          />
        </label>
        <label className="block text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
          Price ($)
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            placeholder="4.50"
            disabled={disabled}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          />
        </label>
      </div>
      <KitchenPhotoField kitchenId={kitchenId} label="Item photo" value={photo} onChange={setPhoto} disabled={disabled} uploadPath={photoPath} />
      {setNote && (
        <label className="block text-xs font-medium" style={{ color: "var(--oc-text-soft)" }}>
          Check with owner (HQ only, not copied to the shop)
          <div className="mt-1 flex gap-2">
            <input
              value={note ?? ""}
              onChange={(e) => setNote(e.target.value)}
              maxLength={NOTE_MAX}
              placeholder="e.g. Is this still on the menu?"
              disabled={disabled}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={inputStyle}
            />
            {note && (
              <button
                type="button"
                onClick={() => setNote("")}
                disabled={disabled}
                className="shrink-0 text-sm underline disabled:opacity-50"
                style={{ color: "var(--oc-text-soft)" }}
              >
                Clear note
              </button>
            )}
          </div>
        </label>
      )}
    </div>
  );
}

function EditItemForm({
  ctx,
  kitchenId,
  item,
  onDone,
}: {
  ctx: EditorContext;
  kitchenId: string;
  item: MenuItem;
  onDone: (saved: MenuItem | null) => void;
}) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(Number(item.price).toFixed(2));
  const [photo, setPhoto] = useState(item.photo_url ?? "");
  const [category, setCategory] = useState(item.category ?? "");
  const [note, setNote] = useState(item.owner_note ?? "");
  const { pending, error, stale, run } = useItemAction();

  function save(e: React.FormEvent) {
    e.preventDefault();
    const values: MenuItemInput = { name, price, photo_url: photo || null };
    if (ctx.draft) {
      values.category = category || null;
      values.owner_note = note.trim() || null;
    }
    run(() => ctx.actions.update(kitchenId, item.id, item.updated_at, values), onDone);
  }

  return (
    <form onSubmit={save}>
      <ItemFields
        photoPath={ctx.photoPath}
        kitchenId={kitchenId}
        name={name}
        price={price}
        photo={photo}
        setName={setName}
        setPrice={setPrice}
        setPhoto={setPhoto}
        disabled={pending}
        {...(ctx.draft ? { category, setCategory, categories: ctx.categories, note, setNote } : {})}
      />
      <ItemError error={error} stale={stale} />
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--oc-accent)" }}
        >
          {pending && <Spinner className="size-3.5" />}
          {pending ? "Saving…" : "Save item"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onDone(null)}
          className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddItemForm({ ctx, kitchenId, onAdded }: { ctx: EditorContext; kitchenId: string; onAdded: (item: MenuItem) => void }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [photo, setPhoto] = useState("");
  const [category, setCategory] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const { pending, error, stale, run } = useItemAction();

  function add(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const values: MenuItemInput = { name, price, photo_url: photo || null };
    if (ctx.draft) values.category = category || null;
    run(
      () => ctx.actions.add(kitchenId, values),
      (item) => {
        onAdded(item);
        setName("");
        setPrice("");
        setPhoto("");
        // The category stays: the next item is often in the same one.
        setNotice(ctx.draft ? `Added “${item.name}” to the draft menu.` : `Added “${item.name}”. Customers can see it now.`);
      }
    );
  }

  return (
    <form onSubmit={add} className="rounded-lg border p-3" style={{ borderColor: "var(--oc-line)" }}>
      <h3 className="mb-2 text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
        Add a menu item
      </h3>
      <ItemFields
        photoPath={ctx.photoPath}
        kitchenId={kitchenId}
        name={name}
        price={price}
        photo={photo}
        setName={setName}
        setPrice={setPrice}
        setPhoto={setPhoto}
        disabled={pending}
        {...(ctx.draft ? { category, setCategory, categories: ctx.categories } : {})}
      />
      <ItemError error={error} stale={stale} />
      {notice && (
        <p role="status" className="mt-2 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-green-bg)", color: "var(--oc-green-fg)" }}>
          {notice}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        style={{ background: "var(--oc-accent)" }}
      >
        {pending && <Spinner className="size-3.5" />}
        {pending ? "Adding…" : "Add item"}
      </button>
    </form>
  );
}

/**
 * "Set photo for all [Category] items": upload or paste a link (the same
 * field and limits as the shop photo), then one server call sets it on every
 * item of the category that has no photo yet (hidden ones too), or on all of
 * them with the checkbox. Each item's photo can still be changed afterwards.
 */
function CategoryPhotoButton({
  group,
  kitchenId,
  photoPath,
  onApply,
  onItems,
}: {
  group: CategoryGroup<MenuItem>;
  kitchenId: string;
  photoPath?: PhotoPath;
  onApply: (photoUrl: string, replaceExisting: boolean) => Promise<CategoryPhotoResult>;
  onItems: (items: MenuItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const label = categoryPhotoButtonLabel(group.category);
  const targets = photo ? categoryPhotoTargets(group, photo, replaceExisting) : null;

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        {notice && (
          <span role="status" className="text-xs" style={{ color: "var(--oc-green-fg)" }}>
            {notice}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setNotice(null);
          }}
          className="rounded-lg border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--oc-line)", color: "var(--oc-text)" }}
        >
          {label}
        </button>
      </div>
    );
  }

  function apply() {
    setError(null);
    start(async () => {
      try {
        const result = await onApply(photo, replaceExisting);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        if (result.items) onItems(result.items);
        else window.location.reload();
        setNotice(categoryPhotoNotice(result.updated));
        setOpen(false);
        setPhoto("");
        setReplaceExisting(false);
      } catch {
        setError("Not saved: your admin session couldn't be confirmed. Please sign in again and retry.");
      }
    });
  }

  return (
    <div className="w-full rounded-lg border p-3" style={{ borderColor: "var(--oc-line)" }}>
      <p className="mb-2 text-sm font-semibold" style={{ color: "var(--oc-text)" }}>
        {label}
      </p>
      <KitchenPhotoField kitchenId={kitchenId} label="Category photo" value={photo} onChange={setPhoto} disabled={pending} uploadPath={photoPath} />
      <label className="mt-2 flex items-center gap-2 text-sm" style={{ color: "var(--oc-text)" }}>
        <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} disabled={pending} />
        Also replace photos that are already set
      </label>
      <p className="mt-1 text-xs" style={{ color: "var(--oc-text-soft)" }}>
        {targets === null
          ? `${group.withoutPhoto} of ${group.items.length} items have no photo yet. Hidden items are included.`
          : `This will set the photo on ${targets} item${targets === 1 ? "" : "s"} (hidden ones included).`}
      </p>
      {error && (
        <p role="alert" className="mt-2 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--oc-red-bg)", color: "var(--oc-red-fg)" }}>
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={pending || !photo}
          aria-busy={pending}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--oc-accent)" }}
        >
          {pending && <Spinner className="size-3.5" />}
          {pending ? "Saving…" : "Set photo"}
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
