BEGIN;

DO $cron_preflight$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'Run this migration as the postgres database role so the purge job can execute safely.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_extension
    WHERE extname = 'pg_cron'
  ) OR pg_catalog.to_regnamespace('cron') IS NULL THEN
    RAISE EXCEPTION
      'pg_cron is not enabled. Enable Supabase Cron/pg_cron before applying this migration.';
  END IF;
END;
$cron_preflight$;

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS resources_active_name_idx
  ON public.resources (name, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS resources_deleted_at_idx
  ON public.resources (deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.resource_inventory_summary_v1()
RETURNS TABLE (
  resource_count bigint,
  total_units bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT
    count(*)::bigint,
    COALESCE(sum(resource.quantity), 0)::bigint
  FROM public.resources AS resource
  WHERE resource.deleted_at IS NULL;
END;
$function$;

ALTER FUNCTION public.resource_inventory_summary_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resource_inventory_summary_v1()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resource_inventory_summary_v1()
  TO authenticated;

CREATE OR REPLACE FUNCTION public.soft_delete_resource_v1(p_resource_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NOT public.can_manage_resources() THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  UPDATE public.resources
  SET deleted_at = pg_catalog.clock_timestamp(),
      deleted_by = (SELECT auth.uid())
  WHERE id = p_resource_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'resource_not_found_or_deleted';
  END IF;

  RETURN true;
END;
$function$;

ALTER FUNCTION public.soft_delete_resource_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.soft_delete_resource_v1(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_resource_v1(uuid)
  TO authenticated;

DROP FUNCTION IF EXISTS public.restore_resource_v1(uuid);

CREATE OR REPLACE FUNCTION public.purge_expired_resources()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_purged_count bigint;
BEGIN
  DELETE FROM public.resources
  WHERE deleted_at IS NOT NULL
    AND deleted_at <= pg_catalog.clock_timestamp() - interval '1440 hours';

  GET DIAGNOSTICS v_purged_count = ROW_COUNT;
  RETURN v_purged_count;
END;
$function$;

ALTER FUNCTION public.purge_expired_resources() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.purge_expired_resources()
  FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS resources_read_managers
  ON public.resources;
DROP POLICY IF EXISTS resources_read_authenticated
  ON public.resources;
DROP POLICY IF EXISTS resources_read_active_authenticated
  ON public.resources;
DROP POLICY IF EXISTS resources_read_trash_managers
  ON public.resources;

CREATE POLICY resources_read_active_authenticated
  ON public.resources
  FOR SELECT
  TO authenticated
  USING (deleted_at IS NULL);

DROP POLICY IF EXISTS resources_update_managers
  ON public.resources;
CREATE POLICY resources_update_managers
  ON public.resources
  FOR UPDATE
  TO authenticated
  USING (public.can_manage_resources() AND deleted_at IS NULL)
  WITH CHECK (public.can_manage_resources() AND deleted_at IS NULL);

DROP POLICY IF EXISTS resources_delete_managers
  ON public.resources;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.resources
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT (deleted_at, deleted_by), UPDATE (deleted_at, deleted_by)
  ON TABLE public.resources
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.resources TO authenticated;
GRANT INSERT (name, category, quantity, stored_in, notes)
  ON TABLE public.resources TO authenticated;
GRANT UPDATE (name, category, quantity, stored_in, notes)
  ON TABLE public.resources TO authenticated;

DO $cron_schedule$
BEGIN
  PERFORM cron.schedule(
    'resources-trash-purge-60-days',
    '5 0 * * *',
    'SELECT public.purge_expired_resources();'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'resources-trash-purge-60-days'
      AND schedule = '5 0 * * *'
      AND command = 'SELECT public.purge_expired_resources();'
      AND active
  ) THEN
    RAISE EXCEPTION 'The 60-day resource purge job was not registered correctly.';
  END IF;
END;
$cron_schedule$;

COMMIT;
