BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_resources boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  category text NOT NULL CHECK (length(trim(category)) > 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  stored_in text NOT NULL DEFAULT 'Sin ubicación registrada',
  notes text[] NOT NULL DEFAULT ARRAY[]::text[]
);

CREATE TABLE IF NOT EXISTS public.resource_change_signals (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0,
  changed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.resource_change_signals (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_change_signals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.resources
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.resources
TO authenticated;
REVOKE ALL ON TABLE public.resource_change_signals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.resource_change_signals TO authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_resources()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.id = (SELECT auth.uid())
      AND (
        profile.role::text = 'administrador'
        OR COALESCE(profile.can_manage_resources, false)
      )
  );
$function$;

ALTER FUNCTION public.can_manage_resources() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_manage_resources() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_resources() TO authenticated;

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
  FROM public.resources AS resource;
END;
$function$;

ALTER FUNCTION public.resource_inventory_summary_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resource_inventory_summary_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resource_inventory_summary_v1() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_resource_permissions_v1()
RETURNS TABLE (
  user_id uuid,
  role text,
  can_manage_resources boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles AS caller
    WHERE caller.id = v_actor
      AND caller.role::text = 'administrador'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT
    profile.id,
    profile.role::text,
    COALESCE(profile.can_manage_resources, false)
  FROM public.profiles AS profile
  ORDER BY profile.full_name, profile.id;
END;
$function$;

ALTER FUNCTION public.admin_list_resource_permissions_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_list_resource_permissions_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_resource_permissions_v1() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_resource_permission_v1(
  p_user_id uuid,
  p_can_manage_resources boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles AS caller
    WHERE caller.id = v_actor
      AND caller.role::text = 'administrador'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  IF p_user_id IS NULL OR p_can_manage_resources IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_resource_permission';
  END IF;

  UPDATE public.profiles AS profile
  SET can_manage_resources = p_can_manage_resources
  WHERE profile.id = p_user_id
    AND profile.role::text = 'empleado';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'employee_not_found';
  END IF;

  RETURN true;
END;
$function$;

ALTER FUNCTION public.admin_set_resource_permission_v1(uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_set_resource_permission_v1(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_resource_permission_v1(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.notify_resource_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE public.resource_change_signals
  SET revision = revision + 1,
      changed_at = clock_timestamp()
  WHERE id = 1;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.notify_resource_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_resource_change() FROM PUBLIC, anon, authenticated;

DO $trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.resources'::regclass
      AND tgname = 'resources_change_signal'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER resources_change_signal
      AFTER INSERT OR UPDATE OR DELETE ON public.resources
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.notify_resource_change()';
  END IF;
END;
$trigger$;

DO $profile_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.profiles'::regclass
      AND tgname = 'profiles_resource_permission_signal'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER profiles_resource_permission_signal
      AFTER UPDATE OF role, can_manage_resources ON public.profiles
      FOR EACH ROW
      WHEN (
        OLD.role IS DISTINCT FROM NEW.role
        OR OLD.can_manage_resources IS DISTINCT FROM NEW.can_manage_resources
      )
      EXECUTE FUNCTION public.notify_resource_change()';
  END IF;
END;
$profile_trigger$;

DO $policies$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS resources_read_managers ON public.resources';

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'resources'
      AND policyname = 'resources_read_authenticated'
  ) THEN
    EXECUTE 'CREATE POLICY resources_read_authenticated ON public.resources
      FOR SELECT TO authenticated USING (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'resources'
      AND policyname = 'resources_insert_managers'
  ) THEN
    EXECUTE 'CREATE POLICY resources_insert_managers ON public.resources
      FOR INSERT TO authenticated WITH CHECK (public.can_manage_resources())';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'resources'
      AND policyname = 'resources_update_managers'
  ) THEN
    EXECUTE 'CREATE POLICY resources_update_managers ON public.resources
      FOR UPDATE TO authenticated
      USING (public.can_manage_resources())
      WITH CHECK (public.can_manage_resources())';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'resources'
      AND policyname = 'resources_delete_managers'
  ) THEN
    EXECUTE 'CREATE POLICY resources_delete_managers ON public.resources
      FOR DELETE TO authenticated USING (public.can_manage_resources())';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'resource_change_signals'
      AND policyname = 'resource_change_signals_read_authenticated'
  ) THEN
    EXECUTE 'CREATE POLICY resource_change_signals_read_authenticated
      ON public.resource_change_signals
      FOR SELECT TO authenticated USING (true)';
  END IF;
END;
$policies$;

DO $publication$
DECLARE
  v_publication_all_tables boolean;
BEGIN
  SELECT publication.puballtables
  INTO v_publication_all_tables
  FROM pg_catalog.pg_publication AS publication
  WHERE publication.pubname = 'supabase_realtime';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supabase publication supabase_realtime does not exist';
  END IF;

  IF NOT v_publication_all_tables AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_publication_tables AS published
    WHERE published.pubname = 'supabase_realtime'
      AND published.schemaname = 'public'
      AND published.tablename = 'resource_change_signals'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.resource_change_signals';
  END IF;
END;
$publication$;

COMMIT;
