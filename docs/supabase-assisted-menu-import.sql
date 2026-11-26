-- ============================================================================
-- KOPI BOY — Assisted onboarding: draft menu categories and owner notes,
-- CSV import and "Set photo for a category". Rev 2, NOT INSTALLED. Review first.
-- Live test: docs/supabase-assisted-menu-import-live-test.sql (always rolls back).
-- PGlite test: src/lib/assisted-onboarding-sql.test.ts ("menu import").
--
-- WHAT IT ADDS (drafts only; nothing about the live kitchen changes)
--   1. assisted_shop_items.category: nullable text, trimmed (inner runs of
--      spaces become one), 1-60 characters. Granted to HQ like the other
--      item columns (select, insert, update). It stays in the DRAFT: the
--      claim (assisted_claim_complete, unchanged) does not copy it.
--   1b. assisted_shop_items.owner_note: nullable text, trimmed, 1-200
--      characters: what HQ must check with the owner (the CSV's
--      check_with_owner). Same grants as the other item columns (HQ only,
--      through the admin-only RLS policies), draft only, NOT copied at
--      claim and not in the claim preview. The audit never holds its text:
--      a single-item edit logs only 'none' / 'set' for it (like the masked
--      owner mobile), and the bulk rows hold counts only.
--   2. admin_import_assisted_menu(shop_id, items jsonb, replace_all):
--      the CSV import. Admin only, drafts only (claimed and cancelled shops
--      are refused). Up to 200 rows, checked again here: name 1-80, price
--      > 0 and <= 9999.99 with at most 2 decimals, category <= 60,
--      no duplicate name + category in the file (case and extra spaces
--      ignored). Rows marked hidden are imported hidden, with their
--      check_with_owner text (note, <= 200) saved in owner_note; a note on
--      a visible row is refused. Default: skip rows
--      whose name + category already exists in the draft (visible or
--      hidden). replace_all: HIDE every visible draft item first (never
--      deletes), then add all rows. File order is kept as display order.
--      Returns {imported, hidden, skipped, existing_hidden}.
--   3. admin_set_assisted_category_photo(shop_id, category, photo_url,
--      replace_existing): sets the photo on every item of that category in
--      the draft (hidden ones too) that has no photo yet, or on all of them
--      with replace_existing. category null = the items with no category.
--      Admin only, drafts only. Returns how many items changed.
--   4. Audit: two new actions, 'menu_imported' and 'category_photo_set',
--      ONE summary row per call with counts only (no menu text, no link).
--      The per-item audit trigger skips the rows these two functions write
--      (transaction-local kb_assist.bulk = 'on', set and cleared only inside
--      them; browser roles can't run set_config). Every other item edit is
--      still logged one row per item, exactly as before.
--
-- WHAT IT DOES NOT TOUCH: assisted_claim_complete, guard_admin_kitchen_edit
-- (the kitchen guard), stamp_kitchen_terms_acknowledgement (the terms
-- trigger) and guard_assisted_shop_item. Section 0 records their definitions
-- and section 6 refuses to commit if any of them changed. The only existing
-- function replaced is audit_assisted_onboarding_row (one early return
-- added; the rest is the same).
--
-- RUN ORDER: after docs/supabase-assisted-onboarding.sql. Run it on the live
-- database BEFORE the Boss code that reads assisted_shop_items.category is
-- deployed. Once this is installed, supabase-assisted-onboarding.sql refuses
-- to re-run (it would drop the category grants and put the old audit
-- trigger back); re-run THIS file instead.
--
-- Runs as one transaction: if any check fails, nothing is changed.
-- Safe to re-run.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. CHECKS BEFORE ANYTHING CHANGES, and the fingerprints section 6 compares.
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := array[]::text[];
  v_name text;
begin
  foreach v_name in array array['assisted_shops', 'assisted_shop_items', 'assisted_onboarding_audit'] loop
    if to_regclass('public.' || v_name) is null then
      v_missing := pg_catalog.array_append(v_missing, 'public.' || v_name || ' (supabase-assisted-onboarding.sql)');
    end if;
  end loop;
  foreach v_name in array array[
    'public.user_has_role(text)', 'auth.uid()', 'public.mask_paynow(text)',
    'public.audit_assisted_onboarding_row()', 'public.guard_assisted_shop_item()',
    'public.assisted_claim_complete(text, text, uuid, text, text)',
    'public.guard_admin_kitchen_edit()', 'public.stamp_kitchen_terms_acknowledgement()'
  ] loop
    if to_regprocedure(v_name) is null then
      v_missing := pg_catalog.array_append(v_missing, v_name);
    end if;
  end loop;
  if to_regclass('public.assisted_shop_items') is not null then
    foreach v_name in array array['a_assisted_shop_item_guard', 'z_assisted_shop_item_audit'] loop
      if not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.assisted_shop_items'::regclass and not t.tgisinternal and t.tgname = v_name) then
        v_missing := pg_catalog.array_append(v_missing, 'trigger ' || v_name);
      end if;
    end loop;
  end if;
  if array_length(v_missing, 1) > 0 then
    raise exception 'menu import: missing %. Nothing was changed.', array_to_string(v_missing, ', ');
  end if;

  perform set_config('kb_menu.claim_md5', md5(pg_get_functiondef('public.assisted_claim_complete(text, text, uuid, text, text)'::regprocedure)), true);
  perform set_config('kb_menu.guard_md5', md5(pg_get_functiondef('public.guard_admin_kitchen_edit()'::regprocedure)), true);
  perform set_config('kb_menu.terms_md5', md5(pg_get_functiondef('public.stamp_kitchen_terms_acknowledgement()'::regprocedure)), true);
  perform set_config('kb_menu.item_guard_md5', md5(pg_get_functiondef('public.guard_assisted_shop_item()'::regprocedure)), true);
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. THE CATEGORY COLUMN (draft only), trimmed by its own small trigger.
-- ----------------------------------------------------------------------------
alter table public.assisted_shop_items add column if not exists category text;
alter table public.assisted_shop_items drop constraint if exists assisted_shop_items_category_check;
alter table public.assisted_shop_items add constraint assisted_shop_items_category_check check (
  category is null or (char_length(category) between 1 and 60 and category = pg_catalog.btrim(category))
);
comment on column public.assisted_shop_items.category is
  'Draft menu category (CSV import or the editor). Trimmed, 1-60 characters. Not copied to the kitchen at claim.';

alter table public.assisted_shop_items add column if not exists owner_note text;
alter table public.assisted_shop_items drop constraint if exists assisted_shop_items_owner_note_check;
alter table public.assisted_shop_items add constraint assisted_shop_items_owner_note_check check (
  owner_note is null or (char_length(owner_note) between 1 and 200 and owner_note = pg_catalog.btrim(owner_note))
);
comment on column public.assisted_shop_items.owner_note is
  'What HQ must check with the owner (CSV check_with_owner, or typed in the editor). Trimmed, 1-200 characters. HQ only, draft only, not copied at claim, never written to the audit.';

-- One small trigger trims both draft-only fields ('' becomes null).
create or replace function public.normalize_assisted_item_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.category := nullif(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(new.category, '')), '\s+', ' ', 'g'), '');
  new.owner_note := nullif(pg_catalog.btrim(coalesce(new.owner_note, '')), '');
  return new;
end;
$$;

-- Runs after a_assisted_shop_item_guard (triggers fire in name order).
drop trigger if exists b_assisted_shop_item_normalize on public.assisted_shop_items;
create trigger b_assisted_shop_item_normalize
  before insert or update on public.assisted_shop_items
  for each row execute function public.normalize_assisted_item_fields();

-- Same pattern as the other item columns.
grant select (category, owner_note) on public.assisted_shop_items to authenticated;
grant insert (category, owner_note) on public.assisted_shop_items to authenticated;
grant update (category, owner_note) on public.assisted_shop_items to authenticated;


-- ----------------------------------------------------------------------------
-- 2. TWO NEW AUDIT ACTIONS (summary rows, counts only).
-- ----------------------------------------------------------------------------
alter table public.assisted_onboarding_audit drop constraint if exists assisted_onboarding_audit_action_check;
alter table public.assisted_onboarding_audit add constraint assisted_onboarding_audit_action_check check (action in (
  'shop_created', 'shop_updated', 'shop_cancelled',
  'item_added', 'item_updated', 'item_hidden', 'item_unhidden',
  'link_issued', 'link_sent', 'link_revoked', 'claimed',
  'menu_imported', 'category_photo_set'
));


-- ----------------------------------------------------------------------------
-- 3. THE PER-ITEM AUDIT TRIGGER: as in supabase-assisted-onboarding.sql,
-- plus one early return for the item rows the two bulk functions write, and
-- owner_note logged as 'none' / 'set' only (never its text).
-- ----------------------------------------------------------------------------
create or replace function public.audit_assisted_onboarding_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := pg_catalog.to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then pg_catalog.to_jsonb(old) else '{}'::jsonb end;
  v_changes jsonb;
  v_action text;
  v_shop_id uuid;
  v_shop_name text;
begin
  if auth.uid() is null then
    return null;
  end if;

  -- The CSV import and the category photo write ONE summary row themselves.
  if tg_table_name = 'assisted_shop_items'
     and coalesce(pg_catalog.current_setting('kb_assist.bulk', true), '') = 'on' then
    return null;
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(
           n.key,
           case when n.key = 'owner_mobile'
             then pg_catalog.jsonb_build_object(
                    'old', public.mask_paynow(v_old ->> 'owner_mobile'),
                    'new', public.mask_paynow(v_new ->> 'owner_mobile'))
             -- The owner note's text never goes in the audit: only whether one is set.
             when n.key = 'owner_note'
             then pg_catalog.jsonb_build_object(
                    'old', case when tg_op = 'INSERT' then null when (v_old ->> 'owner_note') is null then 'none' else 'set' end,
                    'new', case when (v_new ->> 'owner_note') is null then 'none' else 'set' end)
             else pg_catalog.jsonb_build_object('old', v_old -> n.key, 'new', n.value)
           end), '{}'::jsonb)
    into v_changes
  from pg_catalog.jsonb_each(v_new) as n
  where n.key not in ('id', 'updated_at', 'created_at', 'created_by', 'shop_id')
    and (v_old -> n.key) is distinct from n.value
    and not (tg_op = 'INSERT' and n.value = 'null'::jsonb);  -- a create logs only what was filled in

  if v_changes = '{}'::jsonb then
    return null;
  end if;

  if tg_table_name = 'assisted_shops' then
    v_shop_id := new.id;
    v_shop_name := v_new ->> 'business_name';
    v_action := case
      when tg_op = 'INSERT' then 'shop_created'
      when (v_old ->> 'status') = 'draft' and (v_new ->> 'status') = 'cancelled' then 'shop_cancelled'
      else 'shop_updated'
    end;
  else
    v_shop_id := (v_new ->> 'shop_id')::uuid;
    select s.business_name into v_shop_name from public.assisted_shops s where s.id = v_shop_id;
    v_action := case
      when tg_op = 'INSERT' then 'item_added'
      when (v_new ->> 'is_hidden')::boolean and not (v_old ->> 'is_hidden')::boolean then 'item_hidden'
      when (v_old ->> 'is_hidden')::boolean and not (v_new ->> 'is_hidden')::boolean then 'item_unhidden'
      else 'item_updated'
    end;
    v_changes := pg_catalog.jsonb_build_object('item_id', new.id, 'changes', v_changes);
  end if;

  if v_action = 'shop_cancelled' then
    v_changes := v_changes || pg_catalog.jsonb_build_object(
      'reason', nullif(pg_catalog.current_setting('kb.assisted_reason', true), ''));
  end if;

  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, action, details)
  values (auth.uid(), 'admin', v_shop_id, v_shop_name, v_action, v_changes);
  return null;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. THE CSV IMPORT. p_items: [{"name", "price", "category", "hidden", "note"}, ...]
-- in file order. Boss has already checked the file; this checks again.
-- ----------------------------------------------------------------------------
create or replace function public.admin_import_assisted_menu(p_shop_id uuid, p_items jsonb, p_replace_all boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.assisted_shops;
  v_n int;
  v_row record;
  v_name text;
  v_price_text text;
  v_category text;
  v_note text;
  v_key text;
  v_keys text[] := array[]::text[];
  v_existing_hidden int := 0;
  v_imported int := 0;
  v_hidden int := 0;
  v_skipped int := 0;
  v_counts jsonb;
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if p_replace_all is null then
    raise exception 'Choose whether to add to the draft or replace it.' using errcode = '22023';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'The import has no rows.' using errcode = '22023';
  end if;
  v_n := pg_catalog.jsonb_array_length(p_items);
  if v_n = 0 then
    raise exception 'The import has no rows.' using errcode = '22023';
  end if;
  if v_n > 200 then
    raise exception 'The import has % rows; the most is 200.', v_n using errcode = '22023';
  end if;

  select * into v_shop from public.assisted_shops s where s.id = p_shop_id for update;
  if not found then
    raise exception 'Shop not found.' using errcode = 'P0002';
  end if;
  if v_shop.status <> 'draft' then
    raise exception 'This shop has already been claimed or cancelled, so its draft menu can''t be changed.'
      using errcode = '42501';
  end if;

  -- Check every row first: nothing is written unless all of them are fine.
  for v_row in select e.value as item, e.ordinality as n from pg_catalog.jsonb_array_elements(p_items) with ordinality as e loop
    if pg_catalog.jsonb_typeof(v_row.item) <> 'object' then
      raise exception 'Row %: not an item.', v_row.n using errcode = '22023';
    end if;
    v_name := pg_catalog.btrim(coalesce(v_row.item ->> 'name', ''));
    if v_name = '' then
      raise exception 'Row %: the name is empty.', v_row.n using errcode = '22023';
    end if;
    if pg_catalog.char_length(v_name) > 80 then
      raise exception 'Row %: the name is longer than 80 characters.', v_row.n using errcode = '22023';
    end if;
    v_price_text := v_row.item ->> 'price';
    -- Two steps: the cast only runs on text the pattern already accepted.
    if v_price_text is null or v_price_text !~ '^[0-9]{1,4}(\.[0-9]{1,2})?$' then
      raise exception 'Row %: the price must be a number above 0 with at most 2 decimals, up to 9999.99.', v_row.n
        using errcode = '22023';
    end if;
    if v_price_text::numeric <= 0 then
      raise exception 'Row %: the price must be a number above 0 with at most 2 decimals, up to 9999.99.', v_row.n
        using errcode = '22023';
    end if;
    v_category := nullif(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(v_row.item ->> 'category', '')), '\s+', ' ', 'g'), '');
    if pg_catalog.char_length(v_category) > 60 then
      raise exception 'Row %: the category is longer than 60 characters.', v_row.n using errcode = '22023';
    end if;
    if (v_row.item -> 'hidden') is not null and pg_catalog.jsonb_typeof(v_row.item -> 'hidden') <> 'boolean' then
      raise exception 'Row %: hidden must be true or false.', v_row.n using errcode = '22023';
    end if;
    if (v_row.item -> 'note') is not null and pg_catalog.jsonb_typeof(v_row.item -> 'note') not in ('string', 'null') then
      raise exception 'Row %: the note must be text.', v_row.n using errcode = '22023';
    end if;
    v_note := nullif(pg_catalog.btrim(coalesce(v_row.item ->> 'note', '')), '');
    if pg_catalog.char_length(v_note) > 200 then
      raise exception 'Row %: the check-with-owner note is longer than 200 characters.', v_row.n using errcode = '22023';
    end if;
    if v_note is not null and not coalesce((v_row.item ->> 'hidden')::boolean, false) then
      raise exception 'Row %: a row with a check-with-owner note must be imported hidden.', v_row.n using errcode = '22023';
    end if;
    v_key := pg_catalog.lower(pg_catalog.regexp_replace(v_name, '\s+', ' ', 'g')) || pg_catalog.chr(31) || pg_catalog.lower(coalesce(v_category, ''));
    if v_key = any (v_keys) then
      raise exception 'Row %: the same name is already in this category earlier in the file.', v_row.n using errcode = '22023';
    end if;
    v_keys := pg_catalog.array_append(v_keys, v_key);
  end loop;

  -- The per-item audit rows are skipped; one summary row is written below.
  perform pg_catalog.set_config('kb_assist.bulk', 'on', true);

  if p_replace_all then
    update public.assisted_shop_items i set is_hidden = true
    where i.shop_id = p_shop_id and not i.is_hidden;
    get diagnostics v_existing_hidden = row_count;
  end if;

  with incoming as (
    select e.ordinality as n,
           pg_catalog.btrim(e.value ->> 'name') as name,
           (e.value ->> 'price')::numeric(6,2) as price,
           nullif(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(e.value ->> 'category', '')), '\s+', ' ', 'g'), '') as category,
           coalesce((e.value ->> 'hidden')::boolean, false) as hidden,
           nullif(pg_catalog.btrim(coalesce(e.value ->> 'note', '')), '') as note
    from pg_catalog.jsonb_array_elements(p_items) with ordinality as e
  ),
  fresh as (
    select inc.* from incoming inc
    where p_replace_all
       or not exists (
         select 1 from public.assisted_shop_items i
         where i.shop_id = p_shop_id
           and pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(i.name), '\s+', ' ', 'g'))
               = pg_catalog.lower(pg_catalog.regexp_replace(inc.name, '\s+', ' ', 'g'))
           and pg_catalog.lower(coalesce(i.category, '')) = pg_catalog.lower(coalesce(inc.category, ''))
       )
  ),
  added as (
    -- created_at a microsecond apart keeps the file order (the editor sorts by it).
    insert into public.assisted_shop_items (shop_id, name, price, photo_url, category, owner_note, is_hidden, created_at, updated_at)
    select p_shop_id, f.name, f.price, null, f.category, f.note, f.hidden,
           pg_catalog.now() + f.n * interval '1 microsecond', pg_catalog.now()
    from fresh f
    order by f.n
    returning is_hidden
  )
  select count(*)::int, count(*) filter (where is_hidden)::int into v_imported, v_hidden from added;

  v_skipped := v_n - v_imported;
  perform pg_catalog.set_config('kb_assist.bulk', '', true);

  v_counts := pg_catalog.jsonb_build_object(
    'imported', v_imported, 'hidden', v_hidden, 'skipped', v_skipped,
    'existing_hidden', v_existing_hidden, 'replace_all', p_replace_all);
  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, action, details)
  values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, 'menu_imported', v_counts);
  return v_counts;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. SET PHOTO FOR A CATEGORY. p_category null (or blank) = no category.
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_assisted_category_photo(
  p_shop_id uuid,
  p_category text,
  p_photo_url text,
  p_replace_existing boolean
)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.assisted_shops;
  v_category text := nullif(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_category, '')), '\s+', ' ', 'g'), '');
  v_photo text := nullif(pg_catalog.btrim(coalesce(p_photo_url, '')), '');
  v_in_category int;
  v_updated int;
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if p_replace_existing is null then
    raise exception 'Choose whether to replace photos that are already set.' using errcode = '22023';
  end if;
  if v_photo is null or pg_catalog.char_length(v_photo) > 2000 or v_photo !~ '^https?://[^[:space:]]+$' then
    raise exception 'The photo must be an uploaded photo or a web link starting with https://.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_category) > 60 then
    raise exception 'The category is longer than 60 characters.' using errcode = '22023';
  end if;

  select * into v_shop from public.assisted_shops s where s.id = p_shop_id for update;
  if not found then
    raise exception 'Shop not found.' using errcode = 'P0002';
  end if;
  if v_shop.status <> 'draft' then
    raise exception 'This shop has already been claimed or cancelled, so its draft menu can''t be changed.'
      using errcode = '42501';
  end if;

  select count(*)::int into v_in_category
  from public.assisted_shop_items i
  where i.shop_id = p_shop_id and pg_catalog.lower(coalesce(i.category, '')) = pg_catalog.lower(coalesce(v_category, ''));

  -- Hidden items included. The per-item audit rows are skipped; one summary row below.
  perform pg_catalog.set_config('kb_assist.bulk', 'on', true);
  update public.assisted_shop_items i
  set photo_url = v_photo
  where i.shop_id = p_shop_id
    and pg_catalog.lower(coalesce(i.category, '')) = pg_catalog.lower(coalesce(v_category, ''))
    and (p_replace_existing or i.photo_url is null)
    and i.photo_url is distinct from v_photo;
  get diagnostics v_updated = row_count;
  perform pg_catalog.set_config('kb_assist.bulk', '', true);

  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, action, details)
  values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, 'category_photo_set', pg_catalog.jsonb_build_object(
    'updated', v_updated, 'items_in_category', v_in_category, 'replace_existing', p_replace_existing));
  return v_updated;
end;
$$;

-- Same pattern as the other admin_* functions.
revoke all on function public.normalize_assisted_item_fields() from public, anon, authenticated, service_role;
revoke all on function public.audit_assisted_onboarding_row() from public, anon, authenticated, service_role;
revoke all on function public.admin_import_assisted_menu(uuid, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_assisted_category_photo(uuid, text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.admin_import_assisted_menu(uuid, jsonb, boolean) to authenticated;
grant execute on function public.admin_set_assisted_category_photo(uuid, text, text, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- 6. CHECKS AFTER. Otherwise roll back.
-- ----------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_msg text;
begin
  -- The claim, the kitchen guard, the terms trigger and the draft item guard are exactly as before.
  if md5(pg_get_functiondef('public.assisted_claim_complete(text, text, uuid, text, text)'::regprocedure)) <> current_setting('kb_menu.claim_md5') then
    raise exception 'Stopped: assisted_claim_complete changed';
  end if;
  if md5(pg_get_functiondef('public.guard_admin_kitchen_edit()'::regprocedure)) <> current_setting('kb_menu.guard_md5') then
    raise exception 'Stopped: guard_admin_kitchen_edit changed';
  end if;
  if md5(pg_get_functiondef('public.stamp_kitchen_terms_acknowledgement()'::regprocedure)) <> current_setting('kb_menu.terms_md5') then
    raise exception 'Stopped: stamp_kitchen_terms_acknowledgement changed';
  end if;
  if md5(pg_get_functiondef('public.guard_assisted_shop_item()'::regprocedure)) <> current_setting('kb_menu.item_guard_md5') then
    raise exception 'Stopped: guard_assisted_shop_item changed';
  end if;

  -- The column, its check and its grants.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'assisted_shop_items' and column_name = 'category'
                   and data_type = 'text' and is_nullable = 'YES') then
    raise exception 'Stopped: assisted_shop_items.category is missing or not nullable text';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assisted_shop_items_category_check') then
    raise exception 'Stopped: the category check is missing';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'assisted_shop_items' and column_name = 'owner_note'
                   and data_type = 'text' and is_nullable = 'YES')
     or not exists (select 1 from pg_constraint where conname = 'assisted_shop_items_owner_note_check') then
    raise exception 'Stopped: assisted_shop_items.owner_note or its check is missing';
  end if;
  if not (has_column_privilege('authenticated', 'public.assisted_shop_items', 'owner_note', 'select')
          and has_column_privilege('authenticated', 'public.assisted_shop_items', 'owner_note', 'insert')
          and has_column_privilege('authenticated', 'public.assisted_shop_items', 'owner_note', 'update'))
     or has_column_privilege('anon', 'public.assisted_shop_items', 'owner_note', 'select')
     or has_column_privilege('service_role', 'public.assisted_shop_items', 'owner_note', 'select') then
    raise exception 'Stopped: owner_note grants are wrong';
  end if;
  -- Not copied at claim and not in the claim preview (both functions unchanged).
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in ('assisted_claim_complete', 'assisted_claim_preview')
               and p.prosrc like '%owner_note%') then
    raise exception 'Stopped: a claim function mentions owner_note';
  end if;
  if not (has_column_privilege('authenticated', 'public.assisted_shop_items', 'category', 'select')
          and has_column_privilege('authenticated', 'public.assisted_shop_items', 'category', 'insert')
          and has_column_privilege('authenticated', 'public.assisted_shop_items', 'category', 'update'))
     or has_column_privilege('anon', 'public.assisted_shop_items', 'category', 'select') then
    raise exception 'Stopped: category grants are wrong';
  end if;

  -- The audit list and the trigger skip.
  if not exists (select 1 from pg_constraint c where c.conname = 'assisted_onboarding_audit_action_check'
                 and pg_get_constraintdef(c.oid) like '%menu_imported%' and pg_get_constraintdef(c.oid) like '%category_photo_set%') then
    raise exception 'Stopped: the audit actions menu_imported / category_photo_set are missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'audit_assisted_onboarding_row' and p.prosrc like '%kb_assist.bulk%') then
    raise exception 'Stopped: the audit trigger does not skip the bulk rows';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'audit_assisted_onboarding_row'
                   and p.prosrc like '%n.key = ''owner_note''%') then
    raise exception 'Stopped: the audit trigger does not hide the owner note';
  end if;

  -- Fixed, empty search_path; only signed-in users (the functions check admin) run the two admin functions.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('admin_import_assisted_menu', 'admin_set_assisted_category_photo',
                      'audit_assisted_onboarding_row', 'normalize_assisted_item_fields')
    and not coalesce('search_path=""' = any (p.proconfig), false);
  if v_bad is not null then
    raise exception 'Stopped: function(s) without search_path = '''': %', v_bad;
  end if;
  if not has_function_privilege('authenticated', 'public.admin_import_assisted_menu(uuid, jsonb, boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.admin_set_assisted_category_photo(uuid, text, text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.admin_import_assisted_menu(uuid, jsonb, boolean)', 'execute')
     or has_function_privilege('anon', 'public.admin_set_assisted_category_photo(uuid, text, text, boolean)', 'execute')
     or has_function_privilege('service_role', 'public.admin_import_assisted_menu(uuid, jsonb, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.audit_assisted_onboarding_row()', 'execute') then
    raise exception 'Stopped: function privileges are wrong';
  end if;

  -- Without an admin session both functions refuse (inner block: its own rollback point).
  v_msg := null;
  begin
    perform public.admin_set_assisted_category_photo(gen_random_uuid(), null, 'https://example.com/x.jpg', false);
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Not allowed%' then
    raise exception 'Stopped: admin_set_assisted_category_photo did not refuse a non-admin (%)', coalesce(v_msg, 'no error');
  end if;
  v_msg := null;
  begin
    perform public.admin_import_assisted_menu(gen_random_uuid(), '[]'::jsonb, false);
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Not allowed%' then
    raise exception 'Stopped: admin_import_assisted_menu did not refuse a non-admin (%)', coalesce(v_msg, 'no error');
  end if;

  if coalesce(current_setting('kb_assist.bulk', true), '') = 'on' then
    raise exception 'Stopped: kb_assist.bulk was left on';
  end if;
end;
$$;

commit;

select 'MENU IMPORT INSTALLED' as result;
