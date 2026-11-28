import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  ASSISTED_AUDIT_COLUMNS,
  ASSISTED_ITEM_COLUMNS,
  ASSISTED_SHOP_COLUMNS,
  ASSISTED_SHOP_LIST_COLUMNS,
  claimReadiness,
  DRAFT_SAVE_COLUMNS,
  friendlyAssistedError,
  hashClaimToken,
  newClaimToken,
} from "./assisted-onboarding.ts";

/**
 * Assisted onboarding, run for real in PGlite:
 *   docs/supabase-kitchen-admin-edit.sql             (installed on live; the guard + mask_paynow)
 *   docs/supabase-assisted-onboarding.sql            (installed twice: it must re-run cleanly)
 *   docs/supabase-assisted-onboarding-live-test.sql  (the live rollback-only test)
 *   docs/supabase-assisted-menu-import.sql           (categories, CSV import, category photo; installed twice)
 *   docs/supabase-assisted-menu-import-live-test.sql (its live rollback-only test)
 * on top of the real billing files (subscriptions step 1 + step 2 +
 * docs/supabase-billing-off.sql: the claim makes no subscription row), and
 * stand-ins for the live objects the claim touches: auth.users and
 * handle_new_user, profiles and protect_profile_privileges, the cook
 * application guard / UEN check / promote triggers, the partner terms stamp
 * and the column grants on kitchens.
 *
 * Also checks that what Boss sends matches the database: the column lists
 * in assisted-onboarding.ts are granted, and hashClaimToken() gives the hash
 * the Partner lookup finds.
 */

const read = (p: string) => readFileSync(new URL(`../../docs/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const KITCHEN_ADMIN = read("supabase-kitchen-admin-edit.sql");
const SCRIPT = read("supabase-assisted-onboarding.sql");
const LIVE_TEST = read("supabase-assisted-onboarding-live-test.sql");
const MENU_IMPORT = read("supabase-assisted-menu-import.sql");
const MENU_LIVE_TEST = read("supabase-assisted-menu-import-live-test.sql");
// The real billing files, in live order: subscriptions step 1, step 2, then billing off (the pilot).
const BILLING = ["supabase-subscriptions.sql", "supabase-subscriptions-step2.sql", "supabase-billing-off.sql"].map(read);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = id(900);
const CUSTOMER = id(901);
/** A fresh client key per call, so the rate limit only bites where a test wants it to. */
const freshClient = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const CLIENT_2 = "b".repeat(64);
const CLIENT_LIMITED = "c".repeat(64);

const STUBS = `
create role anon; create role authenticated; create role service_role;
create schema auth; create schema storage;
grant usage on schema auth, public, storage to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table auth.users (id uuid primary key, instance_id uuid, aud text, role text, email text,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz);

create table public.profiles (id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'customer', full_name text, phone text, is_active boolean not null default true,
  created_at timestamptz not null default now());
create function public.handle_new_user() returns trigger as $$
begin insert into public.profiles (id, full_name) values (new.id, new.raw_user_meta_data->>'full_name'); return new; end;
$$ language plpgsql security definer set search_path = public;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
create or replace function public.user_has_role(check_role text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = check_role);
$$;
grant execute on function public.user_has_role(text) to anon, authenticated;
create function public.protect_profile_privileges() returns trigger as $$
begin
  if auth.uid() is not null and not public.user_has_role('admin') then new.role := old.role; new.is_active := old.is_active; end if;
  return new;
end; $$ language plpgsql security definer set search_path = public;
create trigger before_profile_update before update on public.profiles for each row execute function public.protect_profile_privileges();
alter table public.profiles enable row level security;
grant select, update on public.profiles to authenticated;
create policy "own" on public.profiles for select using (auth.uid() = id);
create policy "admin" on public.profiles for select using (public.user_has_role('admin'));

create table public.cook_applications (id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade, business_name text not null, business_type text,
  description text, neighbourhood text, paynow_uen text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz not null default now(),
  business_uen text, business_address text, postal_code text check (postal_code ~ '^[0-9]{6}$'),
  privacy_policy_version text, privacy_acknowledged_at timestamptz, paynow_mobile text);
alter table public.cook_applications enable row level security;
grant select, insert, update on public.cook_applications to authenticated;
create function public.guard_cook_application() returns trigger language plpgsql set search_path = '' as $$
declare v_from_app boolean := current_user in ('anon', 'authenticated') and not public.user_has_role('admin');
begin
  if tg_op = 'UPDATE' then new.privacy_policy_version := old.privacy_policy_version; new.privacy_acknowledged_at := old.privacy_acknowledged_at; return new; end if;
  if v_from_app then new.status := 'pending'; new.reviewed_by := null; new.reviewed_at := null; end if;
  new.privacy_policy_version := nullif(btrim(coalesce(new.privacy_policy_version, '')), '');
  if new.privacy_policy_version is null and v_from_app then raise exception 'Please tick the Privacy Policy'; end if;
  new.privacy_acknowledged_at := case when new.privacy_policy_version is not null then now() end;
  return new;
end; $$;
create trigger before_cook_application_guard before insert or update on public.cook_applications for each row execute function public.guard_cook_application();
create function public.check_cook_application_uen() returns trigger language plpgsql set search_path = public as $$
begin
  new.business_uen := nullif(upper(btrim(coalesce(new.business_uen, ''))), '');
  if new.business_type is not distinct from 'Home Cook' then new.business_uen := null;
  elsif new.business_uen is null then raise exception 'A Business Registration Number (UEN) is required for registered businesses.' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger before_cook_application_insert before insert on public.cook_applications for each row execute function public.check_cook_application_uen();
create function public.promote_approved_applicant() returns trigger language plpgsql security definer set search_path = public as $$
begin update public.profiles set role = tg_argv[0] where id = new.user_id and role = 'customer'; return new; end; $$;
create trigger after_cook_application_approved after insert or update of status on public.cook_applications
  for each row when (new.status = 'approved') execute function public.promote_approved_applicant('cook');

create table public.kitchens (id uuid primary key references public.profiles(id) on delete cascade,
  business_name text not null,
  category text not null check (category in ('home-cook','hawker','bakery','vegetarian','drinks-desserts')),
  cuisine_type text not null check (cuisine_type in ('chinese','halal','indian','western')),
  neighbourhood text, description text, hero_image text, is_live boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  paynow_type text, paynow_value text, latitude numeric, longitude numeric, business_uen text,
  postal_sector text, is_halal boolean not null default false, acknowledged_terms_at timestamptz,
  is_blocked boolean not null default false, region text, live_since timestamptz);
alter table public.kitchens enable row level security;
grant insert, update on public.kitchens to authenticated;
grant select (id, business_name, category, cuisine_type, neighbourhood, description, hero_image, is_live, created_at, updated_at, business_uen, postal_sector, is_halal, is_blocked, region, live_since) on public.kitchens to anon, authenticated;
create policy "own read" on public.kitchens for select using (auth.uid() = id);
create policy "own update" on public.kitchens for update using (auth.uid() = id);
create policy "admin read" on public.kitchens for select using (public.user_has_role('admin'));
create function public.touch_kitchen_updated_at() returns trigger as $$ begin new.updated_at := now(); return new; end; $$ language plpgsql;
create trigger before_kitchen_update before update on public.kitchens for each row execute function public.touch_kitchen_updated_at();
create function public.stamp_kitchen_terms_acknowledgement() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.acknowledged_terms_at is not null then new.acknowledged_terms_at := old.acknowledged_terms_at;
  elsif new.acknowledged_terms_at is not null then new.acknowledged_terms_at := now();
  elsif tg_op = 'INSERT' then raise exception 'Please acknowledge the Kopi Boy partner terms before setting up your kitchen.' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger before_kitchen_terms_acknowledgement before insert or update on public.kitchens for each row execute function public.stamp_kitchen_terms_acknowledgement();

create table public.kitchen_addresses (kitchen_id uuid primary key references public.kitchens(id) on delete cascade,
  business_address text, postal_code text, latitude numeric(9,6), longitude numeric(9,6), updated_at timestamptz not null default now());
alter table public.kitchen_addresses enable row level security;
grant select, insert, update on public.kitchen_addresses to authenticated;
create function public.sync_public_location() returns trigger language plpgsql security definer set search_path = public as $$
begin update public.kitchens set postal_sector = left(new.postal_code, 2) where id = new.kitchen_id; return new; end; $$;
create trigger after_kitchen_address_change after insert or update on public.kitchen_addresses for each row execute function public.sync_public_location();

create table public.menu_items (id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens(id) on delete cascade, name text not null,
  price numeric(6,2) not null check (price > 0), photo_url text, created_at timestamptz not null default now());
alter table public.menu_items enable row level security;
grant select, insert, update, delete on public.menu_items to authenticated;
create policy "own items" on public.menu_items for all using (auth.uid() = kitchen_id) with check (auth.uid() = kitchen_id);

create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant select, insert on storage.objects to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
create function storage.extension(name text) returns text language sql immutable as $$
  select reverse(split_part(reverse(name), '.', 1)) $$;
grant execute on all functions in schema storage to authenticated;

insert into auth.users (id, raw_user_meta_data) values ('${ADMIN}', '{"full_name":"HQ Admin"}'), ('${CUSTOMER}', '{"full_name":"A Customer"}');
update public.profiles set role = 'admin' where id = '${ADMIN}';
`;

type Who = "admin" | "customer" | "anon" | "service";

let db: PGlite;

/** Runs fn as that caller in a transaction: committed, or rolled back when it throws or keep is false. */
async function as<T>(who: Who, fn: () => Promise<T>, keep = true): Promise<T> {
  await db.exec("begin");
  try {
    const uid = who === "admin" ? ADMIN : who === "customer" ? CUSTOMER : null;
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: who === "service" ? "service_role" : "anon" }),
    ]);
    await db.exec(`set local role ${uid ? "authenticated" : who === "service" ? "service_role" : "anon"}`);
    const result = await fn();
    await db.exec(keep ? "commit" : "rollback");
    return result;
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

const fingerprint = () =>
  one<{ guard: string; terms: string }>(`
    select md5(pg_get_functiondef('public.guard_admin_kitchen_edit()'::regprocedure)) as guard,
           md5(pg_get_functiondef('public.stamp_kitchen_terms_acknowledgement()'::regprocedure)) as terms`);

/** HQ creates a draft with exactly the columns Boss sends (DRAFT_SAVE_COLUMNS). */
async function createDraft(fields: Partial<Record<(typeof DRAFT_SAVE_COLUMNS)[number], unknown>> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    business_name: "TEST Draft",
    category: "hawker",
    cuisine_type: "chinese",
    is_halal: false,
    description: null,
    hero_image: null,
    owner_name: "Tan Ah Hock",
    owner_mobile: "91234567",
    business_uen: "53123456A",
    business_address: "Blk 1 Test Lane",
    postal_code: "310123",
    ...fields,
  };
  const cols = DRAFT_SAVE_COLUMNS as readonly string[];
  const sql = `insert into public.assisted_shops (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`;
  return as("admin", async () => (await one<{ id: string }>(sql, cols.map((c) => row[c]))).id);
}

const addItem = (shopId: string, name = "Noodles", price = 4.5) =>
  as("admin", async () =>
    (await one<{ id: string }>("insert into public.assisted_shop_items (shop_id, name, price, photo_url) values ($1, $2, $3, null) returning id", [shopId, name, price])).id
  );

/** Issues a link the way Boss does: a fresh token, only its hash to the database. */
async function issue(shopId: string) {
  const token = newClaimToken();
  const hash = await hashClaimToken(token);
  const row = await as("admin", () =>
    one<{ token_id: string; expires_at: string }>("select * from public.admin_issue_assisted_claim_link($1, $2)", [shopId, hash])
  );
  return { token, hash, tokenId: row.token_id };
}

const preview = (hash: string, client = freshClient()) =>
  as("service", async () => (await one<{ r: Record<string, unknown> }>("select public.assisted_claim_preview($1, $2) as r", [hash, client])).r);

/** The Partner server's new account: app_metadata.kb_assisted_shop_id = the shop. */
async function newOwnerAccount(shopId: string, n: number): Promise<string> {
  const uid = id(n);
  await q("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [
    uid,
    `assisted-${n}@example.invalid`,
    JSON.stringify({ kb_assisted_shop_id: shopId }),
  ]);
  return uid;
}

const complete = (hash: string, uid: string, client = freshClient()) =>
  as("service", async () =>
    (await one<{ r: Record<string, unknown> }>("select public.assisted_claim_complete($1, $2, $3, $4, $5) as r", [
      hash,
      client,
      uid,
      "Mozilla/5.0 (Test)\u0007",
      "2026-10-v1",
    ])).r
  );

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(p, (e: Error) => {
    assert.match(e.message, pattern);
    return true;
  });
}

let before_fp: { guard: string; terms: string };

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  for (const sql of BILLING) await db.exec(sql);
  await db.exec(KITCHEN_ADMIN);
  before_fp = await fingerprint();
  await db.exec(SCRIPT);
  await db.exec(SCRIPT); // re-runnable
  await db.exec(MENU_IMPORT);
  await db.exec(MENU_IMPORT); // re-runnable
});

describe("install", () => {
  it("leaves the HQ guard and the partner terms trigger exactly as they were", async () => {
    assert.deepEqual(await fingerprint(), before_fp);
  });

  it("the live test passes and rolls everything back", async () => {
    let message = "(the live test finished without its closing exception)";
    try {
      await db.exec(LIVE_TEST.replaceAll("PUT-ADMIN-ID", ADMIN));
    } catch (e) {
      message = (e as Error).message;
    } finally {
      await db.exec("rollback").catch(() => {}); // never leave the script's transaction open for the next tests
    }
    assert.match(message, /^TEST OK, rolled back/);
    const left = await one<{ shops: number; kitchens: number; users: number }>(
      "select (select count(*)::int from public.assisted_shops) shops, (select count(*)::int from public.kitchens) kitchens, (select count(*)::int from auth.users) users"
    );
    assert.deepEqual(left, { shops: 0, kitchens: 0, users: 2 });
  });
});

describe("what Boss reads and writes matches the grants", () => {
  it("every column list in assisted-onboarding.ts can be read by an admin", async () => {
    await as("admin", async () => {
      for (const [table, cols] of [
        ["assisted_shops", ASSISTED_SHOP_COLUMNS],
        ["assisted_shops", ASSISTED_SHOP_LIST_COLUMNS],
        ["assisted_shop_items", ASSISTED_ITEM_COLUMNS],
        ["assisted_onboarding_audit", ASSISTED_AUDIT_COLUMNS],
      ]) {
        await q(`select ${cols} from public.${table} limit 1`);
      }
    }, false);
  });

  it("an HQ create with DRAFT_SAVE_COLUMNS works; the database sets status, author and dates, and tidies the UEN", async () => {
    const shopId = await createDraft({ business_name: "  TEST Columns  ", owner_mobile: "81111111", business_uen: " 53123456a " });
    const shop = await one("select status, created_by, business_name, business_uen from public.assisted_shops where id = $1", [shopId]);
    assert.deepEqual(shop, { status: "draft", created_by: ADMIN, business_name: "TEST Columns", business_uen: "53123456A" });
  });

  it("HQ can't write the columns the database owns", async () => {
    const shopId = await createDraft({ owner_mobile: "81111112" });
    for (const col of ["status", "claimed_user_id", "acknowledged_at", "created_by"]) {
      await rejects(
        as("admin", () => q(`update public.assisted_shops set ${col} = null where id = $1`, [shopId])),
        /permission denied/
      );
    }
  });

  it("customers and anon can't read or write drafts, and nobody but the database reads the token table", async () => {
    await createDraft({ owner_mobile: "81111113" });
    assert.equal((await as("customer", () => q("select id from public.assisted_shops"))).length, 0);
    await rejects(as("customer", () => createDraftAs()), /row-level security|permission denied/);
    await rejects(as("anon", () => q("select id from public.assisted_shops")), /permission denied/);
    for (const who of ["admin", "customer", "service"] as const) {
      await rejects(as(who, () => q("select token_hash from public.assisted_claim_tokens")), /permission denied/);
    }
  });

  it("a second open draft for the same mobile is refused, with Boss's message", async () => {
    await createDraft({ owner_mobile: "81111114" });
    let message = "";
    await createDraft({ owner_mobile: "81111114" }).catch((e: Error) => (message = e.message));
    assert.match(friendlyAssistedError(message), /already an open draft for this owner's mobile/);
  });

  it("a save with an old updated_at changes nothing (the stale-edit check)", async () => {
    const shopId = await createDraft({ owner_mobile: "81111115" });
    const updated = await as("admin", () =>
      q("update public.assisted_shops set business_name = 'X' where id = $1 and updated_at = $2 returning id", [shopId, "2000-01-01T00:00:00Z"])
    );
    assert.equal(updated.length, 0);
  });

  it("draft edits and item changes are audited, with the owner mobile masked", async () => {
    const shopId = await createDraft({ owner_mobile: "81111116" });
    await as("admin", () => q("update public.assisted_shops set owner_mobile = '81111117' where id = $1", [shopId]));
    const itemId = await addItem(shopId);
    await as("admin", () => q("update public.assisted_shop_items set is_hidden = true where id = $1", [itemId]));
    const audit = await q<{ action: string; details: Record<string, unknown> }>(
      "select action, details from public.assisted_onboarding_audit where shop_id = $1 order by id",
      [shopId]
    );
    assert.deepEqual(audit.map((a) => a.action), ["shop_created", "shop_updated", "item_added", "item_hidden"]);
    assert.doesNotMatch(JSON.stringify(audit), /8111111[67]/);
  });
});

async function createDraftAs() {
  return q("insert into public.assisted_shops (business_name, category, cuisine_type, owner_name, owner_mobile) values ('X', 'hawker', 'chinese', 'Y', '81119999')");
}

describe("claim links", () => {
  it("can't be issued until the draft is ready (address, postal code, a visible item; no UEN); Boss's readiness list agrees with the database", async () => {
    // The rule as live since docs/supabase-assisted-uen-later.sql: run on that stack. as(), q() and
    // createDraft() use db, so it is swapped for this test and put back after.
    const main = db;
    db = await uenStack();
    try {
      assert.equal((await runScript(db, UEN_LATER)).result, "UEN LATER INSTALLED");
      const shopId = await createDraft({ owner_mobile: "82222221", business_uen: null, business_address: null });
      const shop = await one<{ status: "draft"; category: string; business_uen: null; business_address: null; postal_code: string }>(
        "select status, category, business_uen, business_address, postal_code from public.assisted_shops where id = $1",
        [shopId]
      );
      assert.equal(shop.category, "hawker");
      assert.deepEqual(claimReadiness(shop as never, []), ["Pickup address", "At least one menu item that isn't hidden"]);
      await rejects(issue(shopId), /pickup address and postal code/);
      await as("admin", () => q("update public.assisted_shops set business_address = 'Blk 2' where id = $1", [shopId]));
      // No UEN, and the next refusal is the menu: the UEN is no longer asked for.
      await rejects(issue(shopId), /at least one menu item/);
      const hiddenId = await addItem(shopId);
      await as("admin", () => q("update public.assisted_shop_items set is_hidden = true where id = $1", [hiddenId]));
      await rejects(issue(shopId), /at least one menu item/);
      await addItem(shopId, "Visible");
      const items = await q<{ is_hidden: boolean }>("select is_hidden from public.assisted_shop_items where shop_id = $1", [shopId]);
      assert.deepEqual(claimReadiness({ status: "draft", business_address: "Blk 2", postal_code: "310123" }, items), []);
      await issue(shopId);
      assert.equal((await one<{ u: string | null }>("select business_uen as u from public.assisted_shops where id = $1", [shopId])).u, null);
    } finally {
      await db.close();
      db = main;
    }
  });

  it("a Home Cook needs no UEN", async () => {
    const shopId = await createDraft({ owner_mobile: "82222222", category: "home-cook", business_uen: null });
    await addItem(shopId);
    await issue(shopId);
  });

  it("customers and anon can't issue, list, revoke or cancel", async () => {
    const shopId = await createDraft({ owner_mobile: "82222223" });
    await addItem(shopId);
    const hash = "d".repeat(64);
    await rejects(as("customer", () => q("select * from public.admin_issue_assisted_claim_link($1, $2)", [shopId, hash])), /admins only/);
    await rejects(as("customer", () => q("select * from public.admin_list_assisted_claim_links($1)", [shopId])), /admins only/);
    await rejects(as("customer", () => q("select public.admin_cancel_assisted_shop($1, 'x')", [shopId])), /admins only/);
    await rejects(as("anon", () => q("select * from public.admin_issue_assisted_claim_link($1, $2)", [shopId, hash])), /permission denied/);
    await rejects(as("admin", () => q("select public.assisted_claim_preview($1, $2)", [hash, freshClient()])), /permission denied/);
  });

  it("the hash Boss makes is the one the Partner lookup finds; the raw token is never stored", async () => {
    const shopId = await createDraft({ owner_mobile: "82222224", description: "Noodles since 1980" });
    await addItem(shopId, "Wanton mee", 5);
    const hiddenId = await addItem(shopId, "Secret");
    await as("admin", () => q("update public.assisted_shop_items set is_hidden = true where id = $1", [hiddenId]));
    const { token, hash } = await issue(shopId);

    const r = await preview(hash);
    assert.equal(r.status, "ok");
    assert.equal(r.shop_id, shopId);
    assert.deepEqual((r.items as { name: string }[]).map((i) => i.name), ["Wanton mee"]);
    assert.notEqual((r.shop as Record<string, unknown>).owner_mobile_masked, "82222224");

    assert.equal((await preview(await hashClaimToken(token + "x"))).status, "invalid");
    const everything = JSON.stringify(await q("select * from public.assisted_claim_tokens")) + JSON.stringify(await q("select * from public.assisted_onboarding_audit"));
    assert.ok(!everything.includes(token), "the raw token is stored nowhere");
    assert.ok(!JSON.stringify(await q("select * from public.assisted_onboarding_audit")).includes(hash), "the audit never holds the hash");
  });

  it("issuing again revokes the earlier link; HQ's list shows states, never a hash", async () => {
    const shopId = await createDraft({ owner_mobile: "82222225" });
    await addItem(shopId);
    const first = await issue(shopId);
    const second = await issue(shopId);
    assert.equal((await preview(first.hash)).status, "revoked");
    assert.equal((await preview(second.hash)).status, "ok");
    const list = await as("admin", () => q<Record<string, unknown>>("select * from public.admin_list_assisted_claim_links($1)", [shopId]));
    assert.deepEqual(list.map((l) => l.state), ["live", "revoked"]);
    assert.ok(!("token_hash" in list[0]));
    assert.equal(list[1].revoke_reason, "replaced by a new link");
  });

  it("mark sent keeps the first time; revoke needs a reason; a revoked link can't be sent", async () => {
    const shopId = await createDraft({ owner_mobile: "82222226" });
    await addItem(shopId);
    const { hash, tokenId } = await issue(shopId);
    await as("admin", () => q("select public.admin_mark_assisted_claim_link_sent($1)", [tokenId]));
    await as("admin", () => q("select public.admin_mark_assisted_claim_link_sent($1)", [tokenId]));
    await rejects(as("admin", () => q("select public.admin_revoke_assisted_claim_link($1, '  ')", [tokenId])), /Give a reason/);
    await as("admin", () => q("select public.admin_revoke_assisted_claim_link($1, 'wrong number')", [tokenId]));
    assert.equal((await preview(hash)).status, "revoked");
    await rejects(as("admin", () => q("select public.admin_mark_assisted_claim_link_sent($1)", [tokenId])), /no longer valid/);
    const actions = (await q<{ action: string }>("select action from public.assisted_onboarding_audit where token_id = $1 order by id", [tokenId])).map((a) => a.action);
    assert.deepEqual(actions, ["link_issued", "link_sent", "link_sent", "link_revoked"]);
  });

  it("an expired link reads as expired", async () => {
    const shopId = await createDraft({ owner_mobile: "82222227" });
    await addItem(shopId);
    const { hash, tokenId } = await issue(shopId);
    await q("update public.assisted_claim_tokens set created_at = now() - interval '3 days', expires_at = now() - interval '1 day' where id = $1", [tokenId]);
    assert.equal((await preview(hash)).status, "expired");
  });

  it("cancelling revokes the live link and freezes the draft and its menu", async () => {
    const shopId = await createDraft({ owner_mobile: "82222228" });
    const itemId = await addItem(shopId);
    const { hash } = await issue(shopId);
    await rejects(as("admin", () => q("select public.admin_cancel_assisted_shop($1, '')", [shopId])), /Give a reason/);
    await as("admin", () => q("select public.admin_cancel_assisted_shop($1, 'owner changed their mind')", [shopId]));
    assert.equal((await preview(hash)).status, "cancelled");
    const edited = await as("admin", () => q("update public.assisted_shops set business_name = 'X' where id = $1 returning id", [shopId]));
    assert.equal(edited.length, 0, "RLS hides a cancelled draft from HQ updates");
    await rejects(as("admin", () => q("insert into public.assisted_shop_items (shop_id, name, price) values ($1, 'X', 1)", [shopId])), /row-level security|claimed or cancelled/);
    assert.equal((await as("admin", () => q("update public.assisted_shop_items set name = 'X' where id = $1 returning id", [itemId]))).length, 0);
    const cancel = await one<{ details: { reason: string } }>("select details from public.assisted_onboarding_audit where shop_id = $1 and action = 'shop_cancelled'", [shopId]);
    assert.equal(cancel.details.reason, "owner changed their mind");
  });
});

describe("the owner's claim", () => {
  it("creates a cook with a kitchen that isn't live, no subscription row or founding number (billing off), and works once", async () => {
    const shopId = await createDraft({ owner_mobile: "83333331", business_name: "TEST Claim Me", hero_image: "https://example.com/a.jpg" });
    await addItem(shopId, "Char kway teow", 6);
    const hiddenId = await addItem(shopId, "Not this");
    await as("admin", () => q("update public.assisted_shop_items set is_hidden = true where id = $1", [hiddenId]));
    const { hash, tokenId } = await issue(shopId);
    await q("update public.assisted_shops set created_at = '2026-11-01T02:00:00Z' where id = $1", [shopId]);

    const wrong = await newOwnerAccount(id(1), 501); // made for another shop
    await rejects(complete(hash, wrong), /not made for this shop/);
    assert.equal((await preview(hash)).status, "ok", "a refused claim uses nothing up");

    const owner = await newOwnerAccount(shopId, 502);
    const r = await complete(hash, owner);
    assert.equal(r.status, "ok");
    assert.equal(r.kitchen_id, owner);

    const kitchen = await one("select is_live, business_name, category, hero_image, (acknowledged_terms_at is not null) as acked, paynow_value from public.kitchens where id = $1", [owner]);
    assert.deepEqual(kitchen, { is_live: false, business_name: "TEST Claim Me", category: "hawker", hero_image: "https://example.com/a.jpg", acked: true, paynow_value: null });
    assert.deepEqual((await q<{ name: string }>("select name from public.menu_items where kitchen_id = $1", [owner])).map((m) => m.name), ["Char kway teow"]);
    assert.deepEqual(await one("select business_address, postal_code from public.kitchen_addresses where kitchen_id = $1", [owner]), {
      business_address: "Blk 1 Test Lane",
      postal_code: "310123",
    });
    assert.deepEqual(await one("select role, full_name, phone from public.profiles where id = $1", [owner]), {
      role: "cook",
      full_name: "Tan Ah Hock",
      phone: "83333331",
    });
    const app = await one<{ status: string; business_type: string; created_at: Date; privacy_policy_version: string; reviewed_by: string }>(
      "select status, business_type, created_at, privacy_policy_version, reviewed_by from public.cook_applications where user_id = $1",
      [owner]
    );
    assert.equal(app.status, "approved");
    assert.equal(app.business_type, "Hawker");
    assert.equal(app.privacy_policy_version, "2026-10-v1");
    assert.equal(app.reviewed_by, ADMIN);
    assert.equal(new Date(app.created_at).toISOString(), "2026-11-01T02:00:00.000Z");
    assert.deepEqual(await q("select merchant_id from public.merchant_subscriptions where merchant_id = $1", [owner]), [], "billing off: no subscription row");
    assert.deepEqual(await q("select action from public.subscription_events where merchant_id = $1", [owner]), [], "billing off: no founding number, no event");

    const shop = await one("select status, claimed_user_id, acknowledged_token_id, acknowledged_user_agent from public.assisted_shops where id = $1", [shopId]);
    assert.deepEqual(shop, { status: "claimed", claimed_user_id: owner, acknowledged_token_id: tokenId, acknowledged_user_agent: "Mozilla/5.0 (Test)" });

    // A second tap, or the link again later.
    assert.equal((await complete(hash, await newOwnerAccount(shopId, 503))).status, "used");
    assert.equal((await preview(hash)).status, "used");
    const claimed = await q<{ actor_kind: string; kitchen_id: string }>("select actor_kind, kitchen_id from public.assisted_onboarding_audit where shop_id = $1 and action = 'claimed'", [shopId]);
    assert.deepEqual(claimed, [{ actor_kind: "owner", kitchen_id: owner }]);
  });

  it("HQ still can't touch the partner terms on the claimed kitchen (the guard is unchanged)", async () => {
    const shopId = await createDraft({ owner_mobile: "83333332" });
    await addItem(shopId);
    const { hash } = await issue(shopId);
    const owner = await newOwnerAccount(shopId, 504);
    assert.equal((await complete(hash, owner)).status, "ok");
    await rejects(
      as("admin", () => q("update public.kitchens set acknowledged_terms_at = now() where id = $1", [owner])),
      /HQ cannot set or change the partner terms|permission denied/
    );
  });

  it("an account that already has a kitchen or application can't claim", async () => {
    const shopId = await createDraft({ owner_mobile: "83333333", category: "home-cook", business_uen: null });
    await addItem(shopId);
    const { hash } = await issue(shopId);
    const owner = await newOwnerAccount(shopId, 505);
    await q("insert into public.cook_applications (user_id, business_name, business_type) values ($1, 'Mine', 'Home Cook')", [owner]);
    await rejects(complete(hash, owner), /already in use/);
  });

  it("is rate-limited per client after 10 failed tries", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await preview("e".repeat(64), CLIENT_LIMITED)).status, "invalid");
    assert.equal((await preview("e".repeat(64), CLIENT_LIMITED)).status, "rate_limited");
    assert.equal((await preview("e".repeat(64), CLIENT_2)).status, "invalid", "other clients are not affected");
  });
});

describe("HQ photo uploads (kitchen-photos/assisted/<shop_id>/)", () => {
  const upload = (who: Who, name: string) =>
    as(who, () => q("insert into storage.objects (bucket_id, name) values ('kitchen-photos', $1)", [name]));

  it("an admin can upload JPG/PNG/WebP into a draft's folder", async () => {
    const shopId = await createDraft({ owner_mobile: "84444441" });
    for (const ext of ["jpg", "png", "webp"]) await upload("admin", `assisted/${shopId}/${crypto.randomUUID()}.${ext}`);
  });

  it("refuses other file types, unknown shops, non-admins and other folders", async () => {
    const shopId = await createDraft({ owner_mobile: "84444442" });
    await rejects(upload("admin", `assisted/${shopId}/x.gif`), /row-level security/);
    await rejects(upload("admin", `assisted/${id(777)}/x.jpg`), /row-level security/);
    await rejects(upload("customer", `assisted/${shopId}/x.jpg`), /row-level security/);
    await rejects(upload("admin", `other/${shopId}/x.jpg`), /row-level security/);
  });

  it("refuses once the draft is cancelled", async () => {
    const shopId = await createDraft({ owner_mobile: "84444443" });
    await as("admin", () => q("select public.admin_cancel_assisted_shop($1, 'test')", [shopId]));
    await rejects(upload("admin", `assisted/${shopId}/x.jpg`), /row-level security/);
  });

  it("menu item photos: uploaded to the draft folder, saved on the item (replace, remove, link fallback), and copied into the kitchen at claim", async () => {
    const shopId = await createDraft({ owner_mobile: "84444444" });
    const publicUrl = (path: string) => `https://example.supabase.co/storage/v1/object/public/kitchen-photos/${path}`;

    // Upload the way KitchenPhotoField does (assistedPhotoPath), then save the item with its public URL.
    const first = `assisted/${shopId}/${crypto.randomUUID()}.jpg`;
    const second = `assisted/${shopId}/${crypto.randomUUID()}.webp`;
    await upload("admin", first);
    await upload("admin", second);
    const insertItem = (name: string, photo: string | null) =>
      as("admin", async () =>
        (await one<{ id: string }>("insert into public.assisted_shop_items (shop_id, name, price, photo_url) values ($1, $2, 5, $3) returning id", [shopId, name, photo])).id
      );
    const setPhoto = (itemId: string, photo: string) =>
      as("admin", () => q("update public.assisted_shop_items set photo_url = $2 where id = $1", [itemId, photo]));
    const photoOf = async (itemId: string) => (await one<{ photo_url: string | null }>("select photo_url from public.assisted_shop_items where id = $1", [itemId])).photo_url;

    const uploaded = await insertItem("Uploaded photo", publicUrl(first));
    await setPhoto(uploaded, publicUrl(second)); // Replace photo
    assert.equal(await photoOf(uploaded), publicUrl(second));

    const removed = await insertItem("Removed photo", publicUrl(first));
    await setPhoto(removed, ""); // Remove photo sends "": stored as no photo
    assert.equal(await photoOf(removed), null);

    const linked = await insertItem("Pasted link", "  https://example.com/kopi.png  "); // the URL field still works
    assert.equal(await photoOf(linked), "https://example.com/kopi.png");

    const hiddenId = await insertItem("Hidden with photo", publicUrl(first));
    await as("admin", () => q("update public.assisted_shop_items set is_hidden = true where id = $1", [hiddenId]));

    const { hash } = await issue(shopId);
    const owner = await newOwnerAccount(shopId, 520);
    assert.equal((await complete(hash, owner)).status, "ok");

    const menu = await q<{ name: string; photo_url: string | null }>("select name, photo_url from public.menu_items where kitchen_id = $1 order by name", [owner]);
    assert.deepEqual(menu, [
      { name: "Pasted link", photo_url: "https://example.com/kopi.png" },
      { name: "Removed photo", photo_url: null },
      { name: "Uploaded photo", photo_url: publicUrl(second) },
    ]);

    // Once claimed, the draft folder takes no more uploads.
    await rejects(upload("admin", `assisted/${shopId}/${crypto.randomUUID()}.jpg`), /row-level security/);
  });
});

/*
 * docs/supabase-assisted-menu-import.sql: draft categories, the CSV import
 * and "Set photo for a category". Installed (twice) by the before() hook above.
 */
type ImportItem = { name: string; price: string; category?: string | null; hidden?: boolean; note?: string | null };
type ImportCounts = { imported: number; hidden: number; skipped: number; existing_hidden: number; replace_all: boolean };

const importMenu = (shopId: string, items: ImportItem[], replaceAll = false, who: Who = "admin") =>
  as(who, async () =>
    (await one<{ r: ImportCounts }>("select public.admin_import_assisted_menu($1, $2::jsonb, $3) as r", [shopId, JSON.stringify(items), replaceAll])).r
  );
const categoryPhoto = (shopId: string, category: string | null, url: string, replace = false, who: Who = "admin") =>
  as(who, async () =>
    (await one<{ n: number }>("select public.admin_set_assisted_category_photo($1, $2, $3, $4) as n", [shopId, category, url, replace])).n
  );
const draftItems = (shopId: string) =>
  q<{ name: string; price: string; category: string | null; is_hidden: boolean; photo_url: string | null }>(
    "select name, price::text, category, is_hidden, photo_url from public.assisted_shop_items where shop_id = $1 order by created_at, id",
    [shopId]
  );
const auditActions = async (shopId: string) =>
  (await q<{ action: string }>("select action from public.assisted_onboarding_audit where shop_id = $1 order by id", [shopId])).map((r) => r.action);
const auditDetails = (shopId: string, action: string) =>
  q<{ details: Record<string, unknown> }>("select details from public.assisted_onboarding_audit where shop_id = $1 and action = $2 order by id", [shopId, action]);

let menuMobile = 85550000;
const menuDraft = () => createDraft({ owner_mobile: String(menuMobile++) });

/** A fresh database with the onboarding stack; withMenu also installs the menu import file. */
async function freshStack(withMenu: boolean): Promise<PGlite> {
  const fresh = new PGlite();
  await fresh.exec(STUBS);
  for (const sql of BILLING) await fresh.exec(sql);
  await fresh.exec(KITCHEN_ADMIN);
  await fresh.exec(SCRIPT);
  if (withMenu) await fresh.exec(MENU_IMPORT);
  return fresh;
}

describe("menu import — install", () => {
  it("leaves the claim, the kitchen guard, the terms trigger and the draft item guard exactly as they were", async () => {
    const fresh = await freshStack(false);
    const fp = async () =>
      (
        await fresh.query(`select md5(pg_get_functiondef('public.assisted_claim_complete(text, text, uuid, text, text)'::regprocedure)) as claim,
                                  md5(pg_get_functiondef('public.guard_admin_kitchen_edit()'::regprocedure)) as guard,
                                  md5(pg_get_functiondef('public.stamp_kitchen_terms_acknowledgement()'::regprocedure)) as terms,
                                  md5(pg_get_functiondef('public.guard_assisted_shop_item()'::regprocedure)) as item_guard`)
      ).rows[0];
    const before = await fp();
    const results = await fresh.exec(MENU_IMPORT);
    assert.equal((results[results.length - 1].rows[0] as { result: string }).result, "MENU IMPORT INSTALLED");
    assert.deepEqual(await fp(), before);
    await fresh.close();
  });

  it("the onboarding file's own fingerprint check still passes (it refuses to re-run, with nothing changed)", async () => {
    // The onboarding file's section 9 compares the guard and terms functions; they are untouched (test above).
    // Once the menu file is installed, re-running the onboarding file is refused up front instead of undoing it.
    assert.deepEqual(await fingerprint(), before_fp);
    let message = "";
    try {
      await db.exec(SCRIPT);
    } catch (e) {
      message = (e as Error).message;
    } finally {
      await db.exec("rollback").catch(() => {});
    }
    assert.match(message, /supabase-assisted-menu-import\.sql is installed.*Nothing was changed/);
    assert.equal((await one<{ n: number }>("select count(*)::int as n from information_schema.columns where table_name = 'assisted_shop_items' and column_name = 'category'")).n, 1);
  });

  it("refuses to run before the onboarding file, and nothing changes", async () => {
    const fresh = new PGlite();
    await fresh.exec(STUBS);
    await fresh.exec(KITCHEN_ADMIN);
    let message = "";
    try {
      await fresh.exec(MENU_IMPORT);
    } catch (e) {
      message = (e as Error).message;
    }
    assert.match(message, /menu import: missing .*assisted_shop_items.*Nothing was changed/);
    await fresh.exec("rollback");
    assert.equal((await fresh.query<{ n: number }>("select count(*)::int as n from pg_proc where proname = 'admin_import_assisted_menu'")).rows[0].n, 0);
    await fresh.close();
  });

  it("re-running changes nothing (functions, triggers, constraints, grants, data)", async () => {
    const fresh = await freshStack(true);
    const snap = async () => ({
      fns: (await fresh.query("select proname, prosrc, prosecdef, proconfig, proacl::text from pg_proc where proname in ('admin_import_assisted_menu', 'admin_set_assisted_category_photo', 'audit_assisted_onboarding_row', 'normalize_assisted_item_fields') order by proname")).rows,
      trg: (await fresh.query("select tgname, pg_get_triggerdef(oid) as d from pg_trigger where tgrelid = 'public.assisted_shop_items'::regclass and not tgisinternal order by tgname")).rows,
      con: (await fresh.query("select conname, pg_get_constraintdef(oid) as d from pg_constraint where conname in ('assisted_shop_items_category_check', 'assisted_onboarding_audit_action_check') order by conname")).rows,
      acl: (await fresh.query("select attname, attacl::text from pg_attribute where attrelid = 'public.assisted_shop_items'::regclass and attnum > 0 and not attisdropped order by attnum")).rows,
    });
    const first = await snap();
    await fresh.exec(MENU_IMPORT);
    assert.deepEqual(await snap(), first);
    await fresh.close();
  });

  it("category: HQ can read, set and change it; trimmed with inner spaces collapsed; over 60 refused; anon has nothing", async () => {
    const shopId = await menuDraft();
    const itemId = await as("admin", async () =>
      (await one<{ id: string }>("insert into public.assisted_shop_items (shop_id, name, price, category) values ($1, 'Kopi', 1.5, '  Hot   Drinks ') returning id", [shopId])).id
    );
    assert.equal((await one<{ category: string }>("select category from public.assisted_shop_items where id = $1", [itemId])).category, "Hot Drinks");
    await as("admin", () => q("update public.assisted_shop_items set category = '   ' where id = $1", [itemId]));
    assert.equal((await one<{ category: string | null }>("select category from public.assisted_shop_items where id = $1", [itemId])).category, null);
    await rejects(as("admin", () => q("update public.assisted_shop_items set category = $2 where id = $1", [itemId, "c".repeat(61)])), /assisted_shop_items_category_check/);
    assert.equal((await one<{ ok: boolean }>("select has_column_privilege('anon', 'public.assisted_shop_items', 'category', 'select') as ok")).ok, false);
  });
});

describe("menu import — admin_import_assisted_menu", () => {
  it("imports in file order with categories, hidden rows hidden, and writes ONE summary audit row with counts only", async () => {
    const shopId = await menuDraft();
    const counts = await importMenu(shopId, [
      { name: "Kaya Toast", price: "2.20", category: "Breakfast" },
      { name: "Teh Tarik", price: "1.80", category: "Drinks", hidden: true },
      { name: "Soft-boiled Eggs", price: "1.60", category: "Breakfast" },
      { name: "Plain water", price: "0.50", category: null },
    ]);
    assert.deepEqual(counts, { imported: 4, hidden: 1, skipped: 0, existing_hidden: 0, replace_all: false });
    assert.deepEqual(await draftItems(shopId), [
      { name: "Kaya Toast", price: "2.20", category: "Breakfast", is_hidden: false, photo_url: null },
      { name: "Teh Tarik", price: "1.80", category: "Drinks", is_hidden: true, photo_url: null },
      { name: "Soft-boiled Eggs", price: "1.60", category: "Breakfast", is_hidden: false, photo_url: null },
      { name: "Plain water", price: "0.50", category: null, is_hidden: false, photo_url: null },
    ]);
    assert.deepEqual(await auditActions(shopId), ["shop_created", "menu_imported"], "no item_added rows");
    const [{ details }] = await auditDetails(shopId, "menu_imported");
    assert.deepEqual(details, { imported: 4, hidden: 1, skipped: 0, existing_hidden: 0, replace_all: false });
    assert.doesNotMatch(JSON.stringify(details), /Kaya|Breakfast|Teh/);
    assert.equal((await one<{ s: string }>("select coalesce(current_setting('kb_assist.bulk', true), '') as s")).s, "");
  });

  it("skips rows already in the draft, visible or hidden, ignoring case and extra spaces; same name in another category is new", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [
      { name: "Laksa", price: "6", category: "Noodles" },
      { name: "Mee Siam", price: "5", category: "Noodles", hidden: true },
    ]);
    const counts = await importMenu(shopId, [
      { name: "  LAKSA ", price: "6.50", category: "noodles" },
      { name: "mee  siam", price: "5", category: " Noodles " },
      { name: "Laksa", price: "7", category: "Specials" },
    ]);
    assert.equal(counts.imported, 1);
    assert.equal(counts.skipped, 2);
    assert.deepEqual((await draftItems(shopId)).map((i) => `${i.name}/${i.category}/${i.price}`), ["Laksa/Noodles/6.00", "Mee Siam/Noodles/5.00", "Laksa/Specials/7.00"]);
  });

  it("replace all hides every visible item (none deleted) and adds the whole file", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [
      { name: "Old A", price: "1", category: "X" },
      { name: "Old B", price: "2", category: "X", hidden: true },
      { name: "Old C", price: "3" },
    ]);
    const counts = await importMenu(shopId, [{ name: "Old A", price: "1.50", category: "X" }, { name: "New", price: "4" }], true);
    assert.deepEqual(counts, { imported: 2, hidden: 0, skipped: 0, existing_hidden: 2, replace_all: true });
    const items = await draftItems(shopId);
    assert.equal(items.length, 5, "nothing deleted");
    assert.deepEqual(items.filter((i) => !i.is_hidden).map((i) => i.name), ["Old A", "New"]);
    assert.deepEqual(await auditActions(shopId), ["shop_created", "menu_imported", "menu_imported"], "no item_hidden / item_added rows");
  });

  it("refuses bad rows and writes nothing: empty name, bad prices, long name/category, duplicates in the file, over 200 rows, bad hidden", async () => {
    const shopId = await menuDraft();
    const bad: [ImportItem[], RegExp][] = [
      [[{ name: "  ", price: "1" }], /Row 1: the name is empty/],
      [[{ name: "A", price: "1" }, { name: "B", price: "abc" }], /Row 2: the price/],
      [[{ name: "A", price: "0" }], /Row 1: the price/],
      [[{ name: "A", price: "-1" }], /Row 1: the price/],
      [[{ name: "A", price: "4.555" }], /Row 1: the price/],
      [[{ name: "A", price: "10000" }], /Row 1: the price/],
      [[{ name: "A", price: "1e3" }], /Row 1: the price/],
      [[{ name: "n".repeat(81), price: "1" }], /Row 1: the name is longer than 80/],
      [[{ name: "A", price: "1", category: "c".repeat(61) }], /Row 1: the category is longer than 60/],
      [[{ name: "Laksa", price: "1", category: "N" }, { name: " laksa ", price: "2", category: "n" }], /Row 2: the same name/],
      [Array.from({ length: 201 }, (_, i) => ({ name: `Item ${i}`, price: "1" })), /201 rows; the most is 200/],
      [[], /no rows/],
    ];
    for (const [items, pattern] of bad) await rejects(importMenu(shopId, items), pattern);
    await rejects(
      as("admin", () => q("select public.admin_import_assisted_menu($1, $2::jsonb, false)", [shopId, JSON.stringify([{ name: "A", price: "1", hidden: "yes" }])])),
      /hidden must be true or false/
    );
    assert.deepEqual(await draftItems(shopId), []);
    assert.deepEqual(await auditActions(shopId), ["shop_created"]);
  });

  it("200 rows is fine", async () => {
    const shopId = await menuDraft();
    const counts = await importMenu(shopId, Array.from({ length: 200 }, (_, i) => ({ name: `Item ${i}`, price: "1.00", category: `Cat ${i % 7}` })));
    assert.equal(counts.imported, 200);
    assert.deepEqual((await draftItems(shopId)).slice(0, 3).map((i) => i.name), ["Item 0", "Item 1", "Item 2"]);
  });

  it("refuses non-admins, anon, service_role, unknown shops, cancelled and claimed shops", async () => {
    const shopId = await menuDraft();
    const row = [{ name: "A", price: "1" }];
    await rejects(importMenu(shopId, row, false, "customer"), /admins only/);
    await rejects(importMenu(shopId, row, false, "anon"), /permission denied/);
    await rejects(importMenu(shopId, row, false, "service"), /permission denied/);
    await rejects(importMenu(id(778), row), /Shop not found/);

    const cancelled = await menuDraft();
    await as("admin", () => q("select public.admin_cancel_assisted_shop($1, 'test')", [cancelled]));
    await rejects(importMenu(cancelled, row), /already been claimed or cancelled/);

    const claimed = await menuDraft();
    await addItem(claimed, "Char kway teow", 6);
    const { hash } = await issue(claimed);
    assert.equal((await complete(hash, await newOwnerAccount(claimed, 530))).status, "ok");
    await rejects(importMenu(claimed, row), /already been claimed or cancelled/);
    await rejects(categoryPhoto(claimed, null, "https://example.com/x.jpg"), /already been claimed or cancelled/);
  });
});

describe("menu import — owner_note (HQ only, draft only, never in the audit)", () => {
  const notes = (shopId: string) =>
    q<{ name: string; owner_note: string | null; is_hidden: boolean }>(
      "select name, owner_note, is_hidden from public.assisted_shop_items where shop_id = $1 order by created_at, id",
      [shopId]
    );
  const auditText = async (shopId: string) =>
    (await q<{ t: string }>("select details::text as t from public.assisted_onboarding_audit where shop_id = $1", [shopId])).map((r) => r.t).join(" ");

  it("the column: trimmed, '' clears it, over 200 refused; granted to signed-in users like the other columns, nothing for anon or service_role", async () => {
    const shopId = await menuDraft();
    const itemId = await as("admin", async () =>
      (await one<{ id: string }>("insert into public.assisted_shop_items (shop_id, name, price, owner_note) values ($1, 'Kopi', 1.5, '  ask price  ') returning id", [shopId])).id
    );
    assert.equal((await notes(shopId))[0].owner_note, "ask price");
    await as("admin", () => q("update public.assisted_shop_items set owner_note = '   ' where id = $1", [itemId]));
    assert.equal((await notes(shopId))[0].owner_note, null);
    await rejects(as("admin", () => q("update public.assisted_shop_items set owner_note = $2 where id = $1", [itemId, "n".repeat(201)])), /assisted_shop_items_owner_note_check/);
    await as("admin", () => q("update public.assisted_shop_items set owner_note = $2 where id = $1", [itemId, "n".repeat(200)]));
    const priv = await one<Record<string, boolean>>(`select
      has_column_privilege('authenticated', 'public.assisted_shop_items', 'owner_note', 'select') as auth_select,
      has_column_privilege('authenticated', 'public.assisted_shop_items', 'owner_note', 'update') as auth_update,
      has_column_privilege('anon', 'public.assisted_shop_items', 'owner_note', 'select') as anon_select,
      has_column_privilege('service_role', 'public.assisted_shop_items', 'owner_note', 'select') as service_select`);
    assert.deepEqual(priv, { auth_select: true, auth_update: true, anon_select: false, service_select: false });
    // RLS: only admins see draft items at all, so a customer never reads a note.
    assert.deepEqual(await as("customer", () => q("select owner_note from public.assisted_shop_items where shop_id = $1", [shopId])), []);
  });

  it("the import saves check_with_owner as the note on the hidden rows; a note on a visible row or over 200 is refused", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [
      { name: "Kaya Toast", price: "2", category: "Breakfast" },
      { name: "Eggs", price: "1.6", category: "Breakfast", hidden: true, note: "  Ask if half-boiled or soft  " },
    ]);
    assert.deepEqual(await notes(shopId), [
      { name: "Kaya Toast", owner_note: null, is_hidden: false },
      { name: "Eggs", owner_note: "Ask if half-boiled or soft", is_hidden: true },
    ]);
    assert.doesNotMatch(await auditText(shopId), /half-boiled/, "the summary row has counts only");
    await rejects(importMenu(shopId, [{ name: "Milo", price: "2", note: "check" }]), /Row 1: a row with a check-with-owner note must be imported hidden/);
    await rejects(importMenu(shopId, [{ name: "Milo", price: "2", hidden: true, note: "n".repeat(201) }]), /Row 1: the check-with-owner note is longer than 200/);
    await rejects(
      as("admin", () => q("select public.admin_import_assisted_menu($1, $2::jsonb, false)", [shopId, JSON.stringify([{ name: "Milo", price: "2", hidden: true, note: 5 }])])),
      /Row 1: the note must be text/
    );
  });

  it("HQ editing or clearing a note is audited as 'none' / 'set' only, never the text", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [{ name: "Laksa", price: "6", hidden: true, note: "secret supplier question" }]);
    const [{ id: itemId }] = await q<{ id: string }>("select id from public.assisted_shop_items where shop_id = $1", [shopId]);
    await as("admin", () => q("update public.assisted_shop_items set owner_note = 'another private question' where id = $1", [itemId]));
    await as("admin", () => q("update public.assisted_shop_items set owner_note = null, price = 6.5 where id = $1", [itemId]));
    const rows = await auditDetails(shopId, "item_updated");
    assert.deepEqual(
      rows.map((r) => (r.details.changes as Record<string, unknown>).owner_note),
      [
        { old: "set", new: "set" },
        { old: "set", new: "none" },
      ],
      "an edited note is logged as edited (set -> set), a cleared one as set -> none; never the text"
    );
    const added = await as("admin", async () =>
      (await one<{ id: string }>("insert into public.assisted_shop_items (shop_id, name, price, owner_note) values ($1, 'Mee', 5, 'typed by HQ') returning id", [shopId])).id
    );
    const [addedRow] = (await auditDetails(shopId, "item_added")).filter((r) => r.details.item_id === added);
    assert.deepEqual((addedRow.details.changes as Record<string, unknown>).owner_note, { old: null, new: "set" });
    assert.doesNotMatch(await auditText(shopId), /secret|private|typed by HQ/);
  });

  it("not in the claim preview and not copied at claim (claim functions unchanged)", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [
      { name: "Kaya Toast", price: "2", category: "Breakfast" },
      { name: "Eggs", price: "1.6", hidden: true, note: "ask the owner first" },
    ]);
    await as("admin", () => q("update public.assisted_shop_items set owner_note = 'visible item note' where shop_id = $1 and name = 'Kaya Toast'", [shopId]));
    const { hash } = await issue(shopId);
    const shown = await preview(hash);
    assert.doesNotMatch(JSON.stringify(shown), /owner_note|visible item note|ask the owner first/);
    const owner = await newOwnerAccount(shopId, 532);
    assert.equal((await complete(hash, owner)).status, "ok");
    assert.deepEqual(await q("select name from public.menu_items where kitchen_id = $1", [owner]), [{ name: "Kaya Toast" }]);
    assert.equal((await one<{ n: number }>("select count(*)::int as n from information_schema.columns where table_name = 'menu_items' and column_name = 'owner_note'")).n, 0);
    assert.equal(
      (await one<{ n: number }>("select count(*)::int as n from pg_proc where proname in ('assisted_claim_complete', 'assisted_claim_preview') and prosrc like '%owner_note%'")).n,
      0
    );
  });
});

describe("menu import — admin_set_assisted_category_photo", () => {
  it("fills only items with no photo, hidden ones included, other categories untouched; one summary row, no item_updated rows", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [
      { name: "Kaya Toast", price: "2", category: "Breakfast" },
      { name: "Eggs", price: "1.6", category: "Breakfast", hidden: true },
      { name: "Toast set", price: "4", category: "Breakfast" },
      { name: "Kopi", price: "1.5", category: "Drinks" },
      { name: "Water", price: "0.5" },
    ]);
    await as("admin", () => q("update public.assisted_shop_items set photo_url = 'https://example.com/own.jpg' where shop_id = $1 and name = 'Toast set'", [shopId]));

    assert.equal(await categoryPhoto(shopId, " BREAKFAST ", "https://example.com/b.jpg"), 2);
    const photos = Object.fromEntries((await draftItems(shopId)).map((i) => [i.name, i.photo_url]));
    assert.deepEqual(photos, {
      "Kaya Toast": "https://example.com/b.jpg",
      Eggs: "https://example.com/b.jpg",
      "Toast set": "https://example.com/own.jpg",
      Kopi: null,
      Water: null,
    });
    assert.deepEqual(await auditActions(shopId), ["shop_created", "menu_imported", "item_updated", "category_photo_set"]);
    assert.deepEqual((await auditDetails(shopId, "category_photo_set"))[0].details, { updated: 2, items_in_category: 3, replace_existing: false });
  });

  it("replace_existing changes the ones with another photo too (not ones already on it); null category = items with no category", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [
      { name: "A", price: "1", category: "Rice" },
      { name: "B", price: "1", category: "Rice" },
      { name: "C", price: "1" },
      { name: "D", price: "1", category: "" },
    ]);
    assert.equal(await categoryPhoto(shopId, "rice", "https://example.com/1.jpg"), 2);
    assert.equal(await categoryPhoto(shopId, "rice", "https://example.com/1.jpg", true), 0, "already on that photo");
    assert.equal(await categoryPhoto(shopId, "Rice", "https://example.com/2.jpg"), 0, "both have a photo now");
    assert.equal(await categoryPhoto(shopId, "Rice", "https://example.com/2.jpg", true), 2);
    assert.equal(await categoryPhoto(shopId, null, "https://example.com/none.jpg"), 2);
    assert.equal(await categoryPhoto(shopId, "   ", "https://example.com/none2.jpg", true), 2, "blank = no category");
    assert.deepEqual((await draftItems(shopId)).map((i) => i.photo_url), [
      "https://example.com/2.jpg",
      "https://example.com/2.jpg",
      "https://example.com/none2.jpg",
      "https://example.com/none2.jpg",
    ]);
    assert.equal((await auditActions(shopId)).filter((a) => a === "item_updated").length, 0);
  });

  it("individual photos can still be changed afterwards, and that edit is audited per item as before", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [{ name: "A", price: "1", category: "Rice" }]);
    await categoryPhoto(shopId, "Rice", "https://example.com/1.jpg");
    await as("admin", () => q("update public.assisted_shop_items set photo_url = 'https://example.com/mine.jpg' where shop_id = $1", [shopId]));
    assert.equal((await draftItems(shopId))[0].photo_url, "https://example.com/mine.jpg");
    assert.deepEqual(await auditActions(shopId), ["shop_created", "menu_imported", "category_photo_set", "item_updated"]);
  });

  it("refuses bad links, long categories, non-admins, anon and cancelled shops", async () => {
    const shopId = await menuDraft();
    for (const url of ["", "javascript:alert(1)", "ftp://x/y.jpg", "https://exa mple.com/x.jpg", `https://example.com/${"x".repeat(2000)}`]) {
      await rejects(categoryPhoto(shopId, null, url), /must be an uploaded photo or a web link/);
    }
    await rejects(categoryPhoto(shopId, "c".repeat(61), "https://example.com/x.jpg"), /longer than 60/);
    await rejects(categoryPhoto(shopId, null, "https://example.com/x.jpg", false, "customer"), /admins only/);
    await rejects(categoryPhoto(shopId, null, "https://example.com/x.jpg", false, "anon"), /permission denied/);
    await as("admin", () => q("select public.admin_cancel_assisted_shop($1, 'test')", [shopId]));
    await rejects(categoryPhoto(shopId, null, "https://example.com/x.jpg"), /already been claimed or cancelled/);
  });
});

describe("menu import — claim and live test", () => {
  it("the claim copies visible items with their photos but not the category (claim function unchanged)", async () => {
    const shopId = await menuDraft();
    await importMenu(shopId, [
      { name: "Kaya Toast", price: "2.20", category: "Breakfast" },
      { name: "Check me", price: "3", category: "Breakfast", hidden: true },
    ]);
    await categoryPhoto(shopId, "Breakfast", "https://example.com/b.jpg");
    const { hash } = await issue(shopId);
    const owner = await newOwnerAccount(shopId, 531);
    assert.equal((await complete(hash, owner)).status, "ok");
    assert.deepEqual(await q("select name, price::text, photo_url from public.menu_items where kitchen_id = $1", [owner]), [
      { name: "Kaya Toast", price: "2.20", photo_url: "https://example.com/b.jpg" },
    ]);
    assert.equal((await one<{ n: number }>("select count(*)::int as n from information_schema.columns where table_name = 'menu_items' and column_name = 'category'")).n, 0);
  });

  it("the menu import live test passes and rolls everything back", async () => {
    const tables = ["public.assisted_shops", "public.assisted_shop_items", "public.assisted_onboarding_audit"];
    const counts = () => Promise.all(tables.map(async (t) => (await one<{ n: number }>(`select count(*)::int as n from ${t}`)).n));
    const before = await counts();
    let message = "(the live test finished without its closing exception)";
    try {
      await db.exec(MENU_LIVE_TEST.replaceAll("PUT-ADMIN-ID", ADMIN));
    } catch (e) {
      message = (e as Error).message;
    } finally {
      await db.exec("rollback").catch(() => {});
      await db.exec("reset role").catch(() => {});
    }
    assert.match(message, /^TEST OK, rolled back/);
    assert.deepEqual(await counts(), before);
  });

  it("the live test refuses without an admin id", async () => {
    let message = "";
    try {
      await db.exec(MENU_LIVE_TEST);
    } catch (e) {
      message = (e as Error).message;
    } finally {
      await db.exec("rollback").catch(() => {});
    }
    assert.match(message, /REFUSED: fill in PUT-ADMIN-ID first/);
  });
});

// ---------------------------------------------------------------------------
// The UEN after claiming: docs/supabase-assisted-uen-later.sql and its live test.
// Built on the live definitions: src/lib/testing/live-uen-functions.sql holds
// them verbatim and is loaded over the stand-ins above. Every fingerprint
// ignores line endings: md5(replace(pg_get_functiondef(oid), E'\r', '')).
// ---------------------------------------------------------------------------

const UEN_LATER = read("supabase-assisted-uen-later.sql");
const UEN_LIVE_TEST = read("supabase-assisted-uen-later-live-test.sql");
const LIVE_UEN_FUNCTIONS = readFileSync(new URL("./testing/live-uen-functions.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** What live answered to md5(pg_get_functiondef(oid)) on 2026-11-27 (with its Windows line endings). */
const LIVE_RAW_MD5: Record<string, string> = {
  assisted_claim_complete: "d355a6d0016cb6ddc6bb78d21d186b7c",
  admin_issue_assisted_claim_link: "5578ec37e4091839c4566ba7d34d92d6",
  check_cook_application_uen: "c9ea17375a8e98a6b4488db312a95946",
  guard_cook_application: "88eda3d83c8d2d554fd138bc7c8afbad",
  set_kitchen_business_uen: "daf7e4f43c96e2fa6a520ef635f32203",
  sync_kitchen_business_uen: "d222b7f7e1380c6246636aa9c36fae65",
  approved_business_uen: "90f772d15784447550922dfb336f3519",
  guard_admin_kitchen_edit: "3069a7a97174a86d74fc11a6b3776bd9",
  stamp_kitchen_terms_acknowledgement: "18cccd13bf95c162e2fcf8b54bd680ec",
};
const UNTOUCHED = ["guard_admin_kitchen_edit", "stamp_kitchen_terms_acknowledgement", "guard_cook_application", "set_kitchen_business_uen", "sync_kitchen_business_uen", "approved_business_uen"];
const CHANGED = ["check_cook_application_uen", "assisted_claim_complete", "admin_issue_assisted_claim_link"];
const ADDED = ["set_my_business_uen", "admin_set_kitchen_business_uen", "kitchen_live_needs_uen"];

/** The pins in the file: section 0's (name, before, after) rows, and section 8's (name, after) rows. */
const UEN_PINS = (() => {
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const m of UEN_LATER.matchAll(/\('public\.(\w+)\([^']*\)', '([0-9a-f]{32})', '([0-9a-f]{32})'\)/g)) before[m[1]] = m[2];
  const checksAfter = UEN_LATER.slice(UEN_LATER.indexOf("-- 8. CHECKS AFTER"));
  for (const m of checksAfter.matchAll(/\('public\.(\w+)\([^']*\)', '([0-9a-f]{32})'\)/g)) after[m[1]] = m[2];
  return { before, after };
})();

/** One function's text from a file: from its "create or replace function" to the closing $$; (the last one wins). */
function functionText(sql: string, name: string): string {
  const start = sql.toLowerCase().lastIndexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  return sql.slice(start, sql.indexOf("\n$$;", start) + 4);
}

const FP_SQL = `select p.proname as name, md5(replace(pg_get_functiondef(p.oid), E'\\r', '')) as fp
                from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])`;
async function fingerprints(d: PGlite, names: string[]): Promise<Record<string, string>> {
  const rows = (await d.query<{ name: string; fp: string }>(FP_SQL, [names])).rows;
  return Object.fromEntries(rows.map((r) => [r.name, r.fp]));
}

/** The live cook_applications policies (Partner docs/supabase-schema.sql section 2); the stand-ins have none. */
const APPLICATION_POLICIES = `
create policy "Applicants can read their own cook application" on public.cook_applications for select using (auth.uid() = user_id);
create policy "Applicants can submit a cook application" on public.cook_applications for insert with check (auth.uid() = user_id);
create policy "Admins can read every cook application" on public.cook_applications for select using (public.user_has_role('admin'));
create policy "Admins can update every cook application" on public.cook_applications for update using (public.user_has_role('admin'));
`;

/** The onboarding + menu stack with the live UEN functions, as live is before the new file. */
async function uenStack(crlf = false): Promise<PGlite> {
  const fresh = await freshStack(true);
  await fresh.exec(APPLICATION_POLICIES);
  await fresh.exec(crlf ? LIVE_UEN_FUNCTIONS.replace(/\n/g, "\r\n") : LIVE_UEN_FUNCTIONS);
  return fresh;
}

async function runScript(d: PGlite, sql: string): Promise<{ result: string | null; error: string | null }> {
  try {
    const results = await d.exec(sql);
    const last = results[results.length - 1]?.rows[0] as { result?: string } | undefined;
    return { result: last?.result ?? null, error: null };
  } catch (e) {
    await d.exec("rollback").catch(() => {});
    await d.exec("reset role").catch(() => {});
    return { result: null, error: (e as Error).message };
  }
}

/** Re-creates a function from its own definition with one extra comment line: a "drifted" live copy. */
async function drift(d: PGlite, signature: string) {
  const def = (await d.query<{ d: string }>(`select pg_get_functiondef('${signature}'::regprocedure) as d`)).rows[0].d;
  const changed = def.replace(/\n(begin|declare)\n/, "\n$1\n  -- changed by hand on live\n");
  assert.notEqual(changed, def);
  await d.exec(changed);
}

describe("UEN after claiming — pins and install", () => {
  it("the file pins every function: 9 before, 9 + 3 new after", () => {
    assert.deepEqual(Object.keys(UEN_PINS.before).sort(), [...UNTOUCHED, ...CHANGED].sort());
    assert.deepEqual(Object.keys(UEN_PINS.after).sort(), [...UNTOUCHED, ...CHANGED, ...ADDED].sort());
    for (const n of UNTOUCHED) assert.equal(UEN_PINS.after[n], UEN_PINS.before[n], `${n} must stay identical`);
    for (const n of CHANGED) assert.notEqual(UEN_PINS.after[n], UEN_PINS.before[n], `${n} changes`);
  });

  it("the before pins are the live definitions: with Windows line endings they give live's own md5s, and the pins ignore line endings", async () => {
    const guardAdmin = functionText(KITCHEN_ADMIN, "guard_admin_kitchen_edit");
    for (const [crlf, label] of [[true, "CRLF"], [false, "LF"]] as const) {
      const bare = new PGlite();
      await bare.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
        create type public.assisted_claim_tokens as (id uuid); create type public.assisted_shops as (id uuid);`);
      for (const n of Object.keys(LIVE_RAW_MD5)) {
        // Live = this repo's text for these two (they matched exactly); the fixture for the rest.
        const text =
          n === "guard_admin_kitchen_edit" ? guardAdmin : n === "admin_issue_assisted_claim_link" ? functionText(SCRIPT, n) : functionText(LIVE_UEN_FUNCTIONS, n);
        await bare.exec("set check_function_bodies = off;\n" + (crlf ? text.replace(/\n/g, "\r\n") : text));
      }
      const rows = (await bare.query<{ name: string; raw: string; fp: string }>(
        `select p.proname as name, md5(pg_get_functiondef(p.oid)) as raw, md5(replace(pg_get_functiondef(p.oid), E'\\r', '')) as fp
         from pg_proc p where p.pronamespace = 'public'::regnamespace`
      )).rows;
      for (const n of Object.keys(LIVE_RAW_MD5)) {
        const r = rows.find((x) => x.name === n)!;
        if (crlf) assert.equal(r.raw, LIVE_RAW_MD5[n], `${label} ${n}: the fixture is not the live text`);
        assert.equal(r.fp, UEN_PINS.before[n], `${label} ${n}: the pin`);
      }
      await bare.close();
    }
  });

  it("installs: exactly three functions change, the other six (kitchen guard and terms trigger included) are identical, new fingerprints as pinned; a re-run changes nothing", async () => {
    const fresh = await uenStack();
    const all = [...UNTOUCHED, ...CHANGED, ...ADDED];
    const before = await fingerprints(fresh, all);
    for (const n of [...UNTOUCHED, ...CHANGED]) assert.equal(before[n], UEN_PINS.before[n], `${n} before`);
    for (const n of ADDED) assert.equal(before[n], undefined);

    assert.deepEqual(await runScript(fresh, UEN_LATER), { result: "UEN LATER INSTALLED", error: null });
    const after = await fingerprints(fresh, all);
    for (const n of all) assert.equal(after[n], UEN_PINS.after[n], `${n} after`);
    for (const n of UNTOUCHED) assert.equal(after[n], before[n], `${n} untouched`);

    const triggers = async () =>
      (await fresh.query<{ tgname: string }>("select tgname from pg_trigger where tgrelid = 'public.kitchens'::regclass and not tgisinternal and (tgtype & 2) <> 0 order by tgname")).rows.map((r) => r.tgname);
    const order = await triggers();
    assert.equal(order[order.length - 1], "y_kitchen_live_needs_uen");
    assert.ok(order.indexOf("before_kitchen_business_uen") < order.indexOf("y_kitchen_live_needs_uen"));
    assert.ok(order.includes("kitchens_live_since_stamp"));

    assert.deepEqual(await runScript(fresh, UEN_LATER), { result: "UEN LATER INSTALLED", error: null });
    assert.deepEqual(await fingerprints(fresh, all), after);
    assert.deepEqual(await triggers(), order);
    await fresh.close();
  });

  it("pasted with Windows line endings (and installed over CRLF live text) it installs the same", async () => {
    const fresh = await uenStack(true);
    assert.deepEqual(await runScript(fresh, UEN_LATER.replace(/\n/g, "\r\n")), { result: "UEN LATER INSTALLED", error: null });
    const after = await fingerprints(fresh, [...UNTOUCHED, ...CHANGED, ...ADDED]);
    for (const [n, fp] of Object.entries(after)) assert.equal(fp, UEN_PINS.after[n], n);
    await fresh.close();
  });

  for (const [signature, name] of [
    ["public.guard_cook_application()", "an untouched function (guard_cook_application)"],
    ["public.guard_admin_kitchen_edit()", "the kitchen guard"],
    ["public.stamp_kitchen_terms_acknowledgement()", "the terms trigger"],
    ["public.assisted_claim_complete(text, text, uuid, text, text)", "a function it changes (the claim)"],
    ["public.check_cook_application_uen()", "a function it changes (the UEN check)"],
  ] as const) {
    it(`stops with nothing changed when ${name} differs from the pinned live text`, async () => {
      const fresh = await uenStack();
      await drift(fresh, signature);
      const drifted = await fingerprints(fresh, [...UNTOUCHED, ...CHANGED]);
      const { result, error } = await runScript(fresh, UEN_LATER);
      assert.equal(result, null);
      assert.match(error ?? "", new RegExp(`^Stopped: ${signature.replace(/[()]/g, "\\$&")} is not the version this file was written for .*Nothing was changed`));
      assert.deepEqual(await fingerprints(fresh, [...UNTOUCHED, ...CHANGED]), drifted, "nothing changed");
      assert.deepEqual(await fingerprints(fresh, ADDED), {}, "no new function");
      assert.equal((await fresh.query("select 1 from pg_trigger where tgname = 'y_kitchen_live_needs_uen'")).rows.length, 0);
      await fresh.close();
    });
  }

  it("stops when a new function already exists with other text", async () => {
    const fresh = await uenStack();
    await fresh.exec("create function public.set_my_business_uen(p_uen text) returns text language sql as $$ select p_uen $$;");
    const { error } = await runScript(fresh, UEN_LATER);
    assert.match(error ?? "", /^Stopped: public\.set_my_business_uen\(text\) already exists and is not this file's version/);
    assert.equal((await fingerprints(fresh, ["assisted_claim_complete"])).assisted_claim_complete, UEN_PINS.before.assisted_claim_complete);
    await fresh.close();
  });

  it("stops when a BEFORE trigger on kitchens would fire after the new one", async () => {
    const fresh = await uenStack();
    await fresh.exec("create trigger z_late_before before update on public.kitchens for each row execute function public.touch_kitchen_updated_at();");
    const { error } = await runScript(fresh, UEN_LATER);
    assert.match(error ?? "", /^Stopped: BEFORE trigger\(s\) z_late_before on kitchens would fire after y_kitchen_live_needs_uen/);
    await fresh.close();
  });

  it("the claim diff is the flag lines and the billing-off comment only; the claim link loses only its UEN check; the UEN check only its null branch", () => {
    const lines = (s: string) => s.split("\n");
    const diff = (a: string, b: string) => {
      const A = new Set(lines(a));
      const B = new Set(lines(b));
      return { removed: lines(a).filter((l) => !B.has(l)), added: lines(b).filter((l) => !A.has(l)) };
    };
    const claim = diff(functionText(LIVE_UEN_FUNCTIONS, "assisted_claim_complete"), functionText(UEN_LATER, "assisted_claim_complete"));
    assert.deepEqual(claim.removed, [
      "  --    to 'cook' and create the subscription row and founding number (fail",
      "  --    closed: an error there undoes the whole claim). created_at = when HQ",
      "  --    set the shop up, which is what founding eligibility reads.",
    ]);
    assert.deepEqual(claim.added, [
      "  --    to 'cook'. The billing trigger makes no subscription row and no",
      "  --    founding number while billing is off (the pilot); if billing is ever",
      "  --    on it fails closed (an error there undoes the whole claim).",
      "  --    created_at = when HQ set the shop up.",
      "  --    A shop that isn't Home Cook may be claimed before its UEN is in: the",
      "  --    flag lets this one insert through check_cook_application_uen.",
      "  if v_shop.category <> 'home-cook' and v_shop.business_uen is null then",
      "    perform pg_catalog.set_config('kb_assist.uen_pending', 'on', true);",
      "  perform pg_catalog.set_config('kb_assist.uen_pending', '', true);",
    ]);
    // The claim's comment now matches the repo's onboarding file (billing off).
    assert.ok(SCRIPT.includes("  --    to 'cook'. The billing trigger makes no subscription row and no\n"));

    const issue = diff(functionText(SCRIPT, "admin_issue_assisted_claim_link"), functionText(UEN_LATER, "admin_issue_assisted_claim_link"));
    assert.deepEqual(issue.added, []);
    assert.deepEqual(issue.removed, [
      "  if v_shop.category <> 'home-cook' and v_shop.business_uen is null then",
      "    raise exception 'Add the business UEN before sending a claim link (only a Home Cook can be set up without one).' using errcode = '22023';",
    ]);

    const check = diff(functionText(LIVE_UEN_FUNCTIONS, "check_cook_application_uen"), functionText(UEN_LATER, "check_cook_application_uen"));
    assert.deepEqual(check.removed, ["    raise exception 'A Business Registration Number (UEN) is required for registered businesses.' using errcode = '23514';"]);
    assert.ok(check.added.includes("    if not (coalesce(current_setting('kb_assist.uen_pending', true), '') = 'on'"));
    assert.ok(check.added.includes("            and current_user not in ('anon', 'authenticated')"));
    assert.ok(check.added.includes("            and new.status = 'approved') then"));
  });
});

describe("UEN after claiming — live test and the existing files", () => {
  let fresh: PGlite;
  before(async () => {
    fresh = await uenStack();
    assert.equal((await runScript(fresh, UEN_LATER)).result, "UEN LATER INSTALLED");
  });

  const counts = async () =>
    (await fresh.query<Record<string, number>>(
      `select (select count(*)::int from auth.users) users, (select count(*)::int from public.kitchens) kitchens,
              (select count(*)::int from public.cook_applications) apps, (select count(*)::int from public.assisted_shops) shops,
              (select count(*)::int from public.kitchen_admin_audit) audit`
    )).rows[0];

  it("the live test passes (owner steps as a real owner session) and rolls everything back", async () => {
    const before = await counts();
    const { error } = await runScript(fresh, UEN_LIVE_TEST.replaceAll("PUT-ADMIN-ID", ADMIN));
    assert.match(error ?? "(no closing exception)", /^TEST OK, rolled back/);
    assert.deepEqual(await counts(), before);
  });

  it("the live test refuses without an admin id, and before the file is installed", async () => {
    assert.match((await runScript(fresh, UEN_LIVE_TEST)).error ?? "", /REFUSED: fill in PUT-ADMIN-ID first/);
    const notYet = await uenStack();
    assert.match((await runScript(notYet, UEN_LIVE_TEST.replaceAll("PUT-ADMIN-ID", ADMIN))).error ?? "", /REFUSED: run docs\/supabase-assisted-uen-later\.sql first/);
    await notYet.close();
  });

  it("the existing onboarding and menu import live tests still pass after it", async () => {
    for (const sql of [LIVE_TEST, MENU_LIVE_TEST]) {
      const { error } = await runScript(fresh, sql.replaceAll("PUT-ADMIN-ID", ADMIN));
      assert.match(error ?? "(no closing exception)", /^TEST OK, rolled back/);
    }
  });

  it("re-running the menu import file keeps the new claim (its own claim check compares before/after); the onboarding file still refuses to re-run", async () => {
    const all = [...UNTOUCHED, ...CHANGED, ...ADDED];
    const fp = await fingerprints(fresh, all);
    assert.equal((await runScript(fresh, MENU_IMPORT)).result, "MENU IMPORT INSTALLED");
    assert.match((await runScript(fresh, SCRIPT)).error ?? "", /supabase-assisted-menu-import\.sql is installed.*Nothing was changed/);
    assert.deepEqual(await fingerprints(fresh, all), fp);
    assert.equal(fp.assisted_claim_complete, UEN_PINS.after.assisted_claim_complete);
  });
});

// --- Sign-in link for a claimed shop (docs/supabase-assisted-signin-link.sql) ---

const SIGNIN = read("supabase-assisted-signin-link.sql");
const SIGNIN_LIVE_TEST = read("supabase-assisted-signin-link-live-test.sql");
const SIGNIN_NEW = ["admin_issue_assisted_signin_link", "assisted_signin_consume", "assisted_signin_rate_limited", "assisted_signin_audit_append_only"];
const SIGNIN_TABLES = ["assisted_signin_tokens", "assisted_signin_attempts", "assisted_signin_audit"];

/** md5 of every public function's text and grants, except the new ones. */
async function otherFunctions(d: PGlite): Promise<Record<string, string>> {
  const rows = (await d.query<{ sig: string; fp: string }>(
    `select p.oid::regprocedure::text as sig, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '')) as fp
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and not (p.proname = any($1::text[]))`,
    [SIGNIN_NEW]
  )).rows;
  return Object.fromEntries(rows.map((r) => [r.sig, r.fp]));
}

/** Columns, constraints, policies, triggers and table grants outside the two new tables. */
async function otherObjects(d: PGlite) {
  return (await d.query(
    `select 'col' k, table_schema || '.' || table_name || '.' || column_name || ':' || data_type v from information_schema.columns
       where table_schema in ('public', 'auth', 'storage') and not (table_name = any($1::text[]))
     union all select 'con', conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint
       where conrelid <> 0 and not (conrelid::regclass::text = any($1::text[]))
     union all select 'pol', schemaname || '.' || tablename || ':' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies
       where not (tablename = any($1::text[]))
     union all select 'trg', tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text from pg_trigger
       where not tgisinternal and not (tgrelid::regclass::text = any($1::text[]))
     union all select 'acl', c.oid::regclass::text || ':' || coalesce(c.relacl::text, '') from pg_class c
       where c.relnamespace in ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace) and c.relkind in ('r', 'v')
         and not (c.relname = any($1::text[]))
     order by 1, 2`,
    [SIGNIN_TABLES]
  )).rows;
}

describe("sign-in link — install", () => {
  for (const [label, stack] of [
    ["onboarding + menu import", () => freshStack(true)],
    [
      "with the UEN-later file installed too",
      async () => {
        const d = await uenStack();
        assert.equal((await runScript(d, UEN_LATER)).result, "UEN LATER INSTALLED");
        return d;
      },
    ],
  ] as const) {
    it(`installs (${label}), changes no existing function, table, constraint, policy, trigger or grant, and re-runs cleanly (CRLF too)`, async () => {
      const d = await stack();
      const fns = await otherFunctions(d);
      const objs = await otherObjects(d);
      assert.deepEqual(await runScript(d, SIGNIN), { result: "SIGNIN LINK INSTALLED", error: null });
      assert.deepEqual(await otherFunctions(d), fns);
      assert.deepEqual(await otherObjects(d), objs);
      assert.deepEqual(await runScript(d, SIGNIN.replace(/\n/g, "\r\n")), { result: "SIGNIN LINK INSTALLED", error: null });
      assert.deepEqual(await otherFunctions(d), fns);
      assert.deepEqual(await otherObjects(d), objs);
      await d.close();
    });
  }

  it("stops with nothing made when assisted onboarding isn't installed", async () => {
    const d = new PGlite();
    await d.exec(STUBS);
    const { error } = await runScript(d, SIGNIN);
    assert.match(error ?? "", /^Sign-in link: missing public\.assisted_shops.*Nothing was changed/);
    assert.equal((await d.query("select 1 from pg_class where relname like 'assisted_signin_%'")).rows.length, 0);
    assert.equal((await d.query("select 1 from pg_proc where proname = any($1::text[])", [SIGNIN_NEW])).rows.length, 0);
    await d.close();
  });

  it("the post-install check refuses to commit when an existing function changed in the same run", async () => {
    const d = await freshStack(true);
    const fns = await otherFunctions(d);
    // An extra statement slipped into the file that edits an existing function: the check must catch it.
    const tampered = SIGNIN.replace(
      "-- 3. CHECKS AFTER",
      "create or replace function public.assisted_onboarding_audit_append_only() returns trigger language plpgsql set search_path = '' as $x$ begin return null; end; $x$;\n-- 3. CHECKS AFTER"
    );
    assert.match((await runScript(d, tampered)).error ?? "", /^Stopped: an existing function changed/);
    assert.deepEqual(await otherFunctions(d), fns);
    assert.equal((await d.query("select 1 from pg_class where relname like 'assisted_signin_%'")).rows.length, 0);
    await d.close();
  });

  it("only adds: the only functions it creates are its own, it alters only its own tables, and the rollback is commented out and drops only its own objects", () => {
    const created = [...SIGNIN.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]).sort();
    assert.deepEqual(created, [...SIGNIN_NEW].sort());
    assert.deepEqual([...new Set([...SIGNIN.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1]))].sort(), [...SIGNIN_TABLES].sort());
    const rollback = SIGNIN.slice(SIGNIN.indexOf("-- 4. ROLLBACK"));
    const drops = [...rollback.matchAll(/drop (?:function|table) if exists public\.(\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(drops, [...SIGNIN_NEW, ...SIGNIN_TABLES].sort());
    assert.ok(rollback.split("\n").every((l) => l.trim() === "" || l.startsWith("--")), "the rollback is commented out");
  });

  it("the rollback, run on its own, removes exactly what the install made", async () => {
    const d = await freshStack(true);
    const fns = await otherFunctions(d);
    const objs = await otherObjects(d);
    assert.equal((await runScript(d, SIGNIN)).result, "SIGNIN LINK INSTALLED");
    const rollback = SIGNIN.slice(SIGNIN.indexOf("-- 4. ROLLBACK"))
      .split("\n")
      .filter((l) => l.startsWith("-- ") && /^-- (begin|drop|commit|select)/.test(l))
      .map((l) => l.slice(3))
      .join("\n");
    assert.equal((await runScript(d, rollback)).result, "SIGNIN LINK REMOVED");
    assert.deepEqual(await otherFunctions(d), fns);
    assert.deepEqual(await otherObjects(d), objs);
    assert.equal((await d.query("select 1 from pg_class where relname like 'assisted_signin_%'")).rows.length, 0);
    assert.equal((await d.query("select 1 from pg_proc where proname = any($1::text[])", [SIGNIN_NEW])).rows.length, 0);
    await d.close();
  });
});

describe("sign-in link — functions", () => {
  let d: PGlite;
  const OWNER = id(950);
  const OWNER_2 = id(952);
  let shop = "";
  let shop2 = "";

  type Caller = "admin" | "owner" | "anon" | "service";

  /** Runs fn in a committed transaction as that caller (an admin session is plain authenticated). */
  async function asIn<T>(who: Caller, fn: () => Promise<T>): Promise<T> {
    await d.exec("begin");
    try {
      const uid = who === "admin" ? ADMIN : who === "owner" ? OWNER : null;
      await d.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: who === "service" ? "service_role" : "anon" }),
      ]);
      await d.exec(`set local role ${uid ? "authenticated" : who === "service" ? "service_role" : "anon"}`);
      const r = await fn();
      await d.exec("commit");
      return r;
    } catch (e) {
      await d.exec("rollback");
      throw e;
    }
  }
  /** Issues a link the way Boss does: a fresh claim-style token, only its hash to the database. */
  const issue = async (shopId = shop) => {
    const token = newClaimToken();
    const hash = await hashClaimToken(token);
    const row = await asIn("admin", async () =>
      (await d.query<{ token_id: string; expires_at: string }>("select * from public.admin_issue_assisted_signin_link($1, $2)", [shopId, hash])).rows[0]
    );
    return { token, hash, ...row };
  };
  type Answer = { status: string; user_id?: string };
  const consume = (hash: unknown, client: string = freshClient()) =>
    asIn("service", async () => (await d.query<{ r: Answer }>("select public.assisted_signin_consume($1, $2) as r", [hash, client])).rows[0].r);
  const claimedShop = async (owner: string, mobile: string) => {
    await d.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{}')", [owner, `${owner}@assisted.invalid`]);
    // As the claim leaves it (written as postgres: the draft guard lets it through).
    return (await d.query<{ id: string }>(
      `insert into public.assisted_shops (business_name, category, cuisine_type, owner_name, owner_mobile, created_by, status, claimed_user_id, claimed_at)
       values ('TEST Claimed', 'home-cook', 'chinese', 'Tan', $3, $1, 'claimed', $2, now()) returning id`,
      [ADMIN, owner, mobile]
    )).rows[0].id;
  };
  const usedAt = async (tokenId: string) =>
    (await d.query<{ used_at: string | null }>("select used_at from public.assisted_signin_tokens where id = $1", [tokenId])).rows[0].used_at;

  before(async () => {
    d = await freshStack(true);
    assert.equal((await runScript(d, SIGNIN)).result, "SIGNIN LINK INSTALLED");
    shop = await claimedShop(OWNER, "91234567");
    shop2 = await claimedShop(OWNER_2, "91234568");
  });

  it("stores exactly the hash Boss sent, 2 hours; consume answers ok + the owner's id once, then used", async () => {
    const r = await issue();
    const hours = (new Date(r.expires_at).getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 1.98 && hours <= 2.001, `expires in ${hours} h`);
    const stored = (await d.query<{ token_hash: string; user_id: string }>("select token_hash, user_id from public.assisted_signin_tokens where id = $1", [r.token_id])).rows[0];
    assert.deepEqual(stored, { token_hash: r.hash, user_id: OWNER });
    assert.deepEqual(await consume(r.hash), { status: "ok", user_id: OWNER });
    assert.deepEqual(await consume(r.hash), { status: "used" });
  });

  it("(1) refuses anything but a 64-hex hash, the raw token included", async () => {
    for (const bad of [null, "", newClaimToken(), "A".repeat(64), "0".repeat(63)]) {
      await rejects(asIn("admin", () => d.query("select * from public.admin_issue_assisted_signin_link($1, $2)", [shop, bad])), /Invalid sign-in token/);
    }
  });

  it("a new link revokes the older one, which then answers revoked", async () => {
    const a = await issue();
    const b = await issue();
    assert.deepEqual(await consume(a.hash), { status: "revoked" });
    assert.deepEqual(await consume(b.hash), { status: "ok", user_id: OWNER });
    const old = (await d.query<{ revoked_at: string | null; used_at: string | null }>("select revoked_at, used_at from public.assisted_signin_tokens where id = $1", [a.token_id])).rows[0];
    assert.ok(old.revoked_at && !old.used_at);
  });

  it("expired, cancelled shop, shop not claimed by that account, deleted account: the right status and the link stays unused", async () => {
    const t = await issue();
    await d.query("update public.assisted_signin_tokens set created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' where id = $1", [t.token_id]);
    assert.deepEqual(await consume(t.hash), { status: "expired" });

    const c = await issue();
    await d.query("update public.assisted_shops set status = 'cancelled' where id = $1", [shop]);
    assert.deepEqual(await consume(c.hash), { status: "cancelled" });
    await d.query("update public.assisted_shops set status = 'claimed' where id = $1", [shop]);

    const u = await issue();
    await d.query("update public.assisted_signin_tokens set user_id = $1 where id = $2", [CUSTOMER, u.token_id]);
    assert.deepEqual(await consume(u.hash), { status: "invalid" });

    const v = await issue(shop2);
    await d.query("delete from auth.users where id = $1", [OWNER_2]);
    assert.deepEqual(await consume(v.hash), { status: "invalid" });
    await rejects(issue(shop2), /The owner's account no longer exists/);

    for (const x of [t, c, u, v]) assert.equal(await usedAt(x.token_id), null);
  });

  it("unknown, malformed, the raw token and NULL are invalid; a bad client key raises", async () => {
    const t = await issue();
    for (const bad of [null, "", "not hex", t.token, "0".repeat(64), "A".repeat(64)]) assert.deepEqual(await consume(bad), { status: "invalid" });
    for (const key of ["", "not-a-key", "A".repeat(64), null]) {
      await rejects(asIn("service", () => d.query("select public.assisted_signin_consume($1, $2)", [t.hash, key])), /assisted_signin: bad client key/);
    }
    assert.equal(await usedAt(t.token_id), null);
  });

  it("rate limit, per client key, like the claim: 10 failed in 15 minutes, or 60 in total; a limited call never uses the link", async () => {
    const good = await issue();
    const key = freshClient();
    for (let n = 0; n < 10; n++) assert.deepEqual(await consume("0".repeat(64), key), { status: "invalid" });
    assert.deepEqual(await consume(good.hash, key), { status: "rate_limited" });
    assert.equal(await usedAt(good.token_id), null);

    // Older than 15 minutes no longer counts.
    await d.query("update public.assisted_signin_attempts set at = now() - interval '16 minutes' where client_key = $1", [key]);
    const total = freshClient();
    await d.query("insert into public.assisted_signin_attempts (client_key, result) select $1, 'ok' from generate_series(1, 60)", [total]);
    assert.deepEqual(await consume(good.hash, total), { status: "rate_limited" });
    assert.equal(await usedAt(good.token_id), null);

    assert.deepEqual(await consume(good.hash, key), { status: "ok", user_id: OWNER });

    // Every call is logged with its result; rows older than a day are removed as calls come in.
    const results = (await d.query<{ result: string }>("select result from public.assisted_signin_attempts where client_key = $1 order by id", [key])).rows.map((r) => r.result);
    assert.deepEqual(results, [...Array(10).fill("invalid"), "rate_limited", "ok"]);
    await d.query("update public.assisted_signin_attempts set at = now() - interval '25 hours' where client_key = $1", [key]);
    await consume("0".repeat(64));
    assert.equal((await d.query("select 1 from public.assisted_signin_attempts where client_key = $1", [key])).rows.length, 0);
  });

  it("(1) refuses a draft or cancelled shop, an unknown shop, the owner, anon and service_role", async () => {
    for (const status of ["draft", "cancelled"]) {
      await d.query("update public.assisted_shops set status = $1 where id = $2", [status, shop]);
      await rejects(issue(), /A sign-in link is only for a shop the owner has already claimed/);
    }
    await d.query("update public.assisted_shops set status = 'claimed' where id = $1", [shop]);
    await rejects(issue(id(999)), /Shop not found/);
    const call = "select * from public.admin_issue_assisted_signin_link($1, $2)";
    await rejects(asIn("owner", () => d.query(call, [shop, "1".repeat(64)])), /Not allowed: admins only/);
    await rejects(asIn("anon", () => d.query(call, [shop, "1".repeat(64)])), /permission denied/);
    await rejects(asIn("service", () => d.query(call, [shop, "1".repeat(64)])), /permission denied/);
  });

  it("(2) and the rate-limit helper are not callable by anon or authenticated (the owner, or an admin session)", async () => {
    for (const who of ["anon", "owner", "admin"] as const) {
      await rejects(asIn(who, () => d.query("select public.assisted_signin_consume($1, $2)", ["0".repeat(64), "0".repeat(64)])), /permission denied/);
      await rejects(asIn(who, () => d.query("select public.assisted_signin_rate_limited($1)", ["0".repeat(64)])), /permission denied/);
    }
    await rejects(asIn("service", () => d.query("select public.assisted_signin_rate_limited($1)", ["0".repeat(64)])), /permission denied/);
  });

  it("nobody reads tokens or attempts; only HQ reads the audit; the audit never holds a token or hash and is append-only", async () => {
    for (const who of ["anon", "owner", "admin", "service"] as const) {
      await rejects(asIn(who, () => d.query("select * from public.assisted_signin_tokens")), /permission denied/);
      await rejects(asIn(who, () => d.query("select * from public.assisted_signin_attempts")), /permission denied/);
    }
    const rows = await asIn("admin", async () => (await d.query<{ action: string; details: unknown }>("select action, details from public.assisted_signin_audit")).rows);
    for (const action of ["signin_link_issued", "signin_link_revoked", "signin_link_used"]) assert.ok(rows.some((r) => r.action === action), action);
    assert.ok(rows.every((r) => !/[0-9a-f]{64}|[A-Za-z0-9_-]{43}/.test(JSON.stringify(r.details))));
    assert.equal((await asIn("owner", async () => (await d.query("select * from public.assisted_signin_audit")).rows)).length, 0);
    await rejects(asIn("service", () => d.query("select * from public.assisted_signin_audit")), /permission denied/);
    await rejects(d.query("delete from public.assisted_signin_audit"), /append-only/);
    await rejects(d.query("update public.assisted_signin_audit set details = '{}'"), /append-only/);
  });

  it("the install leaves no attempt row behind (its own check is undone)", async () => {
    const fresh = await freshStack(true);
    assert.equal((await runScript(fresh, SIGNIN)).result, "SIGNIN LINK INSTALLED");
    assert.equal((await fresh.query("select 1 from public.assisted_signin_attempts")).rows.length, 0);
    await fresh.close();
  });

  it("the live test passes and rolls back (CRLF too); it refuses without an admin id and before install", async () => {
    const live = await freshStack(true);
    assert.match((await runScript(live, SIGNIN_LIVE_TEST.replaceAll("PUT-ADMIN-ID", ADMIN))).error ?? "", /REFUSED: run docs\/supabase-assisted-signin-link\.sql \(rev 2\) first/);
    assert.equal((await runScript(live, SIGNIN)).result, "SIGNIN LINK INSTALLED");
    assert.match((await runScript(live, SIGNIN_LIVE_TEST)).error ?? "", /REFUSED: fill in PUT-ADMIN-ID first/);
    const count = async () =>
      (await live.query<Record<string, number>>(
        `select (select count(*)::int from auth.users) users, (select count(*)::int from public.assisted_shops) shops,
                (select count(*)::int from public.kitchens) kitchens, (select count(*)::int from public.assisted_signin_tokens) tokens,
                (select count(*)::int from public.assisted_signin_attempts) attempts,
                (select count(*)::int from public.assisted_signin_audit) audit, (select count(*)::int from public.assisted_onboarding_audit) onboarding_audit`
      )).rows[0];
    const before = await count();
    const { error } = await runScript(live, SIGNIN_LIVE_TEST.replaceAll("PUT-ADMIN-ID", ADMIN));
    assert.match(error ?? "(no closing exception)", /^TEST OK, rolled back/);
    assert.deepEqual(await count(), before);
    assert.match((await runScript(live, SIGNIN_LIVE_TEST.replaceAll("PUT-ADMIN-ID", ADMIN).replace(/\n/g, "\r\n"))).error ?? "", /^TEST OK, rolled back/);
    assert.deepEqual(await count(), before);
    await live.close();
  });

  it("the live test also passes with the UEN-later file installed", async () => {
    const live = await uenStack();
    assert.equal((await runScript(live, UEN_LATER)).result, "UEN LATER INSTALLED");
    assert.equal((await runScript(live, SIGNIN)).result, "SIGNIN LINK INSTALLED");
    assert.match((await runScript(live, SIGNIN_LIVE_TEST.replaceAll("PUT-ADMIN-ID", ADMIN))).error ?? "", /^TEST OK, rolled back/);
    await live.close();
  });
});
