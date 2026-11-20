BEGIN;

DO $confirmed_users_preflight$
DECLARE
  v_admin_list_users regprocedure := pg_catalog.to_regprocedure(
    'public.admin_list_users_v2()'
  );
  v_assignable_users regprocedure := pg_catalog.to_regprocedure(
    'public.list_assignable_event_users()'
  );
  v_admin_definition text;
  v_assignable_definition text;
  v_column record;
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.profiles') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR v_admin_list_users IS NULL
     OR v_assignable_users IS NULL THEN
    RAISE EXCEPTION
      'Run as postgres after confirming both current user-list functions and their tables exist.';
  END IF;

  FOR v_column IN
    SELECT *
    FROM (VALUES
      ('profiles', 'id', 'uuid'),
      ('profiles', 'full_name', NULL),
      ('profiles', 'phone', NULL),
      ('profiles', 'role', NULL),
      ('profiles', 'can_assign_events', NULL),
      ('profiles', 'can_publish_announcements', NULL),
      ('profiles', 'created_at', NULL),
      ('profiles', 'updated_at', NULL),
      ('auth.users', 'id', 'uuid'),
      ('auth.users', 'email', NULL),
      ('auth.users', 'email_confirmed_at', 'timestamp with time zone'),
      ('auth.users', 'banned_until', 'timestamp with time zone')
    ) AS expected(table_name, column_name, data_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          CASE
            WHEN v_column.table_name = 'profiles'
              THEN 'public.profiles'::regclass
            ELSE 'auth.users'::regclass
          END
        AND attribute.attname = v_column.column_name
        AND NOT attribute.attisdropped
        AND (
          v_column.data_type IS NULL
          OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                = v_column.data_type
        )
    ) THEN
      RAISE EXCEPTION
        'Incompatible schema at %.%.',
        v_column.table_name,
        v_column.column_name;
    END IF;
  END LOOP;

  SELECT pg_catalog.pg_get_functiondef(v_admin_list_users)
    INTO v_admin_definition;
  SELECT pg_catalog.pg_get_functiondef(v_assignable_users)
    INTO v_assignable_definition;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_admin_list_users
      AND function_row.prosecdef
      AND pg_catalog.pg_get_function_result(function_row.oid) =
        'TABLE(id uuid, full_name text, phone text, email text, role text, can_assign_events boolean, can_publish_announcements boolean, created_at timestamp with time zone, updated_at timestamp with time zone)'
  ) OR v_admin_definition NOT LIKE '%p.role = ''administrador''%'
    OR v_admin_definition NOT LIKE '%u.email::TEXT%'
    OR v_admin_definition NOT LIKE '%p.can_publish_announcements%'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_assignable_users
        AND function_row.prosecdef
        AND pg_catalog.pg_get_function_result(function_row.oid)
              = 'TABLE(id uuid, full_name text, role text)'
    )
    OR v_assignable_definition NOT LIKE '%caller.can_assign_events%'
    OR v_assignable_definition NOT LIKE '%available.role%' THEN
    RAISE EXCEPTION
      'A current user-list function differs from the reviewed signature or authorization definition.';
  END IF;
END;
$confirmed_users_preflight$;

CREATE OR REPLACE FUNCTION public.admin_list_users_v2()
RETURNS TABLE(
    id uuid,
    full_name text,
    phone text,
    email text,
    role text,
    can_assign_events boolean,
    can_publish_announcements boolean,
    created_at timestamptz,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = auth.uid()
          AND p.role = 'administrador'
    ) THEN
        RAISE EXCEPTION 'No tienes permisos para consultar usuarios'
        USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.full_name,
        p.phone,
        u.email::TEXT,
        p.role,
        p.can_assign_events,
        p.can_publish_announcements,
        p.created_at,
        p.updated_at
    FROM public.profiles p
    INNER JOIN auth.users u ON u.id = p.id
    WHERE u.email_confirmed_at IS NOT NULL
    ORDER BY p.created_at DESC;
END;
$function$;

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
    AND EXISTS (
      SELECT 1
      FROM auth.users AS auth_user
      WHERE auth_user.id = available.id
        AND auth_user.email_confirmed_at IS NOT NULL
        AND (
          auth_user.banned_until IS NULL
          OR auth_user.banned_until <= pg_catalog.now()
        )
    )
  ORDER BY available.full_name, available.id;
END;
$function$;

COMMIT;
