CREATE FUNCTION public.list_assignable_event_users()
RETURNS TABLE (
  id uuid,
  full_name text,
  role text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS caller
    WHERE caller.id = v_actor
      AND (
        caller.role::text = 'administrador'
        OR COALESCE(caller.can_assign_events, false)
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT
    available.id,
    available.full_name::text,
    available.role::text
  FROM public.profiles AS available
  WHERE available.id <> v_actor
    AND available.role::text IN ('administrador', 'empleado')
  ORDER BY available.full_name, available.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_assignable_event_users() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_assignable_event_users() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_assignable_event_users() TO authenticated;
