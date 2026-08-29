-- ============================================================================
-- KOPI BOY 2.0 — Feature #002: Auth + Roles
-- Run this ONCE in your Supabase project's SQL Editor (Dashboard > SQL Editor
-- > New query > paste this whole file > Run).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PROFILES
-- One row per authenticated user. Created automatically on signup via the
-- trigger at the bottom of this file — never insert into this table directly
-- from the app.
-- ----------------------------------------------------------------------------
create table public.profiles (
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

create policy "Users can read their own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Users can update their own row, but a trigger (below) silently protects
-- role/is_active from being changed by anyone except an admin — otherwise
-- this policy alone would let a user grant themselves admin access.
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Admins can read every profile"
  on public.profiles for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

create policy "Admins can update every profile"
  on public.profiles for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ----------------------------------------------------------------------------
-- 2. COOK APPLICATIONS
-- Section 20 of the handover doc: register -> submit -> review -> approve/reject.
-- ----------------------------------------------------------------------------
create table public.cook_applications (
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

create policy "Applicants can read their own cook application"
  on public.cook_applications for select
  using (auth.uid() = user_id);

create policy "Applicants can submit a cook application"
  on public.cook_applications for insert
  with check (auth.uid() = user_id);

create policy "Admins can read every cook application"
  on public.cook_applications for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

create policy "Admins can update every cook application"
  on public.cook_applications for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ----------------------------------------------------------------------------
-- 3. RIDER APPLICATIONS
-- Section 10/21: free registration, but must be approved before accepting
-- deliveries.
-- ----------------------------------------------------------------------------
create table public.rider_applications (
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

create policy "Applicants can read their own rider application"
  on public.rider_applications for select
  using (auth.uid() = user_id);

create policy "Applicants can submit a rider application"
  on public.rider_applications for insert
  with check (auth.uid() = user_id);

create policy "Admins can read every rider application"
  on public.rider_applications for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

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
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

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
create function public.protect_profile_privileges()
returns trigger as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    new.role := old.role;
    new.is_active := old.is_active;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger before_profile_update
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();
