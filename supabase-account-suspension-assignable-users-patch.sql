BEGIN;

DO $account_suspension_preflight$
DECLARE
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.list_assignable_event_users()'
  );
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.profiles') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR v_function IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid = 'auth.users'::regclass
         AND attname = 'banned_until'
         AND atttypid = 'timestamp with time zone'::regtype
         AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_function
         AND function_row.prosecdef
         AND pg_catalog.pg_get_function_result(function_row.oid)
               = 'TABLE(id uuid, full_name text, role text)'
         AND pg_catalog.pg_get_functiondef(function_row.oid)
               LIKE '%caller.can_assign_events%'
         AND pg_catalog.pg_get_functiondef(function_row.oid)
               LIKE '%available.role%'
     ) THEN
    RAISE EXCEPTION
      'Expected the current SECURITY DEFINER assignment function, its existing return shape, and auth.users.banned_until before applying account suspension.';
  END IF;
END;
$account_suspension_preflight$;

CREATE OR REPLACE FUNCTION public.list_assignable_event_users()
RETURNS TABLE (
  id uuid,
  full_name text,
  role text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
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
    AND NOT EXISTS (
      SELECT 1
      FROM auth.users AS auth_user
      WHERE auth_user.id = available.id
        AND auth_user.banned_until > pg_catalog.now()
    )
  ORDER BY available.full_name, available.id;
END;
$function$;

COMMIT;
