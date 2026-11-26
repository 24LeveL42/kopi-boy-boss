-- ============================================================================
-- TEST FIXTURE (node --test only; never run on live).
-- The live definitions of the functions docs/supabase-assisted-uen-later.sql
-- fingerprints, copied verbatim from where live got them:
--   kopi-boy-partner docs/supabase-schema.sql sections 26, 27 and 33, and
--   docs/supabase-privacy-consent.sql; this repo's
--   docs/supabase-assisted-onboarding.sql as of commit 45e839b (the claim;
--   later commits only reworded a comment in the repo, live kept this text).
-- Their line-ending-insensitive md5s equal the pins in that file, which is
-- what the tests check first. Loaded over the simpler stand-ins in
-- assisted-onboarding-sql.test.ts, after the onboarding and menu files.
-- kitchens_live_since_stamp is a stand-in (live has one by that name; only
-- its name matters here, for the trigger order).
-- ============================================================================

create or replace function public.guard_cook_application()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_from_app boolean := current_user in ('anon', 'authenticated') and not public.user_has_role('admin');
begin
  if tg_op = 'UPDATE' then
    new.privacy_policy_version := old.privacy_policy_version;
    new.privacy_acknowledged_at := old.privacy_acknowledged_at;
    return new;
  end if;

  if v_from_app then
    new.status := 'pending';
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;

  new.privacy_policy_version := nullif(btrim(coalesce(new.privacy_policy_version, '')), '');
  if new.privacy_policy_version is not null and new.privacy_policy_version !~ '^[0-9A-Za-z._-]{1,32}$' then
    raise exception 'Please tick the Privacy Policy acknowledgement before submitting.' using errcode = '23514';
  end if;
  if new.privacy_policy_version is null and v_from_app then
    raise exception 'Please tick the Privacy Policy acknowledgement before submitting.' using errcode = '23514';
  end if;
  new.privacy_acknowledged_at := case when new.privacy_policy_version is not null then now() end;

  return new;
end;
$$;

drop trigger if exists before_cook_application_guard on public.cook_applications;
create trigger before_cook_application_guard
  before insert or update on public.cook_applications
  for each row execute function public.guard_cook_application();

create or replace function public.check_cook_application_uen()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.business_uen := nullif(upper(btrim(coalesce(new.business_uen, ''))), '');

  if new.business_type is not distinct from 'Home Cook' then
    new.business_uen := null;
  elsif new.business_uen is null then
    raise exception 'A Business Registration Number (UEN) is required for registered businesses.' using errcode = '23514';
  elsif new.business_uen !~ '^([0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])$' then
    raise exception 'That doesn''t look like a valid UEN (e.g. 53123456X or 201912345K).' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists before_cook_application_insert on public.cook_applications;
create trigger before_cook_application_insert
  before insert on public.cook_applications
  for each row execute function public.check_cook_application_uen();

create or replace function public.approved_business_uen(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select ca.business_uen
  from public.cook_applications ca
  where ca.user_id = p_user_id and ca.status = 'approved'
  order by ca.reviewed_at desc nulls last, ca.created_at desc
  limit 1;
$$;

revoke all on function public.approved_business_uen(uuid) from public, anon, authenticated;

create or replace function public.set_kitchen_business_uen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.business_uen := public.approved_business_uen(new.id);
  return new;
end;
$$;

drop trigger if exists before_kitchen_business_uen on public.kitchens;
create trigger before_kitchen_business_uen
  before insert or update on public.kitchens
  for each row execute function public.set_kitchen_business_uen();

create or replace function public.sync_kitchen_business_uen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The kitchens trigger above recomputes the value; this just makes it run.
  update public.kitchens set business_uen = null where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists after_cook_application_review on public.cook_applications;
create trigger after_cook_application_review
  after update of status on public.cook_applications
  for each row
  when (old.status is distinct from new.status)
  execute function public.sync_kitchen_business_uen();

create or replace function public.stamp_kitchen_terms_acknowledgement()
returns trigger
language plpgsql
set search_path = public
as $$
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

drop trigger if exists before_kitchen_terms_acknowledgement on public.kitchens;
create trigger before_kitchen_terms_acknowledgement
  before insert or update on public.kitchens
  for each row execute function public.stamp_kitchen_terms_acknowledgement();

create or replace function public.stamp_kitchen_live_since() returns trigger language plpgsql as $stub$
begin
  if new.is_live and new.live_since is null then new.live_since := now(); end if;
  return new;
end;
$stub$;
drop trigger if exists kitchens_live_since_stamp on public.kitchens;
create trigger kitchens_live_since_stamp
  before insert or update on public.kitchens
  for each row execute function public.stamp_kitchen_live_since();

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
  --    to 'cook' and create the subscription row and founding number (fail
  --    closed: an error there undoes the whole claim). created_at = when HQ
  --    set the shop up, which is what founding eligibility reads.
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
