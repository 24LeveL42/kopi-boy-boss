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
 * on stand-ins for the live objects the claim touches: auth.users and
 * handle_new_user, profiles and protect_profile_privileges, the cook
 * application guard / UEN check / promote / subscription triggers, the
 * partner terms stamp and the column grants on kitchens.
 *
 * Also checks that what Boss sends matches the database: the column lists
 * in assisted-onboarding.ts are granted, and hashClaimToken() gives the hash
 * the Partner lookup finds.
 */

const read = (p: string) => readFileSync(new URL(`../../docs/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const KITCHEN_ADMIN = read("supabase-kitchen-admin-edit.sql");
const SCRIPT = read("supabase-assisted-onboarding.sql");
const LIVE_TEST = read("supabase-assisted-onboarding-live-test.sql");

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
create table public.merchant_subscriptions (merchant_id uuid primary key references public.profiles(id) on delete restrict, applied_at timestamptz);
create function public.billing_on_cook_application_approved() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select role from public.profiles where id = new.user_id) is distinct from 'cook' then raise exception 'billing_setup_failed: not promoted first'; end if;
  insert into public.merchant_subscriptions (merchant_id, applied_at) values (new.user_id, (select min(created_at) from public.cook_applications where user_id = new.user_id)) on conflict do nothing;
  return null;
end; $$;
create trigger after_cook_application_subscription_insert after insert on public.cook_applications
  for each row when (new.status = 'approved') execute function public.billing_on_cook_application_approved();

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
  await db.exec(KITCHEN_ADMIN);
  before_fp = await fingerprint();
  await db.exec(SCRIPT);
  await db.exec(SCRIPT); // re-runnable
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
  it("can't be issued until the draft is ready; Boss's readiness list agrees with the database", async () => {
    const shopId = await createDraft({ owner_mobile: "82222221", business_uen: null, business_address: null });
    const shop = await one<{ status: "draft"; category: string; business_uen: null; business_address: null; postal_code: string }>(
      "select status, category, business_uen, business_address, postal_code from public.assisted_shops where id = $1",
      [shopId]
    );
    assert.equal(claimReadiness(shop as never, []).length, 3);
    await rejects(issue(shopId), /pickup address and postal code/);
    await as("admin", () => q("update public.assisted_shops set business_address = 'Blk 2' where id = $1", [shopId]));
    await rejects(issue(shopId), /business UEN/);
    await as("admin", () => q("update public.assisted_shops set business_uen = '53123456A' where id = $1", [shopId]));
    await rejects(issue(shopId), /at least one menu item/);
    const hiddenId = await addItem(shopId);
    await as("admin", () => q("update public.assisted_shop_items set is_hidden = true where id = $1", [hiddenId]));
    await rejects(issue(shopId), /at least one menu item/);
    await addItem(shopId, "Visible");
    await issue(shopId);
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
  it("creates a cook with a kitchen that isn't live, keeps the founding date, and works once", async () => {
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
    const sub = await one<{ applied_at: Date }>("select applied_at from public.merchant_subscriptions where merchant_id = $1", [owner]);
    assert.equal(new Date(sub.applied_at).toISOString(), "2026-11-01T02:00:00.000Z", "founding is judged on when HQ set the shop up");

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
});
