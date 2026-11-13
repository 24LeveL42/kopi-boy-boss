-- KOPI BOY Boss: admin-only email lookup (used by src/lib/contacts.ts and delete-partner.ts).
-- Needs public.user_has_role(text) from the Partner schema. Safe to re-run.
-- Returns id + email for the given user ids ONLY when the caller is HQ (admin);
-- everyone else gets zero rows. The admin check is inside the function because
-- security definer bypasses RLS.
-- UNDO: drop function if exists public.admin_user_emails(uuid[]);

create or replace function public.admin_user_emails(user_ids uuid[])
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email::text
  from auth.users u
  where u.id = any(user_ids)
    and public.user_has_role('admin');
$$;

revoke all on function public.admin_user_emails(uuid[]) from public, anon;
grant execute on function public.admin_user_emails(uuid[]) to authenticated;

-- VERIFY (read-only): expect 1 row: definer=true, config={search_path=""},
-- anon_can=false, authenticated_can=true.
select p.oid::regprocedure as fn, p.prosecdef as definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon_can,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can
from pg_catalog.pg_proc p
where p.oid = to_regprocedure('public.admin_user_emails(uuid[])');
