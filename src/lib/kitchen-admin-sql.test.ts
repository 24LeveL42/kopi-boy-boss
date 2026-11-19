import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { friendlyKitchenError, KITCHEN_SAVE_COLUMNS } from "./kitchen-admin.ts";

/**
 * HQ edits a kitchen, run for real in PGlite:
 *   docs/supabase-kitchen-admin-edit.sql            (installed on live, rev 5)
 *   docs/supabase-kitchen-admin-edit-live-test.sql  (the live rollback-only test)
 * on top of a harness with the Partner tables and triggers the guard sits in
 * front of, copied from the Partner repo's docs/supabase-schema.sql
 * (sections 5-8, 15, 27-29, 31-33): business_uen, public location, the
 * partner terms stamp and touch_kitchen_updated_at, plus the live column
 * grants (no SELECT on PayNow, lat/lng, terms stamp, opening hours).
 *
 * Three live triggers are in no repo (region, live_since, the is_blocked
 * copy from profiles.is_active). They are stand-ins here with the same shape:
 * SECURITY DEFINER, region/live_since as BEFORE triggers that sort after
 * a_kitchen_admin_guard, is_blocked as an UPDATE from a profiles trigger.
 */

const read = (p: string) => readFileSync(new URL(`../../docs/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SCRIPT = read("supabase-kitchen-admin-edit.sql");
const LIVE_TEST = read("supabase-kitchen-admin-edit-live-test.sql");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = id(900);
const COOK = id(1); // "TEST Parata": acknowledged, address, one item
const OTHER = id(2); // another merchant, live
const LEGACY = id(3); // predates the terms tick: acknowledged_terms_at is null
const CUSTOMER = id(4);

/** Public kitchens columns a signed-in user may SELECT (live column grants). */
const PUBLIC_KITCHEN_COLUMNS =
  "id, business_name, category, cuisine_type, neighbourhood, description, hero_image, is_live, created_at, updated_at, business_uen, postal_sector, is_halal, is_blocked, region, live_since";

const HARNESS = `
create role anon;
create role authenticated;
create schema auth;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant execute on function auth.uid() to anon, authenticated;

-- 1 + 5. PROFILES
create table public.profiles (
  id uuid primary key,
  full_name text,
  role text not null default 'customer',
  is_active boolean not null default true
);
create or replace function public.user_has_role(check_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = check_role);
$$;
alter table public.profiles enable row level security;
grant select, update on public.profiles to authenticated;
create policy "Users can read their own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update their own profile" on public.profiles for update using (auth.uid() = id);
create policy "Admins can read every profile" on public.profiles for select using (public.user_has_role('admin'));
create policy "Admins can update every profile" on public.profiles for update using (public.user_has_role('admin'));
create or replace function public.protect_profile_privileges()
returns trigger as $$
begin
  if auth.uid() is not null and not public.user_has_role('admin') then
    new.role := old.role;
    new.is_active := old.is_active;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
create trigger before_profile_update before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- 2 + 26. COOK APPLICATIONS (just what the business_uen sync reads)
create table public.cook_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  business_name text not null,
  business_uen text,
  status text not null default 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.cook_applications enable row level security;
grant select, update on public.cook_applications to authenticated;
create policy "Admins can read every cook application" on public.cook_applications for select using (public.user_has_role('admin'));
create policy "Admins can update every cook application" on public.cook_applications for update using (public.user_has_role('admin'));

-- 6, 14, 17, 19, 27, 29, 31-33. KITCHENS as they are live
create table public.kitchens (
  id uuid primary key references public.profiles(id) on delete cascade,
  business_name text not null,
  category text not null check (category in ('home-cook', 'hawker', 'bakery', 'vegetarian', 'drinks-desserts')),
  cuisine_type text not null check (cuisine_type in ('chinese', 'halal', 'indian', 'western')),
  neighbourhood text not null default '',
  description text,
  hero_image text,
  is_live boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paynow_type text check (paynow_type in ('mobile', 'uen')),
  paynow_value text,
  latitude numeric,
  longitude numeric,
  business_uen text,
  postal_sector text check (postal_sector ~ '^[0-9]{2}$'),
  is_halal boolean not null default false,
  acknowledged_terms_at timestamptz,
  is_blocked boolean not null default false,
  region text,
  live_since timestamptz
);
alter table public.kitchens enable row level security;
grant insert, update on public.kitchens to authenticated;
grant select (${PUBLIC_KITCHEN_COLUMNS}) on public.kitchens to anon, authenticated;
create policy "Cooks can read their own kitchen" on public.kitchens for select using (auth.uid() = id);
create policy "Cooks can insert their own kitchen" on public.kitchens for insert
  with check (auth.uid() = id and public.user_has_role('cook'));
create policy "Cooks can update their own kitchen" on public.kitchens for update using (auth.uid() = id);
create policy "Anyone can read live kitchens" on public.kitchens for select using (is_live = true);
create policy "Admins can read every kitchen" on public.kitchens for select using (public.user_has_role('admin'));

-- 7. MENU ITEMS (+ the live admin delete used by "Delete test partner")
create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens(id) on delete cascade,
  name text not null,
  price numeric(6,2) not null check (price > 0),
  photo_url text,
  created_at timestamptz not null default now()
);
alter table public.menu_items enable row level security;
grant select, insert, update, delete on public.menu_items to authenticated;
grant select on public.menu_items to anon;
create policy "Cooks can manage their own menu items" on public.menu_items for all
  using (auth.uid() = kitchen_id) with check (auth.uid() = kitchen_id);
create policy "Anyone can read menu items of a live kitchen" on public.menu_items for select
  using (exists (select 1 from public.kitchens k where k.id = menu_items.kitchen_id and k.is_live = true));
create policy "Admins can delete menu items" on public.menu_items for delete using (public.user_has_role('admin'));

-- 8. updated_at
create or replace function public.touch_kitchen_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;
create trigger before_kitchen_update before update on public.kitchens
  for each row execute function public.touch_kitchen_updated_at();

-- 27. business_uen
create or replace function public.approved_business_uen(p_user_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select ca.business_uen from public.cook_applications ca
  where ca.user_id = p_user_id and ca.status = 'approved'
  order by ca.reviewed_at desc nulls last, ca.created_at desc limit 1;
$$;
create or replace function public.set_kitchen_business_uen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.business_uen := public.approved_business_uen(new.id);
  return new;
end;
$$;
create trigger before_kitchen_business_uen before insert or update on public.kitchens
  for each row execute function public.set_kitchen_business_uen();
create or replace function public.sync_kitchen_business_uen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.kitchens set business_uen = null where id = new.user_id;
  return new;
end;
$$;
create trigger after_cook_application_review after update of status on public.cook_applications
  for each row when (old.status is distinct from new.status) execute function public.sync_kitchen_business_uen();

-- 28 + 29. private address, public coarse location
create table public.kitchen_addresses (
  kitchen_id uuid primary key references public.kitchens(id) on delete cascade,
  business_address text,
  postal_code text,
  latitude numeric,
  longitude numeric
);
alter table public.kitchen_addresses enable row level security;
grant select, insert, update on public.kitchen_addresses to authenticated;
create policy "Cooks manage their own address" on public.kitchen_addresses for all
  using (auth.uid() = kitchen_id) with check (auth.uid() = kitchen_id);
create policy "Admins can read every kitchen address" on public.kitchen_addresses for select using (public.user_has_role('admin'));
create or replace function public.set_kitchen_public_location()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  loc record;
begin
  select latitude, longitude, postal_code into loc from public.kitchen_addresses where kitchen_id = new.id;
  new.latitude := round(loc.latitude, 3);
  new.longitude := round(loc.longitude, 3);
  new.postal_sector := left(loc.postal_code, 2);
  return new;
end;
$$;
create trigger before_kitchen_public_location before insert or update on public.kitchens
  for each row execute function public.set_kitchen_public_location();
create or replace function public.sync_kitchen_public_location()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.kitchens set postal_sector = null where id = new.kitchen_id;
  return new;
end;
$$;
create trigger after_kitchen_address_change after insert or update of postal_code, latitude, longitude on public.kitchen_addresses
  for each row execute function public.sync_kitchen_public_location();

-- 33. partner terms
create or replace function public.stamp_kitchen_terms_acknowledgement()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.acknowledged_terms_at is not null then
    new.acknowledged_terms_at := old.acknowledged_terms_at;
  elsif new.acknowledged_terms_at is not null then
    new.acknowledged_terms_at := now();
  elsif tg_op = 'INSERT' then
    raise exception 'Please acknowledge the Kopi Boy partner terms before setting up your kitchen.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger before_kitchen_terms_acknowledgement before insert or update on public.kitchens
  for each row execute function public.stamp_kitchen_terms_acknowledgement();

-- Live-only stand-ins (region, live_since, is_blocked)
create or replace function public.set_kitchen_region()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.region := case when new.postal_sector is null then null when new.postal_sector < '50' then 'south' else 'east' end;
  return new;
end;
$$;
create trigger before_kitchen_region before insert or update on public.kitchens
  for each row execute function public.set_kitchen_region();
create or replace function public.stamp_kitchen_live_since()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.live_since := case when tg_op = 'UPDATE' then old.live_since end;
  if new.is_live and new.live_since is null then new.live_since := now(); end if;
  return new;
end;
$$;
create trigger before_kitchen_live_since before insert or update on public.kitchens
  for each row execute function public.stamp_kitchen_live_since();
create or replace function public.set_kitchen_is_blocked()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.kitchens set is_blocked = not new.is_active
  where id = new.id and is_blocked is distinct from not new.is_active;
  return new;
end;
$$;
create trigger after_profile_is_active after update of is_active on public.profiles
  for each row when (old.is_active is distinct from new.is_active) execute function public.set_kitchen_is_blocked();

-- 15. kitchen-photos bucket (only what the policies need)
create schema storage;
grant usage on schema storage to anon, authenticated;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null
);
alter table storage.objects enable row level security;
grant select, insert on storage.objects to anon, authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
create function storage.extension(name text) returns text language sql immutable as $$
  select reverse(split_part(reverse(split_part(name, '/', -1)), '.', 1))
$$;
grant execute on function storage.foldername(text), storage.extension(text) to anon, authenticated;
create policy "Anyone can view kitchen photos" on storage.objects for select using (bucket_id = 'kitchen-photos');
create policy "Cooks can upload their own kitchen photos" on storage.objects for insert
  with check (bucket_id = 'kitchen-photos' and (storage.foldername(name))[1] = auth.uid()::text);
`;

const SEED = `
insert into public.profiles (id, full_name, role) values
  ('${ADMIN}', 'HQ Admin', 'admin'),
  ('${COOK}', 'Parata Cook', 'cook'),
  ('${OTHER}', 'Other Cook', 'cook'),
  ('${LEGACY}', 'Legacy Cook', 'cook'),
  ('${CUSTOMER}', 'A Customer', 'customer');
insert into public.cook_applications (user_id, business_name, business_uen, status, reviewed_at) values
  ('${COOK}', 'TEST Parata', '53123456A', 'approved', now());
insert into public.kitchens (id, business_name, category, cuisine_type, description, is_live, acknowledged_terms_at) values
  ('${COOK}', 'TEST Parata', 'home-cook', 'indian', 'Prata', true, now()),
  ('${OTHER}', 'Other Kitchen', 'hawker', 'chinese', 'Noodles', true, now());
update public.kitchens set paynow_type = 'mobile', paynow_value = '87654321' where id = '${COOK}';
insert into public.kitchen_addresses (kitchen_id, business_address, postal_code, latitude, longitude) values
  ('${COOK}', '1 Test Road', '520123', 1.35321, 103.94432),
  ('${OTHER}', '2 Other Road', '310456', 1.33, 103.85);
insert into public.menu_items (kitchen_id, name, price) values
  ('${COOK}', 'Egg prata', 2.50),
  ('${OTHER}', 'Wanton mee', 5.00);
-- A kitchen from before the terms tick existed: no stamp, not live.
set session_replication_role = replica;
insert into public.kitchens (id, business_name, category, cuisine_type, is_live) values
  ('${LEGACY}', 'Legacy Kitchen', 'bakery', 'western', false);
insert into public.kitchen_addresses (kitchen_id, postal_code) values ('${LEGACY}', '600123');
insert into public.menu_items (kitchen_id, name, price) values ('${LEGACY}', 'Bun', 1.20);
set session_replication_role = origin;
`;

const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

/** Runs fn as a signed-in user (or anon when uid is null) in a transaction that always rolls back. */
async function as<T>(db: PGlite, uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" }),
    ]);
    await db.exec(uid ? "set local role authenticated" : "set local role anon");
    return await fn();
  } finally {
    await db.exec("rollback");
  }
}

/** The error message, or "" if it worked. */
async function attempt(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

/** An attempt inside a savepoint, so the surrounding test transaction keeps going. */
async function tryStep(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  await db.exec("savepoint s");
  const message = await attempt(db, sql, params);
  await db.exec(message ? "rollback to savepoint s" : "release savepoint s");
  return message;
}

type KitchenRow = Record<string, unknown>;
const kitchen = async (db: PGlite, kid: string) =>
  (await rows<KitchenRow>(db, "select to_jsonb(k) as k from public.kitchens k where id = $1", [kid]))[0]?.k as KitchenRow;
/** updated_at, readable by a signed-in user (to_jsonb(k) is not: private columns). */
const stampOf = async (db: PGlite, kid: string) =>
  (await rows<{ updated_at: string }>(db, "select updated_at from public.kitchens where id = $1", [kid]))[0].updated_at;
const auditCount = async (db: PGlite) => Number((await rows<{ n: number }>(db, "select count(*)::int as n from public.kitchen_admin_audit"))[0].n);

/** What Boss's saveKitchenProfileWith sends, as SQL. */
const PROFILE_UPDATE = `update public.kitchens
  set business_name = $2, category = $3, cuisine_type = $4, is_halal = $5, description = $6, hero_image = $7, is_live = $8
  where id = $1 and updated_at = $9 returning id, updated_at`;
const profileParams = (kid: string, stamp: string, over: Partial<Record<string, unknown>> = {}) => {
  const p = { business_name: "TEST Parata", category: "home-cook", cuisine_type: "indian", is_halal: true, description: "Prata", hero_image: null, is_live: true, ...over };
  return [kid, p.business_name, p.category, p.cuisine_type, p.is_halal, p.description, p.hero_image, p.is_live, stamp];
};

describe("kitchen admin edit SQL in PGlite", () => {
  let db: PGlite;
  before(async () => {
    db = new PGlite();
    await db.exec(HARNESS);
    await db.exec(SEED);
    await db.exec(SCRIPT);
  });
  after(() => db.close());

  it("installs: the guards sort before every existing BEFORE trigger and the audits are AFTER", async () => {
    const t = await rows<{ tgname: string; before: boolean }>(
      db,
      `select tgname, (tgtype & 2) = 2 as before from pg_trigger
       where tgrelid = 'public.kitchens'::regclass and not tgisinternal order by tgname`
    );
    assert.equal(t[0].tgname, "a_kitchen_admin_guard");
    assert.ok(t[0].before);
    assert.deepEqual(t.filter((r) => !r.before).map((r) => r.tgname), ["z_kitchen_admin_audit"]);
    const m = await rows<{ tgname: string }>(
      db,
      "select tgname from pg_trigger where tgrelid = 'public.menu_items'::regclass and not tgisinternal order by tgname"
    );
    assert.deepEqual(m.map((r) => r.tgname), ["a_menu_item_admin_guard", "before_menu_item_update", "z_menu_item_admin_audit"]);
  });

  it("the live test script passes here too, and leaves nothing behind", async () => {
    const before = await kitchen(db, COOK);
    const auditBefore = await auditCount(db);
    const script = LIVE_TEST.replaceAll("PUT-TEST-KITCHEN-ID", COOK).replaceAll("PUT-ADMIN-ID", ADMIN);
    const message = await db.exec(script).then(
      () => "",
      (e: Error) => e.message
    );
    await db.exec("rollback");
    assert.match(message, /^TEST OK, rolled back: /);
    assert.match(message, /terms from empty passed/);
    assert.deepEqual(await kitchen(db, COOK), before);
    assert.equal(await auditCount(db), auditBefore);
  });

  it("the live test refuses a kitchen whose name doesn't start with TEST", async () => {
    const script = LIVE_TEST.replaceAll("PUT-TEST-KITCHEN-ID", OTHER).replaceAll("PUT-ADMIN-ID", ADMIN);
    const message = await db.exec(script).then(
      () => "",
      (e: Error) => e.message
    );
    await db.exec("rollback");
    assert.match(message, /REFUSED: "Other Kitchen" is not a TEST kitchen/);
  });

  it("an HQ profile save (Boss's exact UPDATE) passes every existing trigger; system columns are untouched", async () => {
    const before = await kitchen(db, COOK);
    await as(db, ADMIN, async () => {
      const saved = await rows<{ id: string; updated_at: string }>(
        db,
        PROFILE_UPDATE,
        profileParams(COOK, before.updated_at as string, { description: "Fresh prata", is_halal: true })
      );
      assert.equal(saved.length, 1);
      await db.exec("reset role");
      const after = await kitchen(db, COOK);
      const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])).sort();
      assert.deepEqual(changed, ["description", "is_halal", "updated_at"]);
      for (const col of ["acknowledged_terms_at", "business_uen", "region", "postal_sector", "latitude", "longitude", "live_since", "is_blocked", "paynow_value"]) {
        assert.deepEqual(after[col], before[col], col);
      }
      const [audit] = await rows<{ action: string; changes: Record<string, unknown>; admin_id: string }>(
        db,
        "select action, changes, admin_id from public.kitchen_admin_audit where kitchen_id = $1",
        [COOK]
      );
      assert.equal(audit.action, "update");
      assert.equal(audit.admin_id, ADMIN);
      assert.deepEqual(Object.keys(audit.changes).sort(), ["description", "is_halal"]);
    });
  });

  it("stale edit: Boss's UPDATE with an old updated_at changes 0 rows", async () => {
    await as(db, ADMIN, async () => {
      const r = await rows(db, PROFILE_UPDATE, profileParams(COOK, "2020-01-01T00:00:00Z", { description: "stale" }));
      assert.equal(r.length, 0);
    });
  });

  it("the old Boss upsert is refused by the guard with its own message, before the terms trigger", async () => {
    await as(db, ADMIN, async () => {
      const message = await attempt(
        db,
        `insert into public.kitchens (id, business_name, category, cuisine_type, neighbourhood, description, hero_image, is_live)
         values ($1, 'TEST Parata', 'home-cook', 'indian', 'x', 'y', null, true)
         on conflict (id) do update set description = excluded.description`,
        [COOK]
      );
      assert.match(message, /^HQ cannot create or upsert a kitchen/);
      assert.match(friendlyKitchenError(message), /only edit an existing kitchen/);
    });
  });

  it("HQ can't stamp the terms: neither from empty (legacy kitchen) nor by changing an existing one", async () => {
    for (const [kid, sql] of [
      [LEGACY, "update public.kitchens set acknowledged_terms_at = now() where id = $1"],
      [COOK, "update public.kitchens set acknowledged_terms_at = now() + interval '1 day' where id = $1"],
    ] as const) {
      await as(db, ADMIN, async () => {
        const message = await attempt(db, sql, [kid]);
        assert.match(message, /^HQ cannot set or change the partner terms acknowledgement/);
        assert.match(friendlyKitchenError(message), /only the cook can accept/);
      });
    }
    const [legacy] = await rows<{ t: string | null }>(db, "select acknowledged_terms_at as t from public.kitchens where id = $1", [LEGACY]);
    assert.equal(legacy.t, null);
  });

  it("HQ can't write any column outside the allow-list", async () => {
    const forbidden: [string, string][] = [
      ["is_blocked", "true"],
      ["business_uen", "'X'"],
      ["region", "'north'"],
      ["live_since", "now()"],
      ["paynow_type", "'uen'"],
      ["paynow_value", "'99999999'"],
      ["neighbourhood", "'Somewhere'"],
      ["updated_at", "now() - interval '1 day'"],
      ["created_at", "now() - interval '1 day'"],
    ];
    for (const [col, value] of forbidden) {
      await as(db, ADMIN, async () => {
        const message = await attempt(db, `update public.kitchens set ${col} = ${value} where id = $1`, [COOK]);
        assert.match(message, new RegExp(`HQ cannot change ${col} on a kitchen|permission denied`), col);
      });
    }
  });

  it("Boss's save columns are exactly the allowed ones the guard lets through", async () => {
    const before = await kitchen(db, COOK);
    await as(db, ADMIN, async () => {
      for (const col of KITCHEN_SAVE_COLUMNS) {
        const value = { business_name: "'TEST Parata 2'", category: "'bakery'", cuisine_type: "'western'", is_halal: "not is_halal", description: "'d'", hero_image: "'https://x/y.jpg'", is_live: "is_live" }[col];
        assert.equal(await tryStep(db, `update public.kitchens set ${col} = ${value} where id = $1`, [COOK]), "", col);
      }
    });
    assert.deepEqual(await kitchen(db, COOK), before);
  });

  it("go-live: refused with clear messages for no terms, no visible item and blocked", async () => {
    // Legacy kitchen: no terms.
    await as(db, ADMIN, async () => {
      const message = await attempt(db, PROFILE_UPDATE, profileParams(LEGACY, await stampOf(db, LEGACY), { is_live: true, category: "bakery", cuisine_type: "western" }));
      assert.match(message, /can't go live until the cook accepts the partner terms/);
      assert.match(friendlyKitchenError(message), /hasn't accepted the Kopi Boy partner terms/);
    });
    // Accepted kitchen with every item hidden.
    await db.exec("begin");
    try {
      await db.exec(`update public.kitchens set is_live = false where id = '${COOK}'; update public.menu_items set is_hidden = true where kitchen_id = '${COOK}';`);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN, role: "authenticated" })]);
      await db.exec("set local role authenticated");
      const k = (await rows<{ updated_at: string }>(db, "select updated_at from public.kitchens where id = $1", [COOK]))[0];
      const message = await attempt(db, PROFILE_UPDATE, profileParams(COOK, k.updated_at, { is_live: true }));
      assert.match(message, /without at least one visible menu item/);
      assert.match(friendlyKitchenError(message), /isn't hidden/);
    } finally {
      await db.exec("rollback");
    }
    // Blocked merchant.
    await db.exec("begin");
    try {
      await db.exec(`update public.profiles set is_active = false where id = '${COOK}'; update public.kitchens set is_live = false where id = '${COOK}';`);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN, role: "authenticated" })]);
      await db.exec("set local role authenticated");
      const k = (await rows<{ updated_at: string }>(db, "select updated_at from public.kitchens where id = $1", [COOK]))[0];
      const message = await attempt(db, PROFILE_UPDATE, profileParams(COOK, k.updated_at, { is_live: true }));
      assert.match(message, /kitchen is blocked/);
      assert.match(friendlyKitchenError(message), /merchant is blocked/);
    } finally {
      await db.exec("rollback");
    }
  });

  it("HQ can always take a kitchen off the marketplace", async () => {
    await as(db, ADMIN, async () => {
      const r = await rows(db, PROFILE_UPDATE, profileParams(COOK, await stampOf(db, COOK), { is_live: false }));
      assert.equal(r.length, 1);
    });
  });

  it("system paths still work with the guard on: Block/Reinstate and the approval UEN sync", async () => {
    await as(db, ADMIN, async () => {
      await db.query("update public.profiles set is_active = false where id = $1", [COOK]);
      assert.equal((await rows<{ b: boolean }>(db, "select is_blocked as b from public.kitchens where id = $1", [COOK]))[0].b, true);
      await db.query("update public.profiles set is_active = true where id = $1", [COOK]);
      assert.equal((await rows<{ b: boolean }>(db, "select is_blocked as b from public.kitchens where id = $1", [COOK]))[0].b, false);
      await db.query("update public.cook_applications set status = 'rejected' where user_id = $1", [COOK]);
      assert.equal((await rows<{ u: string | null }>(db, "select business_uen as u from public.kitchens where id = $1", [COOK]))[0].u, null);
    });
  });

  it("the cook still edits their own kitchen, and the terms tick still stamps for them", async () => {
    await as(db, LEGACY, async () => {
      const r = await rows<{ id: string }>(
        db,
        "update public.kitchens set description = 'Mine', acknowledged_terms_at = '2000-01-01' where id = $1 returning id",
        [LEGACY]
      );
      assert.equal(r.length, 1);
      await db.exec("reset role");
      const [k] = await rows<{ d: string; fresh: boolean }>(
        db,
        "select description as d, acknowledged_terms_at = now() as fresh from public.kitchens where id = $1",
        [LEGACY]
      );
      assert.deepEqual(k, { d: "Mine", fresh: true });
      assert.equal(await auditCount(db), 0, "a cook's own edit is not an HQ audit row");
    });
  });

  it("one merchant can't edit another's kitchen or menu, or see its hidden items", async () => {
    await db.exec("begin");
    try {
      await db.exec(`update public.menu_items set is_hidden = true where kitchen_id = '${OTHER}'`);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: COOK, role: "authenticated" })]);
      await db.exec("set local role authenticated");
      assert.equal((await rows(db, "update public.kitchens set description = 'x' where id = $1 returning id", [OTHER])).length, 0);
      assert.equal((await rows(db, "update public.menu_items set price = 1 where kitchen_id = $1 returning id", [OTHER])).length, 0);
      assert.equal((await rows(db, "select id from public.menu_items where kitchen_id = $1", [OTHER])).length, 0);
      assert.equal((await rows(db, "select id from public.kitchen_admin_audit")).length, 0);
    } finally {
      await db.exec("rollback");
    }
  });

  it("menu: HQ adds, edits, hides and shows again, all audited; can't move or backdate an item", async () => {
    await as(db, ADMIN, async () => {
      const [item] = await rows<{ id: string; updated_at: string }>(
        db,
        "insert into public.menu_items (kitchen_id, name, price, photo_url) values ($1, 'Plain prata', 1.50, null) returning id, updated_at",
        [COOK]
      );
      const upd = (sql: string, stamp: string) => rows<{ updated_at: string }>(db, `${sql} where id = $1 and kitchen_id = $2 and updated_at = $3 returning updated_at`, [item.id, COOK, stamp]);
      const [a] = await upd("update public.menu_items set name = 'Plain prata', price = 1.80, photo_url = null", item.updated_at);
      assert.ok(a, "edit saved");
      const [b] = await upd("update public.menu_items set is_hidden = true", a.updated_at);
      assert.ok(b, "hidden");
      await upd("update public.menu_items set is_hidden = false", b.updated_at);
      assert.match(await tryStep(db, "update public.menu_items set kitchen_id = $2 where id = $1", [item.id, OTHER]), /HQ cannot change kitchen_id on a menu item/);
      assert.match(await tryStep(db, "update public.menu_items set created_at = '2000-01-01' where id = $1", [item.id]), /HQ cannot change created_at/);
      await db.exec("reset role");
      const actions = await rows<{ action: string }>(db, "select action from public.kitchen_admin_audit where target_id = $1 order by id", [item.id]);
      assert.deepEqual(actions.map((r) => r.action), ["menu_item_added", "menu_item_updated", "menu_item_hidden", "menu_item_unhidden"]);
    });
    await as(db, ADMIN, async () => {
      await db.query("insert into public.menu_items (kitchen_id, name, price, created_at) values ($1, 'Backdated', 1, '2000-01-01')", [COOK]);
      await db.exec("reset role");
      const [r] = await rows<{ fresh: boolean }>(db, "select created_at = now() as fresh from public.menu_items where name = 'Backdated'");
      assert.equal(r.fresh, true);
    });
  });

  it("stale menu edit: the cook changed the item after HQ loaded it, so HQ's update changes 0 rows", async () => {
    // Separate committed transactions, as in the app (now() is fixed inside one transaction).
    const [item] = await rows<{ id: string; updated_at: string }>(
      db,
      "insert into public.menu_items (kitchen_id, name, price) values ($1, 'Stale test', 3.00) returning id, updated_at",
      [COOK]
    );
    try {
      // PGlite's clock has millisecond resolution: make sure the cook's edit gets a later stamp.
      await new Promise((r) => setTimeout(r, 5));
      await db.exec("begin");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: COOK, role: "authenticated" })]);
      await db.exec("set local role authenticated");
      await db.query("update public.menu_items set price = 3.20 where id = $1", [item.id]);
      await db.exec("commit");
      await as(db, ADMIN, async () => {
        const r = await rows(db, "update public.menu_items set is_hidden = true where id = $1 and kitchen_id = $2 and updated_at = $3 returning id", [item.id, COOK, item.updated_at]);
        assert.equal(r.length, 0);
      });
    } finally {
      await db.query("delete from public.menu_items where id = $1", [item.id]);
    }
  });

  it("a hidden item is invisible to customers and anon, visible to its cook and HQ", async () => {
    await db.exec("begin");
    try {
      await db.exec(`update public.menu_items set is_hidden = true where kitchen_id = '${COOK}'`);
      const visible = async (uid: string | null) => {
        await db.exec("savepoint v");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
        await db.exec(uid ? "set local role authenticated" : "set local role anon");
        const n = (await rows(db, "select id from public.menu_items where kitchen_id = $1", [COOK])).length;
        await db.exec("rollback to savepoint v");
        return n;
      };
      assert.equal(await visible(null), 0);
      assert.equal(await visible(CUSTOMER), 0);
      assert.equal(await visible(COOK), 1);
      assert.equal(await visible(ADMIN), 1);
    } finally {
      await db.exec("rollback");
    }
  });

  it("audit log: admins read it; nobody can insert, change or delete a row", async () => {
    await as(db, ADMIN, async () => {
      assert.match(await tryStep(db, "insert into public.kitchen_admin_audit (admin_id, kitchen_id, target_table, target_id, action, changes) values ($1, $1, 'kitchens', $1, 'update', '{}')", [ADMIN]), /permission denied/);
      assert.match(await tryStep(db, "update public.kitchen_admin_audit set reason = 'x'"), /permission denied/);
      assert.match(await tryStep(db, "delete from public.kitchen_admin_audit"), /permission denied/);
    });
    await db.exec("begin");
    try {
      await db.query("insert into public.kitchen_admin_audit (admin_id, kitchen_id, target_table, target_id, action, changes) values ($1, $1, 'kitchens', $1, 'update', '{}')", [ADMIN]);
      assert.match(await tryStep(db, "update public.kitchen_admin_audit set reason = 'x'"), /append-only/);
      assert.match(await tryStep(db, "delete from public.kitchen_admin_audit"), /append-only/);
    } finally {
      await db.exec("rollback");
    }
  });

  it("PayNow: only through the RPC, confirmation required, masked in the log", async () => {
    await as(db, ADMIN, async () => {
      assert.match(await tryStep(db, "select public.admin_set_kitchen_paynow($1, 'mobile', '91234567', 'wrong', 'r')", [COOK]), /Type the kitchen's business name/);
      assert.match(await tryStep(db, "select public.admin_set_kitchen_paynow($1, 'mobile', '91234567', 'TEST Parata', '')", [COOK]), /Give a reason/);
      const [r] = await rows<{ m: string }>(db, "select public.admin_set_kitchen_paynow($1, 'mobile', '+65 9123 4567', 'test parata', 'cook asked') as m", [COOK]);
      assert.equal(r.m, "*****567");
      await db.exec("reset role");
      const [a] = await rows<{ changes: string; reason: string }>(db, "select changes::text, reason from public.kitchen_admin_audit where action = 'paynow_update'");
      assert.doesNotMatch(a.changes, /1234567|87654321|7654321/);
      assert.equal(a.reason, "cook asked");
    });
    await as(db, CUSTOMER, async () => {
      assert.match(await tryStep(db, "select public.admin_set_kitchen_paynow($1, 'mobile', '91234567', 'TEST Parata', 'r')", [COOK]), /admins only/);
    });
  });

  it("photos: HQ may upload only to <kitchen>/hq/<file>.jpg|png|webp of a real kitchen", async () => {
    const put = (name: string) => tryStep(db, "insert into storage.objects (bucket_id, name) values ('kitchen-photos', $1)", [name]);
    await as(db, ADMIN, async () => {
      assert.equal(await put(`${COOK}/hq/a.jpg`), "");
      assert.equal(await put(`${COOK}/hq/a.webp`), "");
      assert.match(await put(`${COOK}/a.jpg`), /row-level security/);
      assert.match(await put(`${COOK}/hq/a.svg`), /row-level security/);
      assert.match(await put(`${CUSTOMER}/hq/a.jpg`), /row-level security/);
    });
    await as(db, CUSTOMER, async () => {
      assert.match(await put(`${COOK}/hq/a.jpg`), /row-level security/);
    });
  });
});
