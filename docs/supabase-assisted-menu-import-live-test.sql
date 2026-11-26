-- ============================================================================
-- LIVE TEST for supabase-assisted-menu-import. ALWAYS ROLLS BACK.
-- Run in the Supabase SQL editor AFTER docs/supabase-assisted-menu-import.sql,
-- as ONE script. Success ends with
--   ERROR: TEST OK, rolled back: ...
-- and any failure ends with a different error. Nothing is ever kept: no
-- draft, item or audit row.
--
-- Fill in ONE value (Find/replace):
--   PUT-ADMIN-ID   your own admin profile id
-- It makes its own throw-away draft "TEST Menu Import Live Test" with the
-- owner mobile 89999996, and refuses to run if that number already has an
-- open draft. No real merchant, draft or kitchen is read or changed.
--
-- What it proves (signed in as HQ, through the real functions):
--   1. The category is trimmed (inner spaces collapsed); over 60 is refused.
--   2. Import: hidden rows, categories and file order kept; ONE
--      'menu_imported' audit row with counts only and NO item_added rows.
--   3. Import again: rows already in the draft (visible or hidden, case and
--      extra spaces ignored) are skipped and counted.
--   4. Bad rows are refused and nothing is written: a bad price, a duplicate
--      in the file.
--   5. Replace all: every visible item is hidden (none deleted), the file is
--      added in full.
--   6. Category photo: only items with no photo (hidden ones too), then with
--      replace; other categories untouched; ONE 'category_photo_set' row
--      and NO item_updated rows.
--   7. An ordinary single-item edit is still audited one row per item.
--   8. A cancelled draft refuses both functions. (A claimed draft hits the
--      same check; the PGlite test claims one for real.)
-- ============================================================================

begin;

select set_config('kbt.admin', 'PUT-ADMIN-ID', true);

do $$
begin
  if current_setting('kbt.admin') like 'PUT-%' then
    raise exception 'REFUSED: fill in PUT-ADMIN-ID first';
  end if;
  if not exists (select 1 from public.profiles where id = current_setting('kbt.admin')::uuid and role = 'admin') then
    raise exception 'FAIL setup: PUT-ADMIN-ID is not an admin profile';
  end if;
  if exists (select 1 from public.assisted_shops where status = 'draft' and owner_mobile = '89999996') then
    raise exception 'REFUSED: a real open draft uses the test mobile number 89999996';
  end if;
end;
$$;

-- ---- Act as HQ ---------------------------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_shop uuid;
  v_item uuid;
  v_counts jsonb;
  v_n int;
  v_names text;
  v_msg text;
begin
  insert into public.assisted_shops
    (business_name, category, cuisine_type, is_halal, owner_name, owner_mobile, business_address, postal_code)
  values
    ('TEST Menu Import Live Test', 'home-cook', 'chinese', false, 'KB Menu Test Owner', '89999996', 'Blk 2 Test Lane', '310124')
  returning id into v_shop;

  -- 1. The category column, through HQ's own insert.
  insert into public.assisted_shop_items (shop_id, name, price, category)
  values (v_shop, 'Kopi O', 1.50, '  Hot   Drinks ')
  returning id into v_item;
  if (select category from public.assisted_shop_items where id = v_item) <> 'Hot Drinks' then
    raise exception 'FAIL 1: category not trimmed: %', (select category from public.assisted_shop_items where id = v_item);
  end if;
  begin
    insert into public.assisted_shop_items (shop_id, name, price, category) values (v_shop, 'x', 1, repeat('c', 61));
    raise exception 'FAIL 1: a 61-character category was accepted';
  exception when check_violation then null;
  end;

  -- 2. Import: three rows, one hidden (check_with_owner filled in Boss).
  v_counts := public.admin_import_assisted_menu(v_shop, '[
    {"name": "Kaya Toast", "price": "2.20", "category": "Breakfast", "hidden": false},
    {"name": "Teh Tarik", "price": "1.80", "category": "hot drinks", "hidden": true},
    {"name": "Soft-boiled Eggs", "price": "1.60", "category": "Breakfast", "hidden": false}
  ]'::jsonb, false);
  if v_counts ->> 'imported' <> '3' or v_counts ->> 'hidden' <> '1' or v_counts ->> 'skipped' <> '0' then
    raise exception 'FAIL 2: counts %', v_counts;
  end if;
  select string_agg(name || ':' || coalesce(category, '-') || ':' || is_hidden, ', ' order by created_at, id) into v_names
  from public.assisted_shop_items where shop_id = v_shop and name <> 'Kopi O';
  if v_names <> 'Kaya Toast:Breakfast:false, Teh Tarik:hot drinks:true, Soft-boiled Eggs:Breakfast:false' then
    raise exception 'FAIL 2: rows or order wrong: %', v_names;
  end if;
  select count(*) into v_n from public.assisted_onboarding_audit where shop_id = v_shop and action = 'menu_imported';
  if v_n <> 1 then raise exception 'FAIL 2: % menu_imported rows', v_n; end if;
  select count(*) into v_n from public.assisted_onboarding_audit where shop_id = v_shop and action = 'item_added';
  if v_n <> 1 then raise exception 'FAIL 2: the import wrote item_added rows (% in total, 1 expected: Kopi O)', v_n; end if;
  if exists (select 1 from public.assisted_onboarding_audit where shop_id = v_shop and action = 'menu_imported'
             and (details::text like '%Kaya%' or details::text like '%Breakfast%')) then
    raise exception 'FAIL 2: the audit row holds menu text';
  end if;

  -- 3. Again: two already there (one hidden, different case and spaces), one new.
  v_counts := public.admin_import_assisted_menu(v_shop, '[
    {"name": "kaya  toast", "price": "2.20", "category": "BREAKFAST"},
    {"name": "Teh Tarik", "price": "1.80", "category": "Hot Drinks"},
    {"name": "Milo Dinosaur", "price": "3.00", "category": "Cold Drinks"}
  ]'::jsonb, false);
  if v_counts ->> 'imported' <> '1' or v_counts ->> 'skipped' <> '2' then
    raise exception 'FAIL 3: counts %', v_counts;
  end if;

  -- 4. Bad rows: refused, nothing written.
  select count(*) into v_n from public.assisted_shop_items where shop_id = v_shop;
  v_msg := null;
  begin
    perform public.admin_import_assisted_menu(v_shop, '[{"name": "A", "price": "1.00"}, {"name": "B", "price": "4.555"}]'::jsonb, false);
  exception when invalid_parameter_value then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Row 2:%' then raise exception 'FAIL 4: bad price not refused (%)', coalesce(v_msg, 'no error'); end if;
  v_msg := null;
  begin
    perform public.admin_import_assisted_menu(v_shop, '[{"name": "Laksa", "price": "6"}, {"name": " LAKSA ", "price": "7"}]'::jsonb, false);
  exception when invalid_parameter_value then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Row 2:%' then raise exception 'FAIL 4: duplicate not refused (%)', coalesce(v_msg, 'no error'); end if;
  if (select count(*) from public.assisted_shop_items where shop_id = v_shop) <> v_n then
    raise exception 'FAIL 4: a refused import wrote rows';
  end if;

  -- 5. Replace all: 4 visible items hidden, none deleted, 2 added.
  v_counts := public.admin_import_assisted_menu(v_shop, '[
    {"name": "Kaya Toast", "price": "2.50", "category": "Breakfast"},
    {"name": "Nasi Lemak", "price": "4.00", "category": "Rice"}
  ]'::jsonb, true);
  if v_counts ->> 'existing_hidden' <> '4' or v_counts ->> 'imported' <> '2' then
    raise exception 'FAIL 5: counts %', v_counts;
  end if;
  if (select count(*) from public.assisted_shop_items where shop_id = v_shop) <> v_n + 2
     or (select count(*) from public.assisted_shop_items where shop_id = v_shop and not is_hidden) <> 2 then
    raise exception 'FAIL 5: replace all deleted rows or left old ones visible';
  end if;

  -- 6. Category photo: Breakfast has 3 items (two hidden now), none with a photo.
  update public.assisted_shop_items set photo_url = 'https://example.com/own.jpg'
  where shop_id = v_shop and name = 'Soft-boiled Eggs';
  select count(*) into v_n from public.assisted_onboarding_audit where shop_id = v_shop and action = 'item_updated';
  if v_n <> 1 then raise exception 'FAIL 7: a single edit was not audited (% item_updated rows)', v_n; end if;

  if public.admin_set_assisted_category_photo(v_shop, ' breakfast ', 'https://example.com/breakfast.jpg', false) <> 2 then
    raise exception 'FAIL 6: expected 2 items without a photo updated';
  end if;
  if (select photo_url from public.assisted_shop_items where shop_id = v_shop and name = 'Soft-boiled Eggs') <> 'https://example.com/own.jpg' then
    raise exception 'FAIL 6: an existing photo was replaced without replace_existing';
  end if;
  if public.admin_set_assisted_category_photo(v_shop, 'Breakfast', 'https://example.com/breakfast.jpg', true) <> 1 then
    raise exception 'FAIL 6: replace_existing should change only the one item with a different photo';
  end if;
  if exists (select 1 from public.assisted_shop_items where shop_id = v_shop and coalesce(category, '') <> 'Breakfast' and photo_url is not null) then
    raise exception 'FAIL 6: another category was changed';
  end if;
  select count(*) into v_n from public.assisted_onboarding_audit where shop_id = v_shop and action = 'category_photo_set';
  if v_n <> 2 then raise exception 'FAIL 6: % category_photo_set rows (2 expected)', v_n; end if;
  select count(*) into v_n from public.assisted_onboarding_audit where shop_id = v_shop and action = 'item_updated';
  if v_n <> 1 then raise exception 'FAIL 6: the category photo wrote item_updated rows'; end if;
  begin
    perform public.admin_set_assisted_category_photo(v_shop, 'Breakfast', 'javascript:alert(1)', false);
    raise exception 'FAIL 6: a bad link was accepted';
  exception when invalid_parameter_value then null;
  end;

  if coalesce(current_setting('kb_assist.bulk', true), '') = 'on' then
    raise exception 'FAIL: kb_assist.bulk was left on';
  end if;

  -- 8. Cancelled: both refused.
  perform public.admin_cancel_assisted_shop(v_shop, 'menu import live test');
  begin
    perform public.admin_import_assisted_menu(v_shop, '[{"name": "Late", "price": "1"}]'::jsonb, false);
    raise exception 'FAIL 8: import into a cancelled shop';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_set_assisted_category_photo(v_shop, null, 'https://example.com/x.jpg', false);
    raise exception 'FAIL 8: category photo on a cancelled shop';
  exception when insufficient_privilege then null;
  end;

  raise exception 'TEST OK, rolled back: category trimmed and capped, import kept order and hidden rows with one summary audit row, duplicates skipped, bad rows refused, replace all hid without deleting, category photo filled only empty photos (hidden too) with one summary row, single edits still audited, cancelled draft refused. Nothing was saved.';
end;
$$;

rollback;
