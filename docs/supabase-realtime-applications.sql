-- ============================================================================
-- KOPI BOY — Boss: live updates for new merchant and rider applications
--
-- Adds public.cook_applications and public.rider_applications to the
-- supabase_realtime publication, each only if it isn't there already, so the
-- Boss app hears about new sign-ups straight away (pop-up, chime, tab count,
-- sidebar badges). Nothing else changes: no RLS, grants, triggers, columns or
-- other tables. Realtime still applies RLS, so admins hear about every row and
-- an applicant only ever about their own (which they can already read).
--
-- Safe to re-run. If the publication doesn't exist it does nothing.
-- Until this is run, Boss keeps working: it falls back to its 60-second refresh.
-- ============================================================================

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not found; nothing changed';
    return;
  end if;
  foreach t in array array['cook_applications', 'rider_applications']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- CHECK AFTERWARDS (read-only; expect both table names)
-- select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('cook_applications', 'rider_applications') order by tablename;

-- UNDO (removes only these two tables from the publication; uncomment to run)
-- UNDO-BEGIN
-- do $$
-- declare
--   t text;
-- begin
--   foreach t in array array['cook_applications', 'rider_applications']
--   loop
--     if exists (
--       select 1 from pg_publication_tables
--       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
--     ) then
--       execute format('alter publication supabase_realtime drop table public.%I', t);
--     end if;
--   end loop;
-- end $$;
-- UNDO-END
