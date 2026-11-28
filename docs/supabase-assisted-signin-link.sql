-- ============================================================================
-- KOPI BOY: ASSISTED ONBOARDING, HQ SIGN-IN LINK FOR A CLAIMED SHOP.
-- Rev 2, NOT INSTALLED. Review first.
-- Run ONCE in the Supabase SQL editor, as ONE script, after
-- docs/supabase-assisted-onboarding.sql (and the files installed after it).
-- Success ends with: SIGNIN LINK INSTALLED. Then run
-- docs/supabase-assisted-signin-link-live-test.sql (it always rolls back).
-- PGlite test: src/lib/assisted-onboarding-sql.test.ts ("sign-in link").
--
-- WHY
-- An assisted owner has a made-up email (@assisted.invalid) and no password
-- or Google login. If their session is lost they can't get back in, and
-- admin_issue_assisted_claim_link refuses every shop that isn't a draft.
-- This lets HQ send that owner a one-time link back into their EXISTING
-- account. Nothing here creates, deletes or moves a user, a kitchen or any
-- data. It only issues and uses sign-in tokens.
--
-- FLOW (same token rules as the claim link)
--   1. HQ (Boss) makes the raw token (32 random bytes, base64url, 43
--      characters) and sends ONLY its hash to
--      admin_issue_assisted_signin_link(shop_id, token_hash):
--        token_hash = lowercase hex SHA-256 of the raw token's UTF-8 bytes.
--      The raw token never reaches the database. Only for a CLAIMED shop.
--      2 hours, single use. Any older unused sign-in link of the shop is
--      revoked. Audited.
--   2. HQ sends https://partners.kopi-boy.com/resume#<token> on WhatsApp.
--   3. The Partner server (service_role) hashes the token and calls
--      assisted_signin_consume(token_hash, client_key). It is rate limited
--      in here, with the claim's limits, in its own attempts table. It locks
--      the token, works out its state, and if it is 'ok' marks it used, all
--      in one call. It returns jsonb:
--        {"status": "ok", "user_id": "<the shop's claimed_user_id>"}
--        {"status": "invalid" | "expired" | "used" | "revoked" | "cancelled" | "rate_limited"}
--      The Partner server then signs that existing user in. That part is in
--      the Partner app, not here.
--
-- WHO CAN DO WHAT
--   * HQ (authenticated + user_has_role('admin')): admin_issue_assisted_signin_link;
--     read the sign-in audit.
--   * service_role (Partner server only): assisted_signin_consume.
--   * anon and every other signed-in user: nothing.
--   Nobody reads assisted_signin_tokens or assisted_signin_attempts directly,
--   service_role included.
--
-- WHAT IT DOES NOT TOUCH
--   No existing table, column, constraint, policy, trigger, grant or function
--   is altered or replaced. New: three tables, four functions, two triggers
--   (on the new audit table only). Section 0 takes an md5 of every existing
--   function in public; section 3 compares it and refuses to commit if one
--   differs. assisted_claim_tokens, assisted_claim_attempts and
--   assisted_onboarding_audit are not written: separate tables keep the
--   claim's "one open link" index, its attempts CHECK and the onboarding
--   audit's action CHECK as they are (docs/supabase-assisted-menu-import.sql
--   owns that one, and a re-run of that file would drop any action added here).
--
-- SAFE TO RE-RUN: the tables are "if not exists" (tokens, attempts and audit
-- rows are kept), and the four new functions are replaced with this file's
-- text. Nothing else changes.
--
-- ROLLBACK: section 4, at the end of this file (commented out).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. CHECKS BEFORE ANYTHING CHANGES
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := array[]::text[];
  v_name text;
begin
  foreach v_name in array array['public.assisted_shops', 'public.profiles', 'auth.users'] loop
    if pg_catalog.to_regclass(v_name) is null then
      v_missing := pg_catalog.array_append(v_missing, v_name);
    end if;
  end loop;
  foreach v_name in array array['auth.uid()', 'public.user_has_role(text)'] loop
    if pg_catalog.to_regprocedure(v_name) is null then
      v_missing := pg_catalog.array_append(v_missing, v_name);
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'assisted_shops' and column_name = 'claimed_user_id') then
    v_missing := pg_catalog.array_append(v_missing, 'assisted_shops.claimed_user_id');
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    v_missing := pg_catalog.array_append(v_missing, 'role service_role');
  end if;
  if pg_catalog.cardinality(v_missing) > 0 then
    raise exception 'Sign-in link: missing %. Nothing was changed.', pg_catalog.array_to_string(v_missing, ', ');
  end if;

  -- Every existing function in public, except the ones this file makes.
  -- Section 3 compares: no existing function may change.
  perform pg_catalog.set_config('kb_signin.functions_md5', (
    select coalesce(pg_catalog.md5(pg_catalog.string_agg(
             p.oid::text || ':' || pg_catalog.md5(pg_catalog.replace(pg_catalog.pg_get_functiondef(p.oid), E'\r', ''))
               || ':' || coalesce(p.proacl::text, ''),
             ',' order by p.oid)), '')
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
      and p.proname not in ('admin_issue_assisted_signin_link', 'assisted_signin_consume',
                            'assisted_signin_rate_limited', 'assisted_signin_audit_append_only')
  ), true);
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

-- Sign-in tokens: hash only. user_id = assisted_shops.claimed_user_id when the
-- link was issued; the consume checks it is still the shop's owner.
-- No foreign key to auth.users/profiles (as assisted_shops): a deleted test
-- merchant never blocks, and a link for a deleted account simply fails.
create table if not exists public.assisted_signin_tokens (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.assisted_shops(id) on delete cascade,
  user_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  check (expires_at > created_at),
  check (not (used_at is not null and revoked_at is not null))
);

-- At most one unused, unrevoked sign-in link per shop (an expired one counts
-- until a new link revokes it).
create unique index if not exists assisted_signin_tokens_one_open_idx
  on public.assisted_signin_tokens (shop_id) where used_at is null and revoked_at is null;

alter table public.assisted_signin_tokens enable row level security;
revoke all on public.assisted_signin_tokens from public, anon, authenticated, service_role;

-- Sign-in attempts, for the rate limit only. client_key is a hash the
-- Partner server makes (e.g. of the caller's IP), never the IP itself.
create table if not exists public.assisted_signin_attempts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  client_key text not null check (client_key ~ '^[0-9a-f]{64}$'),
  result text not null check (result in ('ok', 'invalid', 'expired', 'used', 'revoked', 'cancelled', 'rate_limited'))
);

create index if not exists assisted_signin_attempts_key_idx
  on public.assisted_signin_attempts (client_key, at desc);
create index if not exists assisted_signin_attempts_at_idx
  on public.assisted_signin_attempts (at);

alter table public.assisted_signin_attempts enable row level security;
revoke all on public.assisted_signin_attempts from public, anon, authenticated, service_role;

-- Audit, append-only (same style as assisted_onboarding_audit). Never a token or a hash.
create table if not exists public.assisted_signin_audit (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_id uuid,             -- the admin; for 'signin_link_used', the owner
  actor_kind text not null check (actor_kind in ('admin', 'owner')),
  shop_id uuid not null,
  shop_name text,
  user_id uuid not null,     -- the owner's account the link signs in to
  token_id uuid not null,
  action text not null check (action in ('signin_link_issued', 'signin_link_revoked', 'signin_link_used')),
  details jsonb not null default '{}'::jsonb
);

create index if not exists assisted_signin_audit_shop_idx
  on public.assisted_signin_audit (shop_id, created_at desc);

alter table public.assisted_signin_audit enable row level security;
revoke all on public.assisted_signin_audit from public, anon, authenticated, service_role;
grant select (id, created_at, actor_id, actor_kind, shop_id, shop_name, user_id, token_id, action, details)
  on public.assisted_signin_audit to authenticated;

drop policy if exists "Admins read the assisted sign-in audit" on public.assisted_signin_audit;
create policy "Admins read the assisted sign-in audit"
  on public.assisted_signin_audit for select to authenticated
  using (public.user_has_role('admin'));

create or replace function public.assisted_signin_audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'assisted_signin_audit is append-only: % is not allowed', tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists assisted_signin_audit_append_only on public.assisted_signin_audit;
create trigger assisted_signin_audit_append_only
  before update or delete on public.assisted_signin_audit
  for each row execute function public.assisted_signin_audit_append_only();

drop trigger if exists assisted_signin_audit_no_truncate on public.assisted_signin_audit;
create trigger assisted_signin_audit_no_truncate
  before truncate on public.assisted_signin_audit
  for each statement execute function public.assisted_signin_audit_append_only();

revoke all on function public.assisted_signin_audit_append_only() from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 2. FUNCTIONS
-- ----------------------------------------------------------------------------

-- (1) HQ: a sign-in link for a CLAIMED shop. Admins only. Boss keeps the raw
-- token and sends only its hash. Returns the new link's id and expiry.
create or replace function public.admin_issue_assisted_signin_link(p_shop_id uuid, p_token_hash text)
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
  v_expires timestamptz := pg_catalog.now() + pg_catalog.make_interval(hours => 2);
begin
  if auth.uid() is null or not public.user_has_role('admin') then
    raise exception 'Not allowed: admins only.' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid sign-in token.' using errcode = '22023';
  end if;

  select * into v_shop from public.assisted_shops s where s.id = p_shop_id for update;
  if not found then
    raise exception 'Shop not found.' using errcode = 'P0002';
  end if;
  if v_shop.status <> 'claimed' or v_shop.claimed_user_id is null then
    raise exception 'A sign-in link is only for a shop the owner has already claimed.' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_shop.claimed_user_id) then
    raise exception 'The owner''s account no longer exists, so there is nothing to sign in to.' using errcode = 'P0002';
  end if;

  for v_old in
    update public.assisted_signin_tokens t
    set revoked_at = pg_catalog.now(), revoked_by = auth.uid(), revoke_reason = 'replaced by a new link'
    where t.shop_id = p_shop_id and t.used_at is null and t.revoked_at is null
    returning t.id, t.user_id
  loop
    insert into public.assisted_signin_audit (actor_id, actor_kind, shop_id, shop_name, user_id, token_id, action, details)
    values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, v_old.user_id, v_old.id, 'signin_link_revoked',
            pg_catalog.jsonb_build_object('reason', 'replaced by a new link'));
  end loop;

  insert into public.assisted_signin_tokens (shop_id, user_id, token_hash, created_by, expires_at)
  values (p_shop_id, v_shop.claimed_user_id, p_token_hash, auth.uid(), v_expires)
  returning id into v_id;

  insert into public.assisted_signin_audit (actor_id, actor_kind, shop_id, shop_name, user_id, token_id, action, details)
  values (auth.uid(), 'admin', p_shop_id, v_shop.business_name, v_shop.claimed_user_id, v_id, 'signin_link_issued',
          pg_catalog.jsonb_build_object('expires_at', v_expires));

  return query select v_id, v_expires;
end;
$$;

-- Same limits as assisted_claim_rate_limited, over this table: in the last
-- 15 minutes, 10 failed attempts or 60 in total.
create or replace function public.assisted_signin_rate_limited(p_client_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) filter (where a.result <> 'ok') >= 10 or count(*) >= 60
  from public.assisted_signin_attempts a
  where a.client_key = p_client_key
    and a.at > pg_catalog.now() - pg_catalog.make_interval(mins => 15);
$$;

-- (2) Partner server (service_role only). Returns jsonb (see FLOW). It
-- returns (not raises) for a bad token, so the attempt row is kept. A bad
-- client key is a Partner server bug: that raises.
-- Lock the token: two taps at once, the second waits and then sees 'used'.
create or replace function public.assisted_signin_consume(p_token_hash text, p_client_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token public.assisted_signin_tokens;
  v_shop public.assisted_shops;
  v_state text;
begin
  if p_client_key is null or p_client_key !~ '^[0-9a-f]{64}$' then
    raise exception 'assisted_signin: bad client key' using errcode = '22023';
  end if;
  delete from public.assisted_signin_attempts a where a.at < pg_catalog.now() - pg_catalog.make_interval(days => 1);
  if public.assisted_signin_rate_limited(p_client_key) then
    insert into public.assisted_signin_attempts (client_key, result) values (p_client_key, 'rate_limited');
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  if p_token_hash ~ '^[0-9a-f]{64}$' then
    select * into v_token from public.assisted_signin_tokens t where t.token_hash = p_token_hash for update;
    if v_token.id is not null then
      select * into v_shop from public.assisted_shops s where s.id = v_token.shop_id;
    end if;
  end if;

  v_state := case
    when v_token.id is null then 'invalid'
    when v_token.used_at is not null then 'used'
    when v_shop.status = 'cancelled' then 'cancelled'
    when v_token.revoked_at is not null then 'revoked'
    when v_token.expires_at <= pg_catalog.now() then 'expired'
    -- The shop must still be claimed by the account the link was made for,
    -- and that account must still exist. Anything else: 'invalid'.
    when v_shop.status is distinct from 'claimed'
      or v_shop.claimed_user_id is distinct from v_token.user_id
      or not exists (select 1 from auth.users u where u.id = v_token.user_id) then 'invalid'
    else 'ok'
  end;

  insert into public.assisted_signin_attempts (client_key, result) values (p_client_key, v_state);
  if v_state <> 'ok' then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;

  update public.assisted_signin_tokens t set used_at = pg_catalog.now() where t.id = v_token.id;

  insert into public.assisted_signin_audit (actor_id, actor_kind, shop_id, shop_name, user_id, token_id, action)
  values (v_token.user_id, 'owner', v_shop.id, v_shop.business_name, v_token.user_id, v_token.id, 'signin_link_used');

  return pg_catalog.jsonb_build_object('status', 'ok', 'user_id', v_token.user_id);
end;
$$;

revoke all on function public.admin_issue_assisted_signin_link(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.assisted_signin_rate_limited(text) from public, anon, authenticated, service_role;
revoke all on function public.assisted_signin_consume(text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_issue_assisted_signin_link(uuid, text) to authenticated;
grant execute on function public.assisted_signin_consume(text, text) to service_role;


-- ----------------------------------------------------------------------------
-- 3. CHECKS AFTER. Otherwise roll back.
-- ----------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_msg text;
  v_result jsonb;
begin
  -- No existing function changed (text or grants).
  if (select coalesce(pg_catalog.md5(pg_catalog.string_agg(
             p.oid::text || ':' || pg_catalog.md5(pg_catalog.replace(pg_catalog.pg_get_functiondef(p.oid), E'\r', ''))
               || ':' || coalesce(p.proacl::text, ''),
             ',' order by p.oid)), '')
      from pg_catalog.pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
        and p.proname not in ('admin_issue_assisted_signin_link', 'assisted_signin_consume',
                              'assisted_signin_rate_limited', 'assisted_signin_audit_append_only'))
     <> pg_catalog.current_setting('kb_signin.functions_md5') then
    raise exception 'Stopped: an existing function changed. Nothing was changed.';
  end if;

  -- One version of each new function, with a fixed, empty search_path.
  select pg_catalog.string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('admin_issue_assisted_signin_link', 'assisted_signin_consume',
                      'assisted_signin_rate_limited', 'assisted_signin_audit_append_only')
    and (not coalesce('search_path=""' = any (p.proconfig), false)
         or p.oid not in ('public.admin_issue_assisted_signin_link(uuid, text)'::regprocedure,
                          'public.assisted_signin_consume(text, text)'::regprocedure,
                          'public.assisted_signin_rate_limited(text)'::regprocedure,
                          'public.assisted_signin_audit_append_only()'::regprocedure));
  if v_bad is not null then
    raise exception 'Stopped: unexpected function(s) or search_path: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
             where p.oid in ('public.admin_issue_assisted_signin_link(uuid, text)'::regprocedure,
                             'public.assisted_signin_consume(text, text)'::regprocedure,
                             'public.assisted_signin_rate_limited(text)'::regprocedure)
               and not p.prosecdef) then
    raise exception 'Stopped: a sign-in function is not SECURITY DEFINER';
  end if;

  -- Who can run what.
  if not has_function_privilege('authenticated', 'public.admin_issue_assisted_signin_link(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.admin_issue_assisted_signin_link(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.admin_issue_assisted_signin_link(uuid, text)', 'execute')
     or not has_function_privilege('service_role', 'public.assisted_signin_consume(text, text)', 'execute')
     or has_function_privilege('anon', 'public.assisted_signin_consume(text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.assisted_signin_consume(text, text)', 'execute')
     or has_function_privilege('anon', 'public.assisted_signin_rate_limited(text)', 'execute')
     or has_function_privilege('authenticated', 'public.assisted_signin_rate_limited(text)', 'execute')
     or has_function_privilege('service_role', 'public.assisted_signin_rate_limited(text)', 'execute')
     or has_function_privilege('anon', 'public.assisted_signin_audit_append_only()', 'execute')
     or has_function_privilege('authenticated', 'public.assisted_signin_audit_append_only()', 'execute') then
    raise exception 'Stopped: function privileges are wrong';
  end if;

  -- Nobody reads or writes tokens or attempts through the API; the audit is read-only for HQ.
  if has_table_privilege('anon', 'public.assisted_signin_tokens', 'select, insert, update, delete')
     or has_table_privilege('authenticated', 'public.assisted_signin_tokens', 'select, insert, update, delete')
     or has_table_privilege('service_role', 'public.assisted_signin_tokens', 'select, insert, update, delete')
     or has_column_privilege('authenticated', 'public.assisted_signin_tokens', 'token_hash', 'select')
     or has_table_privilege('anon', 'public.assisted_signin_attempts', 'select, insert, update, delete')
     or has_table_privilege('authenticated', 'public.assisted_signin_attempts', 'select, insert, update, delete')
     or has_table_privilege('service_role', 'public.assisted_signin_attempts', 'select, insert, update, delete')
     or has_table_privilege('anon', 'public.assisted_signin_audit', 'select')
     or has_table_privilege('authenticated', 'public.assisted_signin_audit', 'insert, update, delete')
     or has_table_privilege('service_role', 'public.assisted_signin_audit', 'select, insert, update, delete') then
    raise exception 'Stopped: table privileges are wrong';
  end if;

  -- With no signed-in admin, (1) refuses (inner block: its own rollback point).
  begin
    perform public.admin_issue_assisted_signin_link(gen_random_uuid(), pg_catalog.repeat('0', 64));
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'Not allowed%' then
    raise exception 'Stopped: admin_issue_assisted_signin_link did not refuse a non-admin (%)', coalesce(v_msg, 'no error');
  end if;

  -- A token nobody issued is 'invalid'. Inside a block that is then undone,
  -- so the install leaves no attempt row behind.
  v_msg := null;
  begin
    v_result := public.assisted_signin_consume(pg_catalog.repeat('0', 64), pg_catalog.repeat('f', 64));
    raise exception 'kb_signin_undo';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg <> 'kb_signin_undo' or v_result is distinct from '{"status": "invalid"}'::jsonb then
    raise exception 'Stopped: assisted_signin_consume did not answer invalid for an unknown token (%, %)', v_result, v_msg;
  end if;
end;
$$;

commit;

select 'SIGNIN LINK INSTALLED' as result;


-- ----------------------------------------------------------------------------
-- 4. ROLLBACK (do NOT run with the install; copy into its own script).
-- Removes only what this file made. Drops the sign-in tokens (every link
-- stops working, which is the point), the attempts and the sign-in audit:
-- export public.assisted_signin_audit first if you need to keep that
-- history. No user, kitchen, shop or claim data is touched.
-- ----------------------------------------------------------------------------
-- begin;
-- drop function if exists public.assisted_signin_consume(text, text);
-- drop function if exists public.assisted_signin_rate_limited(text);
-- drop function if exists public.admin_issue_assisted_signin_link(uuid, text);
-- drop table if exists public.assisted_signin_tokens;
-- drop table if exists public.assisted_signin_attempts;
-- drop table if exists public.assisted_signin_audit;   -- its triggers and policy go with it
-- drop function if exists public.assisted_signin_audit_append_only();
-- commit;
-- select 'SIGNIN LINK REMOVED' as result;
