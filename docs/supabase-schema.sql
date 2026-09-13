-- ============================================================================
-- KOPI BOY 2.0 — Feature #002: Auth + Roles
-- Run this ONCE in your Supabase project's SQL Editor (Dashboard > SQL Editor
-- > New query > paste this whole file > Run).
--
-- Safe to re-run: every statement below is idempotent (CREATE TABLE IF NOT
-- EXISTS, DROP POLICY/TRIGGER IF EXISTS before CREATE, CREATE OR REPLACE for
-- functions, IF EXISTS/IF NOT EXISTS on ALTER statements). Running this whole
-- file again on a database that already has some or all of it is safe.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PROFILES
-- One row per authenticated user. Created automatically on signup via the
-- trigger at the bottom of this file — never insert into this table directly
-- from the app.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'customer' check (role in ('customer', 'cook', 'rider', 'admin')),
  full_name text,
  phone text,
  -- Admin on/off switch for cooks and riders (section 16/21 of the handover
  -- doc — "temporary block", "suspend/reinstate"). Customers and admins are
  -- always active; this only matters for cook/rider rows.
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Users can update their own row, but a trigger (below) silently protects
-- role/is_active from being changed by anyone except an admin — otherwise
-- this policy alone would let a user grant themselves admin access.
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

drop policy if exists "Admins can read every profile" on public.profiles;
create policy "Admins can read every profile"
  on public.profiles for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "Admins can update every profile" on public.profiles;
create policy "Admins can update every profile"
  on public.profiles for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ----------------------------------------------------------------------------
-- 2. COOK APPLICATIONS
-- Section 20 of the handover doc: register -> submit -> review -> approve/reject.
-- ----------------------------------------------------------------------------
create table if not exists public.cook_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  business_type text, -- e.g. "Home Cook", "Hawker", "Bakery", "Small Business"
  description text,
  neighbourhood text,
  paynow_uen text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.cook_applications enable row level security;

drop policy if exists "Applicants can read their own cook application" on public.cook_applications;
create policy "Applicants can read their own cook application"
  on public.cook_applications for select
  using (auth.uid() = user_id);

drop policy if exists "Applicants can submit a cook application" on public.cook_applications;
create policy "Applicants can submit a cook application"
  on public.cook_applications for insert
  with check (auth.uid() = user_id);

drop policy if exists "Admins can read every cook application" on public.cook_applications;
create policy "Admins can read every cook application"
  on public.cook_applications for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "Admins can update every cook application" on public.cook_applications;
create policy "Admins can update every cook application"
  on public.cook_applications for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ----------------------------------------------------------------------------
-- 3. RIDER APPLICATIONS
-- Section 10/21: free registration, but must be approved before accepting
-- deliveries.
-- ----------------------------------------------------------------------------
create table if not exists public.rider_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_type text, -- e.g. "Bicycle", "Motorcycle", "Car"
  license_plate text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.rider_applications enable row level security;

drop policy if exists "Applicants can read their own rider application" on public.rider_applications;
create policy "Applicants can read their own rider application"
  on public.rider_applications for select
  using (auth.uid() = user_id);

drop policy if exists "Applicants can submit a rider application" on public.rider_applications;
create policy "Applicants can submit a rider application"
  on public.rider_applications for insert
  with check (auth.uid() = user_id);

drop policy if exists "Admins can read every rider application" on public.rider_applications;
create policy "Admins can read every rider application"
  on public.rider_applications for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "Admins can update every rider application" on public.rider_applications;
create policy "Admins can update every rider application"
  on public.rider_applications for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ----------------------------------------------------------------------------
-- 4. AUTO-CREATE A PROFILE ROW ON SIGNUP
-- Runs every time someone signs up (Google or email OTP). Defaults everyone
-- to role = 'customer' — cooks/riders upgrade their own role only via an
-- approved application (handled in application-approval logic later, Feature
-- #003), never by editing their own profile row directly.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 5. PROTECT role AND is_active FROM SELF-EDITING
-- The "Users can update their own profile" policy above allows a user to
-- update their own row (needed for e.g. changing their name/phone) — but
-- without this trigger, that same policy would let a user set their own
-- role to 'admin' or flip their own is_active flag. This trigger silently
-- reverts those two columns to their previous value unless the person
-- making the change is already an admin.
-- ----------------------------------------------------------------------------
create or replace function public.protect_profile_privileges()
returns trigger as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    new.role := old.role;
    new.is_active := old.is_active;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists before_profile_update on public.profiles;
create trigger before_profile_update
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();


-- ============================================================================
-- KOPI BOY 2.0 — Feature #003: Merchant Onboarding (Kitchen + Menu)
-- Run this ONCE, after the Feature #002 script above, in the same Supabase
-- project's SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 6. KITCHENS
-- One row per approved cook — the merchant-facing profile shown in the
-- Customer app marketplace. Created/edited by the cook themselves via the
-- Partner app's kitchen setup screen, not by HQ. id = the cook's own
-- profiles.id (one kitchen per cook).
-- ----------------------------------------------------------------------------
create table if not exists public.kitchens (
  id uuid primary key references public.profiles(id) on delete cascade,
  business_name text not null,
  category text not null check (category in ('home-cook', 'hawker', 'bakery', 'bulk-orders', 'drinks')),
  cuisine_type text not null check (cuisine_type in ('chinese', 'halal', 'indian', 'western')),
  neighbourhood text not null,
  description text,
  hero_image text, -- optional per the handover doc ("a food photo is optional"); Customer app falls back to a category image when null
  is_live boolean not null default false, -- flips true once the cook has saved at least one menu item (enforced in app logic, not here)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.kitchens enable row level security;

drop policy if exists "Cooks can read their own kitchen" on public.kitchens;
create policy "Cooks can read their own kitchen"
  on public.kitchens for select
  using (auth.uid() = id);

drop policy if exists "Cooks can insert their own kitchen" on public.kitchens;
create policy "Cooks can insert their own kitchen"
  on public.kitchens for insert
  with check (auth.uid() = id and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'cook'));

drop policy if exists "Cooks can update their own kitchen" on public.kitchens;
create policy "Cooks can update their own kitchen"
  on public.kitchens for update
  using (auth.uid() = id);

drop policy if exists "Anyone can read live kitchens" on public.kitchens;
create policy "Anyone can read live kitchens"
  on public.kitchens for select
  using (is_live = true);

drop policy if exists "Admins can read every kitchen" on public.kitchens;
create policy "Admins can read every kitchen"
  on public.kitchens for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ----------------------------------------------------------------------------
-- 7. MENU ITEMS
-- Section: "menu items and price tags are mandatory; a food photo is
-- optional." One row per dish. The Partner app replaces all of a kitchen's
-- rows on every save (see KitchenSetupForm) rather than diffing — simplest
-- correct approach for this feature's scope.
-- ----------------------------------------------------------------------------
create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens(id) on delete cascade,
  name text not null,
  price numeric(6,2) not null check (price > 0),
  photo_url text,
  created_at timestamptz not null default now()
);

alter table public.menu_items enable row level security;

drop policy if exists "Cooks can manage their own menu items" on public.menu_items;
create policy "Cooks can manage their own menu items"
  on public.menu_items for all
  using (auth.uid() = kitchen_id)
  with check (auth.uid() = kitchen_id);

drop policy if exists "Anyone can read menu items of a live kitchen" on public.menu_items;
create policy "Anyone can read menu items of a live kitchen"
  on public.menu_items for select
  using (exists (select 1 from public.kitchens k where k.id = menu_items.kitchen_id and k.is_live = true));

-- ----------------------------------------------------------------------------
-- 8. KEEP updated_at CURRENT ON KITCHENS
-- ----------------------------------------------------------------------------
create or replace function public.touch_kitchen_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists before_kitchen_update on public.kitchens;
create trigger before_kitchen_update
  before update on public.kitchens
  for each row execute function public.touch_kitchen_updated_at();


-- ============================================================================
-- KOPI BOY 2.0 — Picker role (optional pickup helper for riders)
-- Run this ONCE, after the Feature #002 and #003 scripts above, in the same
-- Supabase project's SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 9. ALLOW 'picker' AS A PROFILE ROLE
-- Postgres won't let you edit a check constraint in place, so it's
-- drop-and-recreate. If this fails because your constraint has a different
-- auto-generated name, find it first with:
--   select conname from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'c';
-- ----------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('customer', 'cook', 'rider', 'picker', 'admin'));

-- ----------------------------------------------------------------------------
-- 10. PICKER APPLICATIONS
-- Same register -> submit -> review -> approve/reject pattern as cook/rider
-- applications. Deliberately minimal fields — this role is meant for
-- students/anyone nearby wanting casual pocket money, not a vetted fleet.
-- ----------------------------------------------------------------------------
create table if not exists public.picker_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note text, -- optional: why they want to pick up orders, anything relevant
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.picker_applications enable row level security;

drop policy if exists "Applicants can read their own picker application" on public.picker_applications;
create policy "Applicants can read their own picker application"
  on public.picker_applications for select
  using (auth.uid() = user_id);

drop policy if exists "Applicants can submit a picker application" on public.picker_applications;
create policy "Applicants can submit a picker application"
  on public.picker_applications for insert
  with check (auth.uid() = user_id);

drop policy if exists "Admins can read every picker application" on public.picker_applications;
create policy "Admins can read every picker application"
  on public.picker_applications for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "Admins can update every picker application" on public.picker_applications;
create policy "Admins can update every picker application"
  on public.picker_applications for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ----------------------------------------------------------------------------
-- 11. PICKUP REQUESTS
-- The rider-initiated, picker-fulfilled handshake described in the picker
-- workflow: rider requests a picker for a specific kitchen pickup -> any
-- approved picker can accept -> picker collects from the cook -> picker
-- hands off to the rider and marks it complete. Payment (rider pays picker)
-- happens off-platform, same as every other money leg in Kopi Boy —
-- suggested_fee is a default the app shows, not an enforced amount.
--
-- NOTE: not yet linked to a real orders/deliveries table since #005/#006/#008
-- haven't shipped. kitchen_id is enough to make the full accept/collect/
-- handoff loop testable now; link it to a real delivery_id once that table
-- exists.
-- ----------------------------------------------------------------------------
create table if not exists public.pickup_requests (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.profiles(id) on delete cascade,
  kitchen_id uuid not null references public.kitchens(id) on delete cascade,
  picker_id uuid references public.profiles(id),
  status text not null default 'open' check (status in ('open', 'accepted', 'completed', 'cancelled')),
  suggested_fee numeric(5,2) not null default 2.00,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  completed_at timestamptz
);

alter table public.pickup_requests enable row level security;

drop policy if exists "Riders can create their own pickup requests" on public.pickup_requests;
create policy "Riders can create their own pickup requests"
  on public.pickup_requests for insert
  with check (auth.uid() = rider_id);

drop policy if exists "Riders can read their own pickup requests" on public.pickup_requests;
create policy "Riders can read their own pickup requests"
  on public.pickup_requests for select
  using (auth.uid() = rider_id);

drop policy if exists "Riders can cancel their own open pickup requests" on public.pickup_requests;
create policy "Riders can cancel their own open pickup requests"
  on public.pickup_requests for update
  using (auth.uid() = rider_id and status = 'open')
  with check (auth.uid() = rider_id and status = 'cancelled');

drop policy if exists "Pickers can read open pickup requests" on public.pickup_requests;
create policy "Pickers can read open pickup requests"
  on public.pickup_requests for select
  using (
    status = 'open'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'picker')
  );

drop policy if exists "Pickers can read their assigned pickup requests" on public.pickup_requests;
create policy "Pickers can read their assigned pickup requests"
  on public.pickup_requests for select
  using (auth.uid() = picker_id);

drop policy if exists "Pickers can accept an open pickup request" on public.pickup_requests;
create policy "Pickers can accept an open pickup request"
  on public.pickup_requests for update
  using (
    status = 'open'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'picker')
  )
  with check (picker_id = auth.uid() and status = 'accepted');

drop policy if exists "Pickers can complete their assigned pickup request" on public.pickup_requests;
create policy "Pickers can complete their assigned pickup request"
  on public.pickup_requests for update
  using (auth.uid() = picker_id)
  with check (auth.uid() = picker_id);

drop policy if exists "Admins can read every pickup request" on public.pickup_requests;
create policy "Admins can read every pickup request"
  on public.pickup_requests for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "Admins can update every pickup request" on public.pickup_requests;
create policy "Admins can update every pickup request"
  on public.pickup_requests for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));


-- ============================================================================
-- KOPI BOY 2.0 — Feature #005: Cart + Order Creation
-- Run this ONCE, after the Feature #002/#003 and picker-role scripts above,
-- in the same Supabase project's SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 12. ORDERS
-- One row per placed order. The app's checkout server action re-fetches real
-- menu_items prices and computes subtotal itself — never trust a
-- client-supplied total. No delivery_fee column yet — that's #007;
-- subtotal is the whole total until then.
--
-- order_status and payment_status are deliberately separate columns, per
-- the locked business rule that order/payment/preparation/delivery/incident
-- are separate status fields, not one combined enum (see docs/feature-001.md).
-- Feature #006 (cook accept/reject + PayNow) is what actually moves these:
-- a cook accepts/rejects (order_status), then separately marks payment_status
-- 'paid' once they've received the PayNow transfer off-platform — same
-- trust-based, no-in-app-gateway pattern already used for rider-pays-picker.
-- ----------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  kitchen_id uuid not null references public.kitchens(id) on delete cascade,
  order_status text not null default 'placed' check (order_status in ('placed', 'accepted', 'rejected')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  subtotal numeric(7,2) not null check (subtotal > 0),
  decided_at timestamptz, -- set when order_status moves to accepted/rejected
  paid_at timestamptz, -- set when payment_status moves to paid
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;

drop policy if exists "Customers can create their own orders" on public.orders;
create policy "Customers can create their own orders"
  on public.orders for insert
  with check (auth.uid() = customer_id);

drop policy if exists "Customers can read their own orders" on public.orders;
create policy "Customers can read their own orders"
  on public.orders for select
  using (auth.uid() = customer_id);

drop policy if exists "Cooks can read orders placed at their kitchen" on public.orders;
create policy "Cooks can read orders placed at their kitchen"
  on public.orders for select
  using (auth.uid() = kitchen_id);

-- Transition rules (can't decide an already-decided order, can't mark paid
-- before accepted) are enforced by the app's update calls including the
-- expected current state in their WHERE clause, not by this policy — same
-- "first to accept wins" level of rigor already used for pickup_requests.
drop policy if exists "Cooks can update orders placed at their kitchen" on public.orders;
create policy "Cooks can update orders placed at their kitchen"
  on public.orders for update
  using (auth.uid() = kitchen_id)
  with check (auth.uid() = kitchen_id);

drop policy if exists "Admins can read every order" on public.orders;
create policy "Admins can read every order"
  on public.orders for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ----------------------------------------------------------------------------
-- 13. ORDER ITEMS
-- One row per line item. name/price are snapshotted at order time (copied
-- from menu_items, not joined live) so a later menu edit or deletion never
-- rewrites what a customer actually ordered and was charged for. The Partner
-- app's KitchenSetupForm replaces a kitchen's menu_items wholesale on every
-- save, so menu_item_id is set null (not cascaded) if the original row is
-- gone — the snapshot is what matters for order history.
-- ----------------------------------------------------------------------------
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  name text not null,
  price numeric(6,2) not null check (price > 0),
  quantity int not null check (quantity > 0)
);

alter table public.order_items enable row level security;

drop policy if exists "Customers can create items on their own orders" on public.order_items;
create policy "Customers can create items on their own orders"
  on public.order_items for insert
  with check (
    exists (select 1 from public.orders o where o.id = order_items.order_id and o.customer_id = auth.uid())
  );

drop policy if exists "Customers can read items on their own orders" on public.order_items;
create policy "Customers can read items on their own orders"
  on public.order_items for select
  using (
    exists (select 1 from public.orders o where o.id = order_items.order_id and o.customer_id = auth.uid())
  );

drop policy if exists "Cooks can read items on orders placed at their kitchen" on public.order_items;
create policy "Cooks can read items on orders placed at their kitchen"
  on public.order_items for select
  using (
    exists (select 1 from public.orders o where o.id = order_items.order_id and o.kitchen_id = auth.uid())
  );

drop policy if exists "Admins can read every order item" on public.order_items;
create policy "Admins can read every order item"
  on public.order_items for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));


-- ============================================================================
-- KOPI BOY 2.0 — Feature #006: Cook Accept/Reject + PayNow
-- Run this ONCE, after every script above, in the same Supabase project's
-- SQL Editor. (The order_status/payment_status split lives inside the #005
-- section above rather than as an ALTER here, since that migration hadn't
-- been run anywhere yet when #006 started.)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 14. PAYNOW DETAILS ON KITCHENS
-- Previously only captured once on cook_applications (immutable after that
-- one-time form). Moved to kitchens — the live, cook-editable merchant
-- profile — so a customer has somewhere current to read it from once their
-- order is accepted, and a cook can update it later via the Partner app's
-- KitchenSetupForm. Backfilled below from each cook's most recently
-- approved application; the existing "Cooks can update their own kitchen" /
-- "Anyone can read live kitchens" policies already cover this column, no
-- new RLS needed.
-- ----------------------------------------------------------------------------
alter table public.kitchens add column if not exists paynow_uen text;

update public.kitchens k
set paynow_uen = (
  select ca.paynow_uen
  from public.cook_applications ca
  where ca.user_id = k.id and ca.status = 'approved'
  order by ca.reviewed_at desc nulls last
  limit 1
)
where k.paynow_uen is null;
