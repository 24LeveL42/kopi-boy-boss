-- ============================================================================
-- KOPI BOY — Boss: HQ edits a merchant's kitchen and menu (v1)
-- Rev 5, reviewed, installed on live 2026-11-19. Live test:
-- docs/supabase-kitchen-admin-edit-live-test.sql (passed on TEST Parata).
-- PGlite test: src/lib/kitchen-admin-sql.test.ts.
-- rev 5: comments only. Section 5 now says the Boss screen offers hide,
-- not delete, and that the existing live HQ delete on menu_items (used by
-- "Delete test partner") is left unchanged. No SQL statement changed.
-- rev 4: go-live check in guard_admin_kitchen_edit is null-safe
-- (coalesce(new.is_live, false) and not coalesce(old.is_live, false)).
-- rev 3: guard also refuses HQ INSERT/upsert on kitchens; refuses any HQ
-- change to acknowledged_terms_at with its own message; section 8 also
-- checks INSERT triggers and that the terms trigger fires after the guard.
--
-- Runs as one transaction: if any check below fails, nothing is changed.
-- Safe to re-run.
--
-- Does NOT drop, replace or alter any existing policy or trigger. Hiding
-- menu items uses new RESTRICTIVE policies, so the live "anyone can read a
-- live kitchen's menu" policy stays exactly as it is, whatever its name and
-- text.
--
-- Does NOT touch: merchant_subscriptions, subscription_*, billing_settings,
-- founding numbers, ratings, orders, order_items, profiles,
-- cook_applications, kitchen_addresses.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. CHECKS BEFORE ANYTHING CHANGES
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_unexpected text;
begin
  select string_agg(c, ', ') into v_missing
  from unnest(array[
    'is_live', 'is_blocked', 'acknowledged_terms_at', 'updated_at', 'paynow_type', 'paynow_value'
  ]) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'kitchens' and column_name = c
  );
  if v_missing is not null then
    raise exception 'Stopped: public.kitchens has no column(s) %', v_missing;
  end if;

  -- The stale-edit check in Boss relies on kitchens.updated_at being bumped
  -- on every update by the existing touch_kitchen_updated_at trigger.
  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.kitchens'::regclass and not t.tgisinternal
      and p.proname = 'touch_kitchen_updated_at'
  ) then
    raise exception 'Stopped: no touch_kitchen_updated_at trigger on kitchens';
  end if;

  -- menu_items has no triggers today; only the ones this script adds are allowed.
  select string_agg(t.tgname, ', ') into v_unexpected
  from pg_trigger t
  where t.tgrelid = 'public.menu_items'::regclass and not t.tgisinternal
    and t.tgname not in ('a_menu_item_admin_guard', 'before_menu_item_update', 'z_menu_item_admin_audit');
  if v_unexpected is not null then
    raise exception 'Stopped: menu_items has triggers this script does not expect: %', v_unexpected;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. NEW COLUMNS
-- opening_hours: null = not set. Singapore time, 24h "HH:MM":
--   {"mon": [{"open": "07:00", "close": "14:00"}], "tue": [], ...}
-- Missing day or [] = closed. Up to 3 slots a day; close after open on the
-- same day (a supper slot past midnight is two slots on two days).
-- ----------------------------------------------------------------------------
alter table public.kitchens add column if not exists opening_hours jsonb;

create or replace function public.valid_opening_hours(h jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select h is null or (
    jsonb_typeof(h) = 'object'
    and not exists (
      select 1
      from jsonb_each(h) as d(day, slots)
      where case
        when d.day not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then true
        when jsonb_typeof(d.slots) <> 'array' then true
        when jsonb_array_length(d.slots) > 3 then true
        else exists (
          select 1
          from jsonb_array_elements(d.slots) as s(slot)
          where case
            when jsonb_typeof(s.slot) <> 'object' then true
            when coalesce(s.slot ->> 'open', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then true
            when coalesce(s.slot ->> 'close', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then true
            else (s.slot ->> 'open') >= (s.slot ->> 'close')
          end
        )
      end
    )
  );
$$;

alter table public.kitchens drop constraint if exists kitchens_opening_hours_check;
alter table public.kitchens add constraint kitchens_opening_hours_check
  check (public.valid_opening_hours(opening_hours));

alter table public.menu_items add column if not exists is_hidden boolean not null default false;
alter table public.menu_items add column if not exists updated_at timestamptz not null default now();


-- ----------------------------------------------------------------------------
-- 2. AUDIT LOG (append-only, written only by the triggers below)
-- No foreign keys on purpose: the log outlives a deleted test merchant and
-- never blocks "Delete test partner".
-- ----------------------------------------------------------------------------
create table if not exists public.kitchen_admin_audit (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  admin_id uuid not null,
  kitchen_id uuid not null,
  kitchen_name text,
  target_table text not null check (target_table in ('kitchens', 'menu_items')),
  target_id uuid not null,
  action text not null check (action in (
    'update', 'paynow_update',
    'menu_item_added', 'menu_item_updated', 'menu_item_hidden', 'menu_item_unhidden'
  )),
  changes jsonb not null,   -- {"field": {"old": ..., "new": ...}}; PayNow masked
  reason text
);

create index if not exists kitchen_admin_audit_kitchen_idx
  on public.kitchen_admin_audit (kitchen_id, created_at desc);

alter table public.kitchen_admin_audit enable row level security;

revoke all on public.kitchen_admin_audit from public, anon, authenticated;
grant select on public.kitchen_admin_audit to authenticated;

drop policy if exists "Admins read the kitchen audit log" on public.kitchen_admin_audit;
create policy "Admins read the kitchen audit log"
  on public.kitchen_admin_audit for select
  to authenticated
  using (public.user_has_role('admin'));

create or replace function public.kitchen_admin_audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'kitchen_admin_audit is append-only: % is not allowed', tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists kitchen_admin_audit_append_only on public.kitchen_admin_audit;
create trigger kitchen_admin_audit_append_only
  before update or delete on public.kitchen_admin_audit
  for each row execute function public.kitchen_admin_audit_append_only();

drop trigger if exists kitchen_admin_audit_no_truncate on public.kitchen_admin_audit;
create trigger kitchen_admin_audit_no_truncate
  before truncate on public.kitchen_admin_audit
  for each statement execute function public.kitchen_admin_audit_append_only();


-- ----------------------------------------------------------------------------
-- 3. HELPERS
-- ----------------------------------------------------------------------------
create or replace function public.mask_paynow(v text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when v is null then null
    when length(v) <= 3 then repeat('*', length(v))
    else repeat('*', length(v) - 3) || right(v, 3)
  end;
$$;

-- True when HQ (not the kitchen's own cook) is the signed-in caller.
create or replace function public.is_admin_editing_kitchen(p_kitchen_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and auth.uid() is distinct from p_kitchen_id
     and public.user_has_role('admin');
$$;

revoke all on function public.mask_paynow(text) from public, anon, authenticated;
revoke all on function public.is_admin_editing_kitchen(uuid) from public, anon;
grant execute on function public.is_admin_editing_kitchen(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. KITCHENS
-- Guard: a_kitchen_admin_guard, BEFORE INSERT OR UPDATE. "a_" sorts before
-- every existing BEFORE trigger (business_uen, region, public location,
-- is_blocked, terms stamp, live_since, updated_at), so it sees exactly what
-- HQ submitted, before any system trigger fills a column in. Section 8
-- refuses to commit if any BEFORE INSERT or BEFORE UPDATE trigger would
-- fire earlier.
--
-- Terms: the live stamp_kitchen_terms_acknowledgement() stamps now() on any
-- UPDATE that moves acknowledged_terms_at from NULL to a value. If HQ could
-- send that column, HQ would be giving consent for the cook. So the guard
-- refuses ANY HQ change to acknowledged_terms_at, with its own message, and
-- fires before the terms trigger can stamp anything.
--
-- INSERT / upsert: HQ never creates a kitchen row in v1. An upsert is an
-- INSERT first (BEFORE INSERT triggers fire even when the row exists and it
-- ends up as an update), which is why the old Boss form hit "Please
-- acknowledge the Kopi Boy partner terms...". The guard now refuses any HQ
-- INSERT on kitchens with a clear message, before the terms trigger runs.
-- (HQ also has no INSERT policy on kitchens, so RLS refuses it anyway.)
--
-- It only judges direct writes from the app: PostgREST runs those as
-- "authenticated". Writes made inside SECURITY DEFINER functions run as the
-- function's owner and pass straight through (approval's business_uen sync,
-- the is_blocked path, admin_set_kitchen_paynow), so it never gets in the
-- way of a system trigger or a vetted function. That is why the guard is
-- SECURITY INVOKER: current_user must be the caller's role.
--
-- Audit: z_kitchen_admin_audit, AFTER UPDATE, so it records the final row
-- after every BEFORE trigger has run.
-- ----------------------------------------------------------------------------
drop policy if exists "Admins can update every kitchen" on public.kitchens;
create policy "Admins can update every kitchen"
  on public.kitchens for update
  to authenticated
  using (public.user_has_role('admin'))
  with check (public.user_has_role('admin'));

create or replace function public.guard_admin_kitchen_edit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- The ONLY columns HQ may write directly. Everything else is refused:
  -- is_blocked (owned by set_kitchen_is_blocked), acknowledged_terms_at,
  -- live_since, paynow_*, business_uen, region, postal_sector, latitude,
  -- longitude, updated_at, id, created_at, and any column added later.
  v_allowed constant text[] := array[
    'business_name', 'category', 'cuisine_type', 'is_halal',
    'description', 'hero_image', 'is_live', 'opening_hours'
  ];
  v_bad text[];
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if public.is_admin_editing_kitchen(new.id) then
      raise exception 'HQ cannot create or upsert a kitchen. Edit an existing kitchen with an update.'
        using errcode = '42501';
    end if;
    return new;  -- the cook creating their own kitchen: unchanged
  end if;

  if not public.is_admin_editing_kitchen(old.id) then
    return new;  -- the cook editing their own kitchen: unchanged
  end if;

  -- Checked on its own, first, so the message is unmistakable.
  if new.acknowledged_terms_at is distinct from old.acknowledged_terms_at then
    raise exception 'HQ cannot set or change the partner terms acknowledgement. Only the cook can accept the terms, in the Partner app.'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(n.key order by n.key), '{}')
    into v_bad
  from jsonb_each(to_jsonb(new)) as n
  join jsonb_each(to_jsonb(old)) as o using (key)
  where n.value is distinct from o.value
    and n.key <> all (v_allowed);

  if cardinality(v_bad) > 0 then
    raise exception 'HQ cannot change % on a kitchen', array_to_string(v_bad, ', ')
      using errcode = '42501';
  end if;

  -- HQ may take a kitchen off the marketplace; putting one on needs the
  -- parts only the cook can do, and the kitchen must not be blocked.
  if coalesce(new.is_live, false) and not coalesce(old.is_live, false) then
    if coalesce(old.is_blocked, false) then
      raise exception 'This kitchen is blocked. Reinstate the merchant before putting it live.'
        using errcode = '23514';
    end if;
    if old.acknowledged_terms_at is null then
      raise exception 'This kitchen can''t go live until the cook accepts the partner terms in the Partner app.'
        using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.kitchen_addresses a
      where a.kitchen_id = new.id and a.postal_code is not null
    ) then
      raise exception 'This kitchen can''t go live until the cook has saved a pickup address.'
        using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.menu_items m
      where m.kitchen_id = new.id and not m.is_hidden
    ) then
      raise exception 'This kitchen can''t go live without at least one visible menu item.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists a_kitchen_admin_guard on public.kitchens;
create trigger a_kitchen_admin_guard
  before insert or update on public.kitchens
  for each row execute function public.guard_admin_kitchen_edit();

create or replace function public.audit_admin_kitchen_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb;
begin
  if not public.is_admin_editing_kitchen(new.id) then
    return null;
  end if;

  select coalesce(jsonb_object_agg(
           n.key,
           case when n.key = 'paynow_value'
             then jsonb_build_object(
                    'old', public.mask_paynow(o.value #>> '{}'),
                    'new', public.mask_paynow(n.value #>> '{}'))
             else jsonb_build_object('old', o.value, 'new', n.value)
           end), '{}'::jsonb)
    into v_changes
  from jsonb_each(to_jsonb(new)) as n
  join jsonb_each(to_jsonb(old)) as o using (key)
  where n.value is distinct from o.value
    and n.key <> 'updated_at';

  if v_changes = '{}'::jsonb then
    return null;
  end if;

  insert into public.kitchen_admin_audit
    (admin_id, kitchen_id, kitchen_name, target_table, target_id, action, changes, reason)
  values (
    auth.uid(), new.id, new.business_name, 'kitchens', new.id,
    case when v_changes ?| array['paynow_type', 'paynow_value'] then 'paynow_update' else 'update' end,
    v_changes,
    nullif(current_setting('kb.admin_edit_reason', true), '')
  );
  return null;
end;
$$;

drop trigger if exists z_kitchen_admin_audit on public.kitchens;
create trigger z_kitchen_admin_audit
  after update on public.kitchens
  for each row execute function public.audit_admin_kitchen_edit();

revoke all on function public.guard_admin_kitchen_edit() from public, anon, authenticated;
revoke all on function public.audit_admin_kitchen_edit() from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. MENU ITEMS
-- Admin read/add/update. The Boss screen offers hide, not delete. A
-- database delete for HQ already exists on live (used by "Delete test
-- partner"); this script doesn't add, change or drop it.
-- Hidden items: two RESTRICTIVE select policies, ANDed with every existing
-- permissive one. Customers (anon or signed in) never see a hidden item;
-- the owning cook and HQ still do. The Customer app's checkout re-reads
-- menu_items, gets no row, and already says the item is no longer available.
-- Triggers: a_menu_item_admin_guard (BEFORE, first), before_menu_item_update
-- (BEFORE UPDATE, the updated_at touch), z_menu_item_admin_audit (AFTER).
-- ----------------------------------------------------------------------------
drop policy if exists "Admins can read every menu item" on public.menu_items;
create policy "Admins can read every menu item"
  on public.menu_items for select
  to authenticated
  using (public.user_has_role('admin'));

drop policy if exists "Admins can add menu items to any kitchen" on public.menu_items;
create policy "Admins can add menu items to any kitchen"
  on public.menu_items for insert
  to authenticated
  with check (public.user_has_role('admin'));

drop policy if exists "Admins can update every menu item" on public.menu_items;
create policy "Admins can update every menu item"
  on public.menu_items for update
  to authenticated
  using (public.user_has_role('admin'))
  with check (public.user_has_role('admin'));

drop policy if exists "Hidden menu items are never public" on public.menu_items;
create policy "Hidden menu items are never public"
  on public.menu_items as restrictive for select
  to anon
  using (not is_hidden);

drop policy if exists "Hidden menu items only for their cook and HQ" on public.menu_items;
create policy "Hidden menu items only for their cook and HQ"
  on public.menu_items as restrictive for select
  to authenticated
  using (not is_hidden or auth.uid() = kitchen_id or public.user_has_role('admin'));

create or replace function public.guard_admin_menu_item_edit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_allowed constant text[] := array['name', 'price', 'photo_url', 'is_hidden'];
  v_bad text[];
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if public.is_admin_editing_kitchen(new.kitchen_id) then
      new.created_at := now();  -- HQ can't backdate an item
      new.updated_at := now();
    end if;
    return new;
  end if;

  if not public.is_admin_editing_kitchen(old.kitchen_id) then
    return new;
  end if;

  -- kitchen_id is not allowed: HQ can never move an item to another kitchen.
  select coalesce(array_agg(n.key order by n.key), '{}')
    into v_bad
  from jsonb_each(to_jsonb(new)) as n
  join jsonb_each(to_jsonb(old)) as o using (key)
  where n.value is distinct from o.value
    and n.key <> all (v_allowed);

  if cardinality(v_bad) > 0 then
    raise exception 'HQ cannot change % on a menu item', array_to_string(v_bad, ', ')
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists a_menu_item_admin_guard on public.menu_items;
create trigger a_menu_item_admin_guard
  before insert or update on public.menu_items
  for each row execute function public.guard_admin_menu_item_edit();

create or replace function public.touch_menu_item_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists before_menu_item_update on public.menu_items;
create trigger before_menu_item_update
  before update on public.menu_items
  for each row execute function public.touch_menu_item_updated_at();

create or replace function public.audit_admin_menu_item_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb;
  v_action text;
begin
  if not public.is_admin_editing_kitchen(new.kitchen_id) then
    return null;
  end if;

  if tg_op = 'INSERT' then
    v_action := 'menu_item_added';
    select jsonb_object_agg(n.key, jsonb_build_object('old', null, 'new', n.value))
      into v_changes
    from jsonb_each(to_jsonb(new)) as n
    where n.key in ('name', 'price', 'photo_url', 'is_hidden');
  else
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value)), '{}'::jsonb)
      into v_changes
    from jsonb_each(to_jsonb(new)) as n
    join jsonb_each(to_jsonb(old)) as o using (key)
    where n.value is distinct from o.value
      and n.key <> 'updated_at';

    if v_changes = '{}'::jsonb then
      return null;
    end if;

    v_action := case
      when new.is_hidden and not old.is_hidden then 'menu_item_hidden'
      when old.is_hidden and not new.is_hidden then 'menu_item_unhidden'
      else 'menu_item_updated'
    end;
  end if;

  insert into public.kitchen_admin_audit
    (admin_id, kitchen_id, kitchen_name, target_table, target_id, action, changes, reason)
  values (
    auth.uid(), new.kitchen_id,
    (select k.business_name from public.kitchens k where k.id = new.kitchen_id),
    'menu_items', new.id, v_action, v_changes,
    nullif(current_setting('kb.admin_edit_reason', true), '')
  );
  return null;
end;
$$;

drop trigger if exists z_menu_item_admin_audit on public.menu_items;
create trigger z_menu_item_admin_audit
  after insert or update on public.menu_items
  for each row execute function public.audit_admin_menu_item_edit();

revoke all on function public.guard_admin_menu_item_edit() from public, anon, authenticated;
revoke all on function public.touch_menu_item_updated_at() from public, anon, authenticated;
revoke all on function public.audit_admin_menu_item_edit() from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. PAYNOW (inert until a Boss screen calls it; planned for v1.1)
-- The guard refuses PayNow from HQ's direct writes. This SECURITY DEFINER
-- function is the only HQ path: its update runs as the owner, so the guard
-- lets it through, and auth.uid() is still the admin, so the audit logs it
-- (masked). Needs the typed business name and a reason.
-- ----------------------------------------------------------------------------
create or replace function public.admin_get_kitchen_paynow(p_kitchen_id uuid)
returns table (paynow_type text, paynow_masked text)
language sql
stable
security definer
set search_path = public
as $$
  select k.paynow_type, public.mask_paynow(k.paynow_value)
  from public.kitchens k
  where k.id = p_kitchen_id
    and public.user_has_role('admin');
$$;

create or replace function public.admin_set_kitchen_paynow(
  p_kitchen_id uuid,
  p_type text,
  p_value text,
  p_confirm_business_name text,
  p_reason text
)
returns text  -- the new value, masked
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_value text := upper(regexp_replace(coalesce(p_value, ''), '\s', '', 'g'));
  v_rows int;
begin
  if not public.is_admin_editing_kitchen(p_kitchen_id) then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Give a reason for changing PayNow details.' using errcode = '22023';
  end if;

  if p_type = 'mobile' then
    v_value := regexp_replace(v_value, '^\+?65', '');
    if v_value !~ '^[89][0-9]{7}$' then
      raise exception 'A PayNow mobile number is 8 digits starting with 8 or 9.' using errcode = '22023';
    end if;
  elsif p_type = 'uen' then
    if v_value !~ '^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$' then
      raise exception 'That doesn''t look like a UEN.' using errcode = '22023';
    end if;
  else
    raise exception 'PayNow type must be mobile or uen.' using errcode = '22023';
  end if;

  select k.business_name into v_name
  from public.kitchens k
  where k.id = p_kitchen_id
  for update;
  if v_name is null then
    raise exception 'Kitchen not found.' using errcode = 'P0002';
  end if;
  if lower(btrim(coalesce(p_confirm_business_name, ''))) <> lower(btrim(v_name)) then
    raise exception 'Type the kitchen''s business name exactly to confirm.' using errcode = '22023';
  end if;

  perform set_config('kb.admin_edit_reason', btrim(p_reason), true);
  update public.kitchens
  set paynow_type = p_type, paynow_value = v_value
  where id = p_kitchen_id;
  get diagnostics v_rows = row_count;
  perform set_config('kb.admin_edit_reason', '', true);

  if v_rows <> 1 then
    raise exception 'PayNow details were not saved.' using errcode = 'P0001';
  end if;
  return public.mask_paynow(v_value);
end;
$$;

revoke all on function public.admin_get_kitchen_paynow(uuid) from public, anon;
revoke all on function public.admin_set_kitchen_paynow(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_get_kitchen_paynow(uuid) to authenticated;
grant execute on function public.admin_set_kitchen_paynow(uuid, text, text, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 7. PHOTOS: HQ uploads into <kitchen_id>/hq/<uuid>.<ext>. Insert only.
-- ----------------------------------------------------------------------------
drop policy if exists "Admins can upload kitchen photos for any kitchen" on storage.objects;
create policy "Admins can upload kitchen photos for any kitchen"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'kitchen-photos'
    and public.user_has_role('admin')
    and (storage.foldername(name))[2] = 'hq'
    and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
    and exists (
      select 1 from public.kitchens k
      where k.id::text = (storage.foldername(name))[1]
    )
  );


-- ----------------------------------------------------------------------------
-- 8. CHECKS AFTER: the guards really fire first. Otherwise roll back.
-- tgtype bits: 1 = row, 2 = before, 4 = insert, 16 = update.
-- ----------------------------------------------------------------------------
do $$
declare
  v_before text;
begin
  select string_agg(t.tgname, ', ' order by t.tgname) into v_before
  from pg_trigger t
  where t.tgrelid = 'public.kitchens'::regclass and not t.tgisinternal
    and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 20) <> 0
    and t.tgname < 'a_kitchen_admin_guard';
  if v_before is not null then
    raise exception 'Stopped: these kitchens BEFORE INSERT/UPDATE triggers would fire before the HQ guard: %', v_before;
  end if;

  -- The terms trigger must exist and must fire after the guard.
  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.kitchens'::regclass and not t.tgisinternal
      and p.proname = 'stamp_kitchen_terms_acknowledgement'
      and t.tgname > 'a_kitchen_admin_guard'
  ) then
    raise exception 'Stopped: stamp_kitchen_terms_acknowledgement trigger missing, or it would fire before the HQ guard';
  end if;

  select string_agg(t.tgname, ', ' order by t.tgname) into v_before
  from pg_trigger t
  where t.tgrelid = 'public.menu_items'::regclass and not t.tgisinternal
    and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 20) <> 0
    and t.tgname < 'a_menu_item_admin_guard';
  if v_before is not null then
    raise exception 'Stopped: these menu_items BEFORE triggers would fire before the HQ guard: %', v_before;
  end if;
end;
$$;

commit;
