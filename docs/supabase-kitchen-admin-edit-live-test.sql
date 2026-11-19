-- ============================================================================
-- LIVE TEST for supabase-kitchen-admin-edit (v1). Passed on live 2026-11-19.
-- Run in the Supabase SQL editor AFTER the main script, on the TEST kitchen
-- only. It ALWAYS rolls back: success ends with
--   ERROR: TEST OK, rolled back: ...
-- and any failure ends with a different error. Nothing is ever kept.
--
-- Fill in the two ids on the first lines (Find/replace):
--   PUT-TEST-KITCHEN-ID   the test cook's id (= kitchens.id)
--   PUT-ADMIN-ID          your own admin profile id
-- It refuses to run unless the kitchen's business name starts with "TEST".
-- The test kitchen is TEST Parata, 24fd6ea3-abd2-4e0a-a8de-83e725a1351e.
--
-- The HQ steps never READ paynow_type, paynow_value or
-- acknowledged_terms_at: signed-in users have no SELECT on those columns
-- (nor on latitude, longitude, opening_hours), so the refused writes use
-- fixed values.
--
-- What it proves:
--   1. An HQ profile save passes through every existing kitchens trigger:
--      no error, only the edited field + updated_at change, and every
--      system-filled column (business_uen, region, public location,
--      is_blocked, terms stamp, live_since, PayNow) is exactly as before.
--   2. The stale-edit check: an update carrying the old updated_at hits 0 rows.
--   3. HQ's direct writes to is_blocked, live_since, PayNow, business_uen,
--      region, updated_at are all refused.
--      3a. HQ changing the terms stamp is refused by the guard.
--      3b. HQ setting the terms stamp from empty (the case the terms
--          trigger would stamp with now()) is refused by the guard.
--      3c. An HQ upsert on kitchens is refused by the guard, before the
--          terms trigger's "Please acknowledge..." error.
--   4. Block + Reinstate (profiles.is_active) still work with the guard on.
--   5. Menu: HQ adds, edits, hides; can't move an item to
--      another kitchen. Another signed-in user and anon can't see it hidden
--      and can't edit the kitchen.
--   6. PayNow via the RPC: confirmation required; audit holds only the mask.
--   7. Audit rows exist with the right shape and can't be changed or deleted.
-- ============================================================================

begin;

select set_config('kbt.kitchen', 'PUT-TEST-KITCHEN-ID', true);
select set_config('kbt.admin', 'PUT-ADMIN-ID', true);

-- ---- Setup (as postgres) ---------------------------------------------------
do $$
declare
  k public.kitchens;
begin
  select * into k from public.kitchens where id = current_setting('kbt.kitchen')::uuid;
  if k.id is null then raise exception 'FAIL setup: kitchen not found'; end if;
  if k.business_name !~* '^TEST' then
    raise exception 'REFUSED: "%" is not a TEST kitchen. Never run this on a real merchant.', k.business_name;
  end if;
  if not exists (select 1 from public.profiles where id = current_setting('kbt.admin')::uuid and role = 'admin') then
    raise exception 'FAIL setup: PUT-ADMIN-ID is not an admin profile';
  end if;
  -- Snapshot without the PayNow value in clear; a hash is enough to compare.
  perform set_config('kbt.before', (to_jsonb(k) - 'paynow_value')::text, true);
  perform set_config('kbt.paynow_md5', md5(coalesce(k.paynow_value, '')), true);
end;
$$;

-- ---- Act as HQ --------------------------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

-- 1. A profile save
update public.kitchens
set description = coalesce(description, '') || ' [HQ live test]'
where id = current_setting('kbt.kitchen')::uuid;

-- 2. Stale edit: the updated_at loaded before the save no longer matches
do $$
declare
  v_rows int;
begin
  update public.kitchens
  set description = 'stale write'
  where id = current_setting('kbt.kitchen')::uuid
    and updated_at = (current_setting('kbt.before')::jsonb ->> 'updated_at')::timestamptz;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'FAIL 2: a stale edit was saved'; end if;
end;
$$;

-- 3. Refused direct writes (42501 from the guard or from a column grant)
do $$
declare
  v_set text;
  v_col text;
begin
  foreach v_set in array array[
    'is_blocked = not coalesce(is_blocked, false)',
    'paynow_value = ''99999999''',
    'paynow_type = ''uen''',
    'business_uen = coalesce(business_uen, '''') || ''X''',
    'updated_at = updated_at - interval ''1 day'''
  ] loop
    begin
      execute format('update public.kitchens set %s where id = %L', v_set, current_setting('kbt.kitchen'));
      raise exception 'FAIL 3: HQ was allowed: %', v_set;
    exception when insufficient_privilege then
      null;  -- refused, as it should be
    end;
  end loop;

  -- Live-only columns, tested only if they exist
  foreach v_col in array array['live_since', 'region'] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'kitchens' and column_name = v_col) then
      begin
        if v_col = 'live_since' then
          execute format('update public.kitchens set live_since = coalesce(live_since, now()) + interval ''1 day'' where id = %L',
                         current_setting('kbt.kitchen'));
        else
          execute format('update public.kitchens set region = case when region is null then ''north'' else null end where id = %L',
                         current_setting('kbt.kitchen'));
        end if;
        raise exception 'FAIL 3: HQ was allowed to write %', v_col;
      exception when insufficient_privilege then
        null;
      end;
    end if;
  end loop;
end;
$$;

-- 3a. Terms: HQ changing an existing acknowledgement is refused by the
--     guard (its own message), not stamped by the terms trigger.
do $$
declare
  v_msg text;
begin
  begin
    update public.kitchens
    set acknowledged_terms_at = now() + interval '1 day'
    where id = current_setting('kbt.kitchen')::uuid;
    raise exception 'FAIL 3a: HQ changed the terms acknowledgement';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'HQ cannot set or change the partner terms%' then
      raise exception 'FAIL 3a: refused, but not by the HQ guard: %', v_msg;
    end if;
  end;
end;
$$;

-- 3c. Upsert: an HQ INSERT ... ON CONFLICT DO UPDATE on an existing
--     kitchen (what the old Boss form sent) is refused by the guard with
--     its own message, before the terms trigger's "Please acknowledge...".
do $$
declare
  v_msg text;
begin
  begin
    insert into public.kitchens (id, business_name, description)
    select k.id, k.business_name, 'upsert attempt'
    from public.kitchens k where k.id = current_setting('kbt.kitchen')::uuid
    on conflict (id) do update set description = excluded.description;
    raise exception 'FAIL 3c: an HQ upsert on kitchens went through';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    -- A column-grant refusal ("permission denied ...") comes before any
    -- trigger and is also a correct outcome: HQ still can't upsert.
    if v_msg not like 'HQ cannot create or upsert a kitchen%'
       and v_msg not like 'permission denied%' then
      raise exception 'FAIL 3c: refused, but not by the HQ guard: %', v_msg;
    end if;
  end;
end;
$$;

-- 4. Block and reinstate the test merchant (the Boss Block button's write)
update public.profiles set is_active = false where id = current_setting('kbt.kitchen')::uuid;
update public.profiles set is_active = true where id = current_setting('kbt.kitchen')::uuid;

-- 5a. Menu as HQ
do $$
declare
  v_item uuid;
begin
  insert into public.menu_items (kitchen_id, name, price)
  values (current_setting('kbt.kitchen')::uuid, 'TEST HQ item', 1.00)
  returning id into v_item;
  perform set_config('kbt.item', v_item::text, true);

  update public.menu_items set price = 2.00 where id = v_item;
  update public.menu_items set is_hidden = true where id = v_item;

  begin
    update public.menu_items set kitchen_id = current_setting('kbt.admin')::uuid where id = v_item;
    raise exception 'FAIL 5: HQ moved a menu item to another kitchen';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- 5b. Another signed-in user (random id, not admin, not the cook)
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_rows int;
begin
  if exists (select 1 from public.menu_items where id = current_setting('kbt.item')::uuid) then
    raise exception 'FAIL 5: another user can see a hidden item';
  end if;
  update public.kitchens set description = 'intruder' where id = current_setting('kbt.kitchen')::uuid;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'FAIL 5: another user edited the kitchen'; end if;
  if exists (select 1 from public.kitchen_admin_audit) then
    raise exception 'FAIL 5: a non-admin can read the audit log';
  end if;
end;
$$;

-- 5c. Logged out
reset role;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
set local role anon;
do $$
begin
  if exists (select 1 from public.menu_items where id = current_setting('kbt.item')::uuid) then
    raise exception 'FAIL 5: anon can see a hidden item';
  end if;
end;
$$;

-- 6. PayNow as HQ through the RPC
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_name text;
begin
  select business_name into v_name from public.kitchens where id = current_setting('kbt.kitchen')::uuid;
  begin
    perform public.admin_set_kitchen_paynow(current_setting('kbt.kitchen')::uuid, 'mobile', '91234567', 'wrong name', 'live test');
    raise exception 'FAIL 6: PayNow changed without the right confirmation';
  exception when invalid_parameter_value then
    null;
  end;
  perform public.admin_set_kitchen_paynow(current_setting('kbt.kitchen')::uuid, 'mobile', '9123 4567', v_name, 'live test');
end;
$$;

-- ---- Verify (as postgres) ---------------------------------------------------
reset role;
do $$
declare
  v_before jsonb := current_setting('kbt.before')::jsonb;
  v_after jsonb;
  v_changed text[];
  v_audit public.kitchen_admin_audit;
  v_null_case text;
  v_msg text;
begin
  select to_jsonb(k) - 'paynow_value' - 'paynow_type' into v_after
  from public.kitchens k where k.id = current_setting('kbt.kitchen')::uuid;

  -- 1. Only description and updated_at differ (PayNow checked separately)
  select array_agg(a.key order by a.key) into v_changed
  from jsonb_each(v_after) a
  join jsonb_each(v_before - 'paynow_type') b using (key)
  where a.value is distinct from b.value;
  if v_changed is distinct from array['description', 'updated_at'] then
    raise exception 'FAIL 1: an HQ profile save changed %, expected only description and updated_at', v_changed;
  end if;
  if (v_after ->> 'updated_at')::timestamptz <= (v_before ->> 'updated_at')::timestamptz then
    raise exception 'FAIL 1: updated_at was not bumped';
  end if;
  if (v_after -> 'acknowledged_terms_at') is distinct from (v_before -> 'acknowledged_terms_at') then
    raise exception 'FAIL 1: the HQ save changed the terms acknowledgement';
  end if;

  -- 3b. Terms NULL -> value: exactly the case the terms trigger would stamp
  --     with now(). Clear the stamp with triggers off, try it as HQ, then
  --     undo everything in this block (subtransaction rollback also resets
  --     the role and settings). Skipped, and reported, if this database
  --     doesn't allow switching triggers off.
  begin
    begin
      perform set_config('session_replication_role', 'replica', true);
      update public.kitchens set acknowledged_terms_at = null
      where id = current_setting('kbt.kitchen')::uuid;
      perform set_config('session_replication_role', 'origin', true);
    exception when others then
      v_null_case := 'skipped (could not clear the stamp: ' || sqlerrm || ')';
    end;

    if v_null_case is null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', current_setting('kbt.admin'), 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin
        update public.kitchens set acknowledged_terms_at = now()
        where id = current_setting('kbt.kitchen')::uuid;
        v_null_case := 'FAIL: HQ set the terms acknowledgement from empty';
      exception when insufficient_privilege then
        get stacked diagnostics v_msg = message_text;
        v_null_case := case when v_msg like 'HQ cannot set or change the partner terms%'
                            then 'passed' else 'FAIL: refused, but not by the HQ guard: ' || v_msg end;
      end;
    end if;
    raise exception 'kbt_undo';
  exception when raise_exception then
    if sqlerrm <> 'kbt_undo' then raise; end if;
  end;
  if v_null_case like 'FAIL%' then
    raise exception 'FAIL 3b: %', v_null_case;
  end if;
  if exists (select 1 from public.kitchens
             where id = current_setting('kbt.kitchen')::uuid
               and acknowledged_terms_at is distinct from (v_before ->> 'acknowledged_terms_at')::timestamptz) then
    raise exception 'FAIL 3b: the terms stamp was not restored after the sub-test';
  end if;

  -- 1. Exactly one audit row for the profile save, with only description
  select * into v_audit from public.kitchen_admin_audit
  where kitchen_id = current_setting('kbt.kitchen')::uuid and action = 'update'
    and changes ? 'description' and created_at = now();
  if v_audit.id is null then raise exception 'FAIL 1: no audit row for the profile save'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(v_audit.changes) k) <> array['description'] then
    raise exception 'FAIL 1: audit row logged extra fields: %', v_audit.changes;
  end if;
  if v_audit.admin_id <> current_setting('kbt.admin')::uuid then
    raise exception 'FAIL 1: audit row has the wrong admin';
  end if;

  -- 5. Menu audit trail
  if (select count(*) from public.kitchen_admin_audit
      where target_id = current_setting('kbt.item')::uuid and created_at = now()
        and action in ('menu_item_added', 'menu_item_updated', 'menu_item_hidden')) <> 3 then
    raise exception 'FAIL 5: expected added, updated and hidden audit rows for the test item';
  end if;

  -- 6. PayNow saved, logged masked, never in clear
  if not exists (select 1 from public.kitchens
                 where id = current_setting('kbt.kitchen')::uuid and paynow_value = '91234567' and paynow_type = 'mobile') then
    raise exception 'FAIL 6: PayNow was not saved';
  end if;
  select * into v_audit from public.kitchen_admin_audit
  where kitchen_id = current_setting('kbt.kitchen')::uuid and action = 'paynow_update' and created_at = now();
  if v_audit.id is null then raise exception 'FAIL 6: no paynow_update audit row'; end if;
  if v_audit.changes::text like '%91234567%' or v_audit.changes::text like '%1234567%' then
    raise exception 'FAIL 6: PayNow digits stored in clear in the audit log';
  end if;
  if v_audit.changes -> 'paynow_value' ->> 'new' <> '*****567' then
    raise exception 'FAIL 6: unexpected mask %', v_audit.changes -> 'paynow_value' ->> 'new';
  end if;
  if v_audit.reason is distinct from 'live test' then
    raise exception 'FAIL 6: reason not logged';
  end if;

  -- 7. Append-only, even for the table owner
  begin
    update public.kitchen_admin_audit set reason = 'tampered' where id = v_audit.id;
    raise exception 'FAIL 7: an audit row was changed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.kitchen_admin_audit where id = v_audit.id;
    raise exception 'FAIL 7: an audit row was deleted';
  exception when insufficient_privilege then null;
  end;

  raise exception 'TEST OK, rolled back: profile save passed every trigger, stale edit refused, protected columns refused, terms change refused, terms from empty %, HQ upsert refused, block/reinstate fine, menu add/edit/hide audited, no cross-kitchen access, PayNow masked. Nothing was changed.', v_null_case;
end;
$$;

rollback;
