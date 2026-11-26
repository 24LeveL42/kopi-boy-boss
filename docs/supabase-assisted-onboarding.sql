-- ============================================================================
-- KOPI BOY — Assisted onboarding (v1): HQ sets up a shop for a hawker who has
-- no Google account or email; the owner claims it with one tap.
-- Rev 1, NOT INSTALLED. Review first.
-- Live test: docs/supabase-assisted-onboarding-live-test.sql (always rolls back).
-- PGlite test: src/lib/assisted-onboarding-sql.test.ts (stage C).
--
-- FLOW
--   1. HQ (Boss) writes a DRAFT: assisted_shops + assisted_shop_items. No
--      kitchens row exists yet, and none can: kitchens.id is the owner's
--      auth user id, and the live terms trigger refuses a kitchen INSERT
--      without acknowledged_terms_at.
--   2. HQ issues a claim link. Boss makes the raw token (32 random bytes,
--      base64url) and sends ONLY its hash here:
--        token_hash = lowercase hex SHA-256 of the raw token's UTF-8 bytes.
--      The raw token never reaches the database. 48 hours, single use,
--      revocable; issuing again revokes the previous one.
--   3. The owner opens https://partners.kopi-boy.com/claim#<token> on their
--      phone. The Partner server (service_role) calls
--      assisted_claim_preview, then creates the auth user, then calls
--      assisted_claim_complete. That call is the ONLY place a kitchen is
--      created from a draft, and the owner's tap is the only thing that
--      reaches it: HQ cannot call it, and the draft tables have no terms
--      column HQ could write.
--   4. assisted_claim_complete, in one transaction: an approved
--      cook_applications row (the existing triggers then promote the role
--      to cook; a subscription row is created only if billing is on, and it
--      is off for the pilot: docs/supabase-billing-off.sql), the
--      profile name and phone, the kitchens row (acknowledged_terms_at sent
--      as any value; the live terms trigger stamps now()), kitchen_addresses,
--      and the visible menu items. is_live stays FALSE: the owner adds
--      PayNow in Kitchen Setup, and that save puts the kitchen live.
--
-- WHAT IT DOES NOT TOUCH
--   No existing table, column, policy, trigger or function is altered or
--   replaced. In particular a_kitchen_admin_guard / guard_admin_kitchen_edit
--   and before_kitchen_terms_acknowledgement /
--   stamp_kitchen_terms_acknowledgement are unchanged; section 9 compares
--   their definitions before and after and refuses to commit if they differ.
--   No auth schema object is changed (auth.users is only read).
--
-- WHO CAN DO WHAT
--   * HQ (authenticated + user_has_role('admin')): read and write drafts
--     and draft items through RLS and column grants; issue, mark sent,
--     revoke and list claim links, cancel a draft, through the admin_*
--     functions. HQ never sees a token hash.
--   * service_role (Partner server only): assisted_claim_preview and
--     assisted_claim_complete. Nothing else.
--   * anon and every other signed-in user: nothing.
--
-- AUDIT: assisted_onboarding_audit, append-only, same style as
-- kitchen_admin_audit (a separate table so that one's reviewed CHECK
-- constraints stay as they are). Every create, edit, cancel, link issued,
-- link sent, link revoked and claim. Never a token or a hash.
--
-- PRICING PLAN: assisted_shops.pricing_plan is nullable text with no CHECK.
-- Unused during the pilot (Kopi Boy is free for merchants) and must stay
-- empty. It is not copied anywhere at claim.
--
-- Runs as one transaction: if any check fails, nothing is changed.
-- Safe to re-run.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. CHECKS BEFORE ANYTHING CHANGES
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(t || '.' || c, ', ') into v_missing
  from (values
    ('kitchens', 'acknowledged_terms_at'), ('kitchens', 'is_live'), ('kitchens', 'is_halal'),
    ('kitchens', 'hero_image'), ('kitchens', 'paynow_value'),
    ('kitchen_addresses', 'business_address'), ('kitchen_addresses', 'postal_code'),
    ('menu_items', 'is_hidden'),
    ('cook_applications', 'business_type'), ('cook_applications', 'business_uen'),
    ('cook_applications', 'business_address'), ('cook_applications', 'postal_code'),
    ('cook_applications', 'privacy_policy_version'),
    ('profiles', 'phone'), ('profiles', 'role')
  ) as x(t, c)
  where not exists (
    select 1 from information_schema.columns ic
    where ic.table_schema = 'public' and ic.table_name = x.t and ic.column_name = x.c
  );
  if v_missing is not null then
    raise exception 'Stopped: missing column(s) %', v_missing;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'Stopped: no service_role role';
  end if;

  -- Functions this script calls (none of them is changed here).
  if to_regprocedure('public.user_has_role(text)') is null
     or to_regprocedure('public.mask_paynow(text)') is null then
    raise exception 'Stopped: public.user_has_role(text) or public.mask_paynow(text) is missing (install supabase-kitchen-admin-edit.sql first)';
  end if;

  -- The two triggers the claim relies on, and that must stay as they are.
  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.kitchens'::regclass and not t.tgisinternal
      and t.tgname = 'a_kitchen_admin_guard' and p.proname = 'guard_admin_kitchen_edit'
  ) then
    raise exception 'Stopped: a_kitchen_admin_guard is not installed on kitchens';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.kitchens'::regclass and not t.tgisinternal
      and p.proname = 'stamp_kitchen_terms_acknowledgement'
  ) then
    raise exception 'Stopped: the partner terms trigger is not installed on kitchens';
  end if;

  -- The billing trigger on an approved INSERT (subscriptions step 2). While
  -- billing is off (docs/supabase-billing-off.sql) it makes no row; the
  -- trigger itself stays.
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.cook_applications'::regclass and not t.tgisinternal
      and t.tgname = 'after_cook_application_subscription_insert'
  ) then
    raise exception 'Stopped: after_cook_application_subscription_insert is missing (subscriptions step 2)';
  end if;

  if to_regclass('storage.objects') is null then
    raise exception 'Stopped: storage.objects is missing';
  end if;

  -- Fingerprints of the guard and terms functions; section 9 compares.
  perform set_config('kb_assist.guard_md5',
    md5(pg_get_functiondef('public.guard_admin_kitchen_edit()'::regprocedure)), true);
  perform set_config('kb_assist.terms_md5',
    md5(pg_get_functiondef('public.stamp_kitchen_terms_acknowledgement()'::regprocedure)), true);
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. DRAFT SHOPS
-- Lists below mirror the live kitchens CHECKs and the Partner app's
-- MERCHANT_CATEGORIES; the kitchens insert at claim is the real backstop.
-- No foreign keys to profiles/auth.users: a draft (and its history)
-- outlives a deleted test merchant and never blocks "Delete test partner".
-- ----------------------------------------------------------------------------
create table if not exists public.assisted_shops (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'draft' check (status in ('draft', 'claimed', 'cancelled')),

  -- What HQ enters (the only columns HQ can write; section 1 grants)
  business_name text not null check (char_length(btrim(business_name)) between 1 and 80),
  category text not null check (category in ('home-cook', 'hawker', 'bakery', 'vegetarian', 'drinks-desserts')),
  cuisine_type text not null check (cuisine_type in ('chinese', 'halal', 'indian', 'western')),
  is_halal boolean not null default false,
  description text check (description is null or char_length(description) <= 500),
  hero_image text check (hero_image is null or char_length(hero_image) <= 2000),
  owner_name text not null check (char_length(btrim(owner_name)) between 1 and 80),
  owner_mobile text not null check (owner_mobile ~ '^[89][0-9]{7}$'),   -- 8 digits, no +65
  business_uen text check (business_uen is null
    or business_uen ~ '^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$'),
  business_address text check (business_address is null or char_length(business_address) <= 300),
  postal_code text check (postal_code is null or postal_code ~ '^[0-9]{6}$'),
  pricing_plan text,   -- nullable, no CHECK: unused during the pilot, must stay empty

  -- Set by the database only
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  claimed_user_id uuid,          -- = the new kitchens.id
  claimed_at timestamptz,
  acknowledged_at timestamptz,   -- = kitchens.acknowledged_terms_at as stamped
  acknowledged_token_id uuid,
  acknowledged_user_agent text
);

comment on column public.assisted_shops.pricing_plan is
  'Nullable, no CHECK: unused during the pilot (Kopi Boy is free for merchants); must stay empty. Not copied at claim.';

-- One open draft per owner mobile, so HQ can't set up the same hawker twice.
create unique index if not exists assisted_shops_open_mobile_idx
  on public.assisted_shops (owner_mobile) where status = 'draft';
create index if not exists assisted_shops_created_idx
  on public.assisted_shops (created_at desc);

alter table public.assisted_shops enable row level security;

revoke all on public.assisted_shops from public, anon, authenticated, service_role;
grant select (
  id, status, business_name, category, cuisine_type, is_halal, description, hero_image,
  owner_name, owner_mobile, business_uen, business_address, postal_code, pricing_plan,
  created_by, created_at, updated_at, cancelled_at, cancelled_by,
  claimed_user_id, claimed_at, acknowledged_at, acknowledged_token_id, acknowledged_user_agent
) on public.assisted_shops to authenticated;
grant insert (
  business_name, category, cuisine_type, is_halal, description, hero_image,
  owner_name, owner_mobile, business_uen, business_address, postal_code, pricing_plan
) on public.assisted_shops to authenticated;
grant update (
  business_name, category, cuisine_type, is_halal, description, hero_image,
  owner_name, owner_mobile, business_uen, business_address, postal_code, pricing_plan
) on public.assisted_shops to authenticated;

drop policy if exists "Admins read assisted shops" on public.assisted_shops;
create policy "Admins read assisted shops"
  on public.assisted_shops for select to authenticated
  using (public.user_has_role('admin'));

drop policy if exists "Admins create assisted shops" on public.assisted_shops;
create policy "Admins create assisted shops"
  on public.assisted_shops for insert to authenticated
  with check (public.user_has_role('admin'));

drop policy if exists "Admins edit draft assisted shops" on public.assisted_shops;
create policy "Admins edit draft assisted shops"
  on public.assisted_shops for update to authenticated
  using (public.user_has_role('admin') and status = 'draft')
  with check (public.user_has_role('admin'));


-- ----------------------------------------------------------------------------
-- 2. DRAFT MENU ITEMS (same fields as menu_items; hide, never delete)
-- ----------------------------------------------------------------------------
create table if not exists public.assisted_shop_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.assisted_shops(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  price numeric(6,2) not null check (price > 0),
  photo_url text check (photo_url is null or char_length(photo_url) <= 2000),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assisted_shop_items_shop_idx
  on public.assisted_shop_items (shop_id, created_at);

alter table public.assisted_shop_items enable row level security;

revoke all on public.assisted_shop_items from public, anon, authenticated, service_role;
grant select (id, shop_id, name, price, photo_url, is_hidden, created_at, updated_at)
  on public.assisted_shop_items to authenticated;
grant insert (shop_id, name, price, photo_url) on public.assisted_shop_items to authenticated;
grant update (name, price, photo_url, is_hidden) on public.assisted_shop_items to authenticated;

drop policy if exists "Admins read assisted shop items" on public.assisted_shop_items;
create policy "Admins read assisted shop items"
  on public.assisted_shop_items for select to authenticated
  using (public.user_has_role('admin'));

drop policy if exists "Admins add items to draft assisted shops" on public.assisted_shop_items;
create policy "Admins add items to draft assisted shops"
  on public.assisted_shop_items for insert to authenticated
  with check (
    public.user_has_role('admin')
    and exists (select 1 from public.assisted_shops s where s.id = shop_id and s.status = 'draft')
  );

drop policy if exists "Admins edit items of draft assisted shops" on public.assisted_shop_items;
create policy "Admins edit items of draft assisted shops"
  on public.assisted_shop_items for update to authenticated
  using (
    public.user_has_role('admin')
    and exists (select 1 from public.assisted_shops s where s.id = shop_id and s.status = 'draft')
  )
  with check (public.user_has_role('admin'));


-- ----------------------------------------------------------------------------
-- 3. CLAIM TOKENS (hash only) AND ATTEMPTS (rate limit)
-- Nobody reads these tables directly, service_role included: only the
-- SECURITY DEFINER functions below touch them.
-- ----------------------------------------------------------------------------
create table if not exists public.assisted_claim_tokens (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.assisted_shops(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  sent_by uuid,
  used_at timestamptz,
  used_user_agent text,
  revoked_at timestamptz,
  revoked_by uuid,           -- null when revoked by the system (re-issue, cancel, claim)
  revoke_reason text,
  check (expires_at > created_at),
  check (not (used_at is not null and revoked_at is not null))
);

-- At most one unused, unrevoked token per shop (an expired one counts until
-- it is revoked; issuing a new link revokes it).
create unique index if not exists assisted_claim_tokens_one_open_idx
  on public.assisted_claim_tokens (shop_id) where used_at is null and revoked_at is null;

alter table public.assisted_claim_tokens enable row level security;
revoke all on public.assisted_claim_tokens from public, anon, authenticated, service_role;

create table if not exists public.assisted_claim_attempts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  client_key text not null check (client_key ~ '^[0-9a-f]{64}$'),  -- hash made by the Partner server, never a raw IP
  kind text not null check (kind in ('preview', 'claim')),
  result text not null
);

create index if not exists assisted_claim_attempts_key_idx
  on public.assisted_claim_attempts (client_key, at desc);
create index if not exists assisted_claim_attempts_at_idx
  on public.assisted_claim_attempts (at);

alter table public.assisted_claim_attempts enable row level security;
revoke all on public.assisted_claim_attempts from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 4. AUDIT LOG (append-only)
-- ----------------------------------------------------------------------------
create table if not exists public.assisted_onboarding_audit (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_id uuid,             -- the admin; for 'claimed', the new owner
  actor_kind text not null check (actor_kind in ('admin', 'owner')),
  shop_id uuid not null,
  shop_name text,
  token_id uuid,
  kitchen_id uuid,
  action text not null check (action in (
    'shop_created', 'shop_updated', 'shop_cancelled',
    'item_added', 'item_updated', 'item_hidden', 'item_unhidden',
    'link_issued', 'link_sent', 'link_revoked', 'claimed'
  )),
  details jsonb not null default '{}'::jsonb   -- never a token or a hash; mobile masked
);

create index if not exists assisted_onboarding_audit_shop_idx
  on public.assisted_onboarding_audit (shop_id, created_at desc);

alter table public.assisted_onboarding_audit enable row level security;
revoke all on public.assisted_onboarding_audit from public, anon, authenticated, service_role;
grant select (id, created_at, actor_id, actor_kind, shop_id, shop_name, token_id, kitchen_id, action, details)
  on public.assisted_onboarding_audit to authenticated;

drop policy if exists "Admins read the assisted onboarding audit" on public.assisted_onboarding_audit;
create policy "Admins read the assisted onboarding audit"
  on public.assisted_onboarding_audit for select to authenticated
  using (public.user_has_role('admin'));

create or replace function public.assisted_onboarding_audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'assisted_onboarding_audit is append-only: % is not allowed', tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists assisted_onboarding_audit_append_only on public.assisted_onboarding_audit;
create trigger assisted_onboarding_audit_append_only
  before update or delete on public.assisted_onboarding_audit
  for each row execute function public.assisted_onboarding_audit_append_only();

drop trigger if exists assisted_onboarding_audit_no_truncate on public.assisted_onboarding_audit;
create trigger assisted_onboarding_audit_no_truncate
  before truncate on public.assisted_onboarding_audit
  for each statement execute function public.assisted_onboarding_audit_append_only();

revoke all on function public.assisted_onboarding_audit_append_only() from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 5. GUARDS AND AUDIT ON DRAFT WRITES
-- Guards are SECURITY INVOKER so current_user is the caller's role. They
-- judge direct writes from the app ('authenticated'); writes made inside
-- the SECURITY DEFINER functions below run as the owner and pass through.
-- updated_at is stamped on every update (the stale-edit check needs it).
-- ----------------------------------------------------------------------------
create or replace function public.guard_assisted_shop()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := pg_catalog.now();
  end if;

  if current_user <> 'authenticated' then
    return new;
  end if;

  new.business_name := pg_catalog.btrim(new.business_name);
  new.owner_name := pg_catalog.btrim(new.owner_name);
  new.description := nullif(pg_catalog.btrim(coalesce(new.description, '')), '');
  new.hero_image := nullif(pg_catalog.btrim(coalesce(new.hero_image, '')), '');
  new.business_uen := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(new.business_uen, ''))), '');
  new.business_address := nullif(pg_catalog.btrim(coalesce(new.business_address, '')), '');
  new.postal_code := nullif(pg_catalog.btrim(coalesce(new.postal_code, '')), '');
  new.pricing_plan := nullif(pg_catalog.btrim(coalesce(new.pricing_plan, '')), '');

  if tg_op = 'INSERT' then
    -- The column grants already keep these out of HQ's hands; set them anyway.
    new.status := 'draft';
    new.created_by := auth.uid();
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.claimed_user_id := null;
    new.claimed_at := null;
    new.acknowledged_at := null;
    new.acknowledged_token_id := null;
    new.acknowledged_user_agent := null;
    return new;
  end if;

  if old.status <> 'draft' then
    raise exception 'This shop has already been claimed or cancelled, so the draft can''t be changed. Edit the merchant''s kitchen instead.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists a_assisted_shop_guard on public.assisted_shops;
create trigger a_assisted_shop_guard
  before insert or update on public.assisted_shops
  for each row execute function public.guard_assisted_shop();

create or replace function public.guard_assisted_shop_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := pg_catalog.now();
  end if;

  if current_user <> 'authenticated' then
    return new;
  end if;

  new.name := pg_catalog.btrim(new.name);
  new.photo_url := nullif(pg_catalog.btrim(coalesce(new.photo_url, '')), '');

  if tg_op = 'INSERT' then
    new.is_hidden := false;
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
  elsif new.shop_id is distinct from old.shop_id then
    raise exception 'A draft menu item can''t be moved to another shop.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.assisted_shops s where s.id = new.shop_id and s.status = 'draft') then
    raise exception 'This shop has already been claimed or cancelled, so its draft menu can''t be changed.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists a_assisted_shop_item_guard on public.assisted_shop_items;
create trigger a_assisted_shop_item_guard
  before insert or update on public.assisted_shop_items
  for each row execute function public.guard_assisted_shop_item();

-- AFTER trigger: one audit row per direct HQ write (auth.uid() set). The
-- claim (service_role, no auth.uid()) writes its own 'claimed' row instead;
-- the admin_* functions write their own rows for links, and a cancel is
-- logged here as 'shop_cancelled' with the reason from kb.assisted_reason.
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

  select coalesce(pg_catalog.jsonb_object_agg(
           n.key,
           case when n.key = 'owner_mobile'
             then pg_catalog.jsonb_build_object(
                    'old', public.mask_paynow(v_old ->> 'owner_mobile'),
                    'new', public.mask_paynow(v_new ->> 'owner_mobile'))
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

drop trigger if exists z_assisted_shop_audit on public.assisted_shops;
create trigger z_assisted_shop_audit
  after insert or update on public.assisted_shops
  for each row execute function public.audit_assisted_onboarding_row();

drop trigger if exists z_assisted_shop_item_audit on public.assisted_shop_items;
create trigger z_assisted_shop_item_audit
  after insert or update on public.assisted_shop_items
  for each row execute function public.audit_assisted_onboarding_row();

revoke all on function public.guard_assisted_shop() from public, anon, authenticated, service_role;
revoke all on function public.guard_assisted_shop_item() from public, anon, authenticated, service_role;
revoke all on function public.audit_assisted_onboarding_row() from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 6. HQ: CLAIM LINKS AND CANCEL (authenticated, admins only)
-- ----------------------------------------------------------------------------

-- Issues a link for a draft that is ready to claim. Revokes any earlier
-- unused link of the shop first ("re-issue"). Returns the new link's id and
-- expiry; the raw token stays in Boss and is shown to HQ once.
create or replace function public.admin_issue_assisted_claim_link(p_shop_id uuid, p_token_hash text)
returns table (token_id uuid, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.assisted_shops;
  v_old record;
  v_id uuid;
  v_expires timestamptz := pg_catalog.now() + pg_catalog.make_interval(hours => 48);
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid claim token.' using errcode = '22023';
  end if;

  select * into v_shop from public.assisted_shops s where s.id = p_shop_id for update;
  if not found then
    raise exception 'Shop not found.' using errcode = 'P0002';
  end if;
  if v_shop.status <> 'draft' then
    raise exception 'This shop has already been claimed or cancelled.' using errcode = '22023';
  end if;
  if v_shop.business_address is null or v_shop.postal_code is null then
    raise exception 'Add the pickup address and postal code before sending a claim link.' using errcode = '22023';
  end if;
  if v_shop.category <> 'home-cook' and v_shop.business_uen is null then
    raise exception 'Add the business UEN before sending a claim link (only a Home Cook can be set up without one).' using errcode = '22023';
  end if;
  if not exists (select 1 from public.assisted_shop_items i where i.shop_id = p_shop_id and not i.is_hidden) then
    raise exception 'Add at least one menu item before sending a claim link.' using errcode = '22023';
  end if;

  for v_old in
    update public.assisted_claim_tokens t
    set revoked_at = pg_catalog.now(), revoked_by = auth.uid(), revoke_reason = 'replaced by a new link'
    where t.shop_id = p_shop_id and t.used_at is null and t.revoked_at is null
    returning t.id
  loop
    insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, action, details)
    values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, v_old.id, 'link_revoked',
            pg_catalog.jsonb_build_object('reason', 'replaced by a new link'));
  end loop;

  insert into public.assisted_claim_tokens (shop_id, token_hash, created_by, expires_at)
  values (p_shop_id, p_token_hash, auth.uid(), v_expires)
  returning id into v_id;

  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, action, details)
  values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, v_id, 'link_issued',
          pg_catalog.jsonb_build_object('expires_at', v_expires));

  return query select v_id, v_expires;
end;
$$;

-- HQ tapped "Send on WhatsApp". Logged every time; sent_at keeps the first.
create or replace function public.admin_mark_assisted_claim_link_sent(p_token_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token public.assisted_claim_tokens;
  v_name text;
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;

  select * into v_token from public.assisted_claim_tokens t where t.id = p_token_id for update;
  if not found then
    raise exception 'Claim link not found.' using errcode = 'P0002';
  end if;
  if v_token.used_at is not null or v_token.revoked_at is not null or v_token.expires_at <= pg_catalog.now() then
    raise exception 'This claim link is no longer valid. Issue a new one.' using errcode = '22023';
  end if;

  update public.assisted_claim_tokens t
  set sent_at = coalesce(t.sent_at, pg_catalog.now()), sent_by = coalesce(t.sent_by, auth.uid())
  where t.id = p_token_id;

  select s.business_name into v_name from public.assisted_shops s where s.id = v_token.shop_id;
  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, action, details)
  values (auth.uid(), 'admin', v_token.shop_id, v_name, p_token_id, 'link_sent',
          pg_catalog.jsonb_build_object('channel', 'whatsapp'));
end;
$$;

-- HQ revokes a link that hasn't been used. A reason is required.
create or replace function public.admin_revoke_assisted_claim_link(p_token_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token public.assisted_claim_tokens;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_name text;
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'Give a reason for revoking the link.' using errcode = '22023';
  end if;

  select * into v_token from public.assisted_claim_tokens t where t.id = p_token_id for update;
  if not found then
    raise exception 'Claim link not found.' using errcode = 'P0002';
  end if;
  if v_token.used_at is not null then
    raise exception 'This link has already been used to claim the shop.' using errcode = '22023';
  end if;
  if v_token.revoked_at is not null then
    return;  -- already revoked: nothing to do
  end if;

  update public.assisted_claim_tokens t
  set revoked_at = pg_catalog.now(), revoked_by = auth.uid(), revoke_reason = pg_catalog.left(v_reason, 200)
  where t.id = p_token_id;

  select s.business_name into v_name from public.assisted_shops s where s.id = v_token.shop_id;
  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, action, details)
  values (auth.uid(), 'admin', v_token.shop_id, v_name, p_token_id, 'link_revoked',
          pg_catalog.jsonb_build_object('reason', pg_catalog.left(v_reason, 200)));
end;
$$;

-- HQ cancels a draft: its open link is revoked and the draft is frozen.
create or replace function public.admin_cancel_assisted_shop(p_shop_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.assisted_shops;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_old record;
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'Give a reason for cancelling this shop.' using errcode = '22023';
  end if;

  select * into v_shop from public.assisted_shops s where s.id = p_shop_id for update;
  if not found then
    raise exception 'Shop not found.' using errcode = 'P0002';
  end if;
  if v_shop.status <> 'draft' then
    raise exception 'Only a draft can be cancelled.' using errcode = '22023';
  end if;

  for v_old in
    update public.assisted_claim_tokens t
    set revoked_at = pg_catalog.now(), revoked_by = auth.uid(), revoke_reason = 'shop cancelled'
    where t.shop_id = p_shop_id and t.used_at is null and t.revoked_at is null
    returning t.id
  loop
    insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, action, details)
    values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, v_old.id, 'link_revoked',
            pg_catalog.jsonb_build_object('reason', 'shop cancelled'));
  end loop;

  -- The audit trigger logs this as 'shop_cancelled' with the reason.
  perform pg_catalog.set_config('kb.assisted_reason', pg_catalog.left(v_reason, 200), true);
  update public.assisted_shops s
  set status = 'cancelled', cancelled_at = pg_catalog.now(), cancelled_by = auth.uid()
  where s.id = p_shop_id;
  perform pg_catalog.set_config('kb.assisted_reason', '', true);
end;
$$;

-- HQ's view of a shop's links. Never the hash.
create or replace function public.admin_list_assisted_claim_links(p_shop_id uuid)
returns table (
  id uuid,
  state text,             -- 'live' | 'expired' | 'used' | 'revoked'
  created_at timestamptz,
  created_by uuid,
  expires_at timestamptz,
  sent_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;

  return query
    select t.id,
           case
             when t.used_at is not null then 'used'
             when t.revoked_at is not null then 'revoked'
             when t.expires_at <= pg_catalog.now() then 'expired'
             else 'live'
           end,
           t.created_at, t.created_by, t.expires_at, t.sent_at, t.used_at, t.revoked_at, t.revoke_reason
    from public.assisted_claim_tokens t
    where t.shop_id = p_shop_id
    order by t.created_at desc;
end;
$$;

revoke all on function public.admin_issue_assisted_claim_link(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_mark_assisted_claim_link_sent(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_revoke_assisted_claim_link(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_cancel_assisted_shop(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_list_assisted_claim_links(uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_issue_assisted_claim_link(uuid, text) to authenticated;
grant execute on function public.admin_mark_assisted_claim_link_sent(uuid) to authenticated;
grant execute on function public.admin_revoke_assisted_claim_link(uuid, text) to authenticated;
grant execute on function public.admin_cancel_assisted_shop(uuid, text) to authenticated;
grant execute on function public.admin_list_assisted_claim_links(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 7. OWNER: PREVIEW AND CLAIM (service_role only: the Partner server)
-- Both return jsonb with a "status":
--   ok | invalid | expired | used | revoked | cancelled | rate_limited
-- They return (not raise) for a bad token, so the attempt row is kept.
-- Rate limit per client_key (a hash the Partner server makes, e.g. of the
-- caller's IP; never the IP itself), over the last 15 minutes: 10 failed
-- attempts, or 60 in total. Rows older than a day are removed as they go.
-- ----------------------------------------------------------------------------
create or replace function public.assisted_claim_rate_limited(p_client_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) filter (where a.result <> 'ok') >= 10 or count(*) >= 60
  from public.assisted_claim_attempts a
  where a.client_key = p_client_key
    and a.at > pg_catalog.now() - pg_catalog.make_interval(mins => 15);
$$;

-- What state a token is in, for preview and claim. Reads only.
create or replace function public.assisted_claim_token_state(p_token public.assisted_claim_tokens, p_shop_status text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_token.id is null then 'invalid'
    when p_token.used_at is not null then 'used'
    when p_shop_status = 'cancelled' then 'cancelled'
    when p_shop_status = 'claimed' then 'used'
    when p_token.revoked_at is not null then 'revoked'
    when p_token.expires_at <= pg_catalog.now() then 'expired'
    else 'ok'
  end;
$$;

create or replace function public.assisted_claim_preview(p_token_hash text, p_client_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token public.assisted_claim_tokens;
  v_shop public.assisted_shops;
  v_state text;
begin
  if p_client_key is null or p_client_key !~ '^[0-9a-f]{64}$' then
    raise exception 'assisted_claim: bad client key' using errcode = '22023';
  end if;
  delete from public.assisted_claim_attempts a where a.at < pg_catalog.now() - pg_catalog.make_interval(days => 1);
  if public.assisted_claim_rate_limited(p_client_key) then
    insert into public.assisted_claim_attempts (client_key, kind, result) values (p_client_key, 'preview', 'rate_limited');
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  if p_token_hash ~ '^[0-9a-f]{64}$' then
    select * into v_token from public.assisted_claim_tokens t where t.token_hash = p_token_hash;
    if v_token.id is not null then
      select * into v_shop from public.assisted_shops s where s.id = v_token.shop_id;
    end if;
  end if;
  v_state := public.assisted_claim_token_state(v_token, v_shop.status);

  insert into public.assisted_claim_attempts (client_key, kind, result) values (p_client_key, 'preview', v_state);
  if v_state <> 'ok' then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'shop_id', v_shop.id,
    'expires_at', v_token.expires_at,
    'shop', pg_catalog.jsonb_build_object(
      'business_name', v_shop.business_name,
      'category', v_shop.category,
      'cuisine_type', v_shop.cuisine_type,
      'is_halal', v_shop.is_halal,
      'description', v_shop.description,
      'hero_image', v_shop.hero_image,
      'owner_name', v_shop.owner_name,
      'owner_mobile_masked', public.mask_paynow(v_shop.owner_mobile),
      'business_uen', v_shop.business_uen,
      'business_address', v_shop.business_address,
      'postal_code', v_shop.postal_code
    ),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'name', i.name, 'price', i.price, 'photo_url', i.photo_url)
             order by i.created_at, i.id)
      from public.assisted_shop_items i
      where i.shop_id = v_shop.id and not i.is_hidden
    ), '[]'::jsonb)
  );
end;
$$;

-- The owner's tap. p_user_id is the auth user the Partner server has JUST
-- created with app_metadata.kb_assisted_shop_id = the preview's shop_id
-- (only the service role can set app_metadata, so a claim can never be
-- pointed at somebody else's account). A wrong or reused user raises
-- "assisted_claim: ..." and nothing is saved; the Partner server then
-- deletes the user it created. Any non-ok status also means: delete it.
create or replace function public.assisted_claim_complete(
  p_token_hash text,
  p_client_key text,
  p_user_id uuid,
  p_user_agent text,
  p_privacy_policy_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token public.assisted_claim_tokens;
  v_shop public.assisted_shops;
  v_state text;
  v_ua text := nullif(pg_catalog.left(pg_catalog.regexp_replace(coalesce(p_user_agent, ''), '[[:cntrl:]]', '', 'g'), 400), '');
  v_version text := nullif(pg_catalog.btrim(coalesce(p_privacy_policy_version, '')), '');
  v_role text;
  v_app_id uuid;
  v_app_created timestamptz;
  v_ack timestamptz;
  v_items int;
begin
  if p_client_key is null or p_client_key !~ '^[0-9a-f]{64}$' then
    raise exception 'assisted_claim: bad client key' using errcode = '22023';
  end if;
  if v_version is null or v_version !~ '^[0-9A-Za-z._-]{1,32}$' then
    raise exception 'assisted_claim: privacy policy version missing' using errcode = '22023';
  end if;
  if public.assisted_claim_rate_limited(p_client_key) then
    insert into public.assisted_claim_attempts (client_key, kind, result) values (p_client_key, 'claim', 'rate_limited');
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  -- Lock the token, then the shop: a double tap waits here and then sees 'used'.
  if p_token_hash ~ '^[0-9a-f]{64}$' then
    select * into v_token from public.assisted_claim_tokens t where t.token_hash = p_token_hash for update;
    if v_token.id is not null then
      select * into v_shop from public.assisted_shops s where s.id = v_token.shop_id for update;
    end if;
  end if;
  v_state := public.assisted_claim_token_state(v_token, v_shop.status);
  if v_state <> 'ok' then
    insert into public.assisted_claim_attempts (client_key, kind, result) values (p_client_key, 'claim', v_state);
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;

  -- The new account: made for this shop, still a plain customer, nothing else.
  if p_user_id is null or not exists (
    select 1 from auth.users u
    where u.id = p_user_id and (u.raw_app_meta_data ->> 'kb_assisted_shop_id') = v_shop.id::text
  ) then
    raise exception 'assisted_claim: the account was not made for this shop' using errcode = '42501';
  end if;
  select p.role into v_role from public.profiles p where p.id = p_user_id for update;
  if not found then
    raise exception 'assisted_claim: the account has no profile row' using errcode = 'P0002';
  end if;
  if v_role <> 'customer'
     or exists (select 1 from public.kitchens k where k.id = p_user_id)
     or exists (select 1 from public.cook_applications a where a.user_id = p_user_id) then
    raise exception 'assisted_claim: the account is already in use' using errcode = '42501';
  end if;

  -- 1. Profile: the owner's name and mobile (an existing phone is kept).
  update public.profiles p
  set full_name = v_shop.owner_name, phone = coalesce(p.phone, v_shop.owner_mobile)
  where p.id = p_user_id;

  -- 2. An approved cook application. Its existing triggers promote the role
  --    to 'cook'. The billing trigger makes no subscription row and no
  --    founding number while billing is off (the pilot); if billing is ever
  --    on it fails closed (an error there undoes the whole claim).
  --    created_at = when HQ set the shop up.
  insert into public.cook_applications (
    user_id, business_name, business_type, description, business_uen,
    business_address, postal_code, status, reviewed_by, reviewed_at,
    privacy_policy_version, created_at
  ) values (
    p_user_id, v_shop.business_name,
    case v_shop.category
      when 'home-cook' then 'Home Cook'
      when 'hawker' then 'Hawker'
      when 'bakery' then 'Bakery'
      when 'vegetarian' then 'Vegetarian'
      when 'drinks-desserts' then 'Drinks & Desserts'
    end,
    v_shop.description, v_shop.business_uen,
    v_shop.business_address, v_shop.postal_code, 'approved', v_shop.created_by, pg_catalog.now(),
    v_version, v_shop.created_at
  )
  returning id, created_at into v_app_id, v_app_created;
  if v_app_created is distinct from v_shop.created_at then
    raise exception 'assisted_claim: the application date was changed by a trigger' using errcode = 'P0001';
  end if;
  if (select p.role from public.profiles p where p.id = p_user_id) is distinct from 'cook' then
    raise exception 'assisted_claim: the account was not promoted to cook' using errcode = 'P0001';
  end if;

  -- 3. The kitchen. acknowledged_terms_at: any value means "ticked"; the
  --    live terms trigger replaces it with now(). Not live until PayNow.
  insert into public.kitchens (id, business_name, category, cuisine_type, is_halal, description, hero_image, is_live, acknowledged_terms_at)
  values (p_user_id, v_shop.business_name, v_shop.category, v_shop.cuisine_type, v_shop.is_halal,
          v_shop.description, v_shop.hero_image, false, pg_catalog.now());
  select k.acknowledged_terms_at into v_ack from public.kitchens k where k.id = p_user_id;
  if v_ack is null then
    raise exception 'assisted_claim: the terms were not recorded' using errcode = 'P0001';
  end if;

  -- 4. Pickup address (private). Exact coordinates are added by Kitchen
  --    Setup's postal lookup on the owner's first save.
  insert into public.kitchen_addresses (kitchen_id, business_address, postal_code)
  values (p_user_id, v_shop.business_address, v_shop.postal_code);

  -- 5. Visible draft items become the menu.
  insert into public.menu_items (kitchen_id, name, price, photo_url, is_hidden)
  select p_user_id, i.name, i.price, i.photo_url, false
  from public.assisted_shop_items i
  where i.shop_id = v_shop.id and not i.is_hidden
  order by i.created_at, i.id;
  get diagnostics v_items = row_count;

  -- 6. Close the token and the draft.
  update public.assisted_claim_tokens t
  set used_at = pg_catalog.now(), used_user_agent = v_ua
  where t.id = v_token.id;

  update public.assisted_shops s
  set status = 'claimed', claimed_user_id = p_user_id, claimed_at = pg_catalog.now(),
      acknowledged_at = v_ack, acknowledged_token_id = v_token.id, acknowledged_user_agent = v_ua
  where s.id = v_shop.id;

  insert into public.assisted_onboarding_audit (actor_id, actor_kind, shop_id, shop_name, token_id, kitchen_id, action, details)
  values (p_user_id, 'owner', v_shop.id, v_shop.business_name, v_token.id, p_user_id, 'claimed',
          pg_catalog.jsonb_build_object(
            'acknowledged_terms_at', v_ack,
            'user_agent', v_ua,
            'privacy_policy_version', v_version,
            'cook_application_id', v_app_id,
            'menu_items', v_items));

  insert into public.assisted_claim_attempts (client_key, kind, result) values (p_client_key, 'claim', 'ok');

  return pg_catalog.jsonb_build_object('status', 'ok', 'kitchen_id', p_user_id, 'acknowledged_terms_at', v_ack);
end;
$$;

revoke all on function public.assisted_claim_rate_limited(text) from public, anon, authenticated, service_role;
revoke all on function public.assisted_claim_token_state(public.assisted_claim_tokens, text) from public, anon, authenticated, service_role;
revoke all on function public.assisted_claim_preview(text, text) from public, anon, authenticated, service_role;
revoke all on function public.assisted_claim_complete(text, text, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.assisted_claim_preview(text, text) to service_role;
grant execute on function public.assisted_claim_complete(text, text, uuid, text, text) to service_role;


-- ----------------------------------------------------------------------------
-- 8. PHOTOS: HQ uploads draft photos to kitchen-photos/assisted/<shop_id>/
-- <uuid>.<ext>, insert only, while the draft is open. The public URL is
-- stored on the draft and copied as-is at claim. The existing kitchen photo
-- policies are unchanged ("assisted" is never a kitchen id).
-- ----------------------------------------------------------------------------
drop policy if exists "Admins can upload assisted shop photos" on storage.objects;
create policy "Admins can upload assisted shop photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'kitchen-photos'
    and public.user_has_role('admin')
    and (storage.foldername(name))[1] = 'assisted'
    and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
    and exists (
      select 1 from public.assisted_shops s
      where s.id::text = (storage.foldername(name))[2] and s.status = 'draft'
    )
  );


-- ----------------------------------------------------------------------------
-- 9. CHECKS AFTER. Otherwise roll back.
-- ----------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- The HQ guard and the terms trigger are exactly as before.
  if md5(pg_get_functiondef('public.guard_admin_kitchen_edit()'::regprocedure))
       <> current_setting('kb_assist.guard_md5') then
    raise exception 'Stopped: guard_admin_kitchen_edit changed';
  end if;
  if md5(pg_get_functiondef('public.stamp_kitchen_terms_acknowledgement()'::regprocedure))
       <> current_setting('kb_assist.terms_md5') then
    raise exception 'Stopped: stamp_kitchen_terms_acknowledgement changed';
  end if;

  -- Every function this script made is SECURITY DEFINER-safe: a fixed,
  -- empty search_path.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'guard_assisted_shop', 'guard_assisted_shop_item', 'audit_assisted_onboarding_row',
      'assisted_onboarding_audit_append_only', 'admin_issue_assisted_claim_link',
      'admin_mark_assisted_claim_link_sent', 'admin_revoke_assisted_claim_link',
      'admin_cancel_assisted_shop', 'admin_list_assisted_claim_links',
      'assisted_claim_rate_limited', 'assisted_claim_token_state',
      'assisted_claim_preview', 'assisted_claim_complete')
    and not coalesce('search_path=""' = any (p.proconfig), false);
  if v_bad is not null then
    raise exception 'Stopped: function(s) without search_path = '''': %', v_bad;
  end if;

  -- Nobody but service_role can run the claim functions; anon nothing at all.
  if has_function_privilege('anon', 'public.assisted_claim_complete(text, text, uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.assisted_claim_complete(text, text, uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.assisted_claim_preview(text, text)', 'execute')
     or has_function_privilege('anon', 'public.admin_issue_assisted_claim_link(uuid, text)', 'execute') then
    raise exception 'Stopped: claim or admin functions are executable by the wrong role';
  end if;

  -- No one reads token hashes through the API.
  if has_table_privilege('authenticated', 'public.assisted_claim_tokens', 'select')
     or has_table_privilege('anon', 'public.assisted_claim_tokens', 'select')
     or has_table_privilege('service_role', 'public.assisted_claim_tokens', 'select')
     or has_column_privilege('authenticated', 'public.assisted_claim_tokens', 'token_hash', 'select') then
    raise exception 'Stopped: assisted_claim_tokens is readable through the API';
  end if;

  -- HQ can't write the database-only draft columns.
  if has_column_privilege('authenticated', 'public.assisted_shops', 'status', 'update')
     or has_column_privilege('authenticated', 'public.assisted_shops', 'claimed_user_id', 'update')
     or has_column_privilege('authenticated', 'public.assisted_shops', 'acknowledged_at', 'insert') then
    raise exception 'Stopped: HQ could write a database-only assisted_shops column';
  end if;
end;
$$;

commit;
