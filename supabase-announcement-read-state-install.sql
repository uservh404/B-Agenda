-- NO EJECUTAR: propuesta para revisión de AgendaJuventud ORIGINAL.
-- Define persistencia remota por usuario y versión para lecturas de Anuncios.
-- Requiere public.agenda_assert_user_active_v1(uuid) de la instalación de suspensión.
-- Confirma en Supabase el comportamiento real del validador antes de instalar.

BEGIN;

DO $announcement_read_state_preflight$
DECLARE
  v_states_oid oid := pg_catalog.to_regclass('public.announcement_read_states');
  v_announcements_oid oid := pg_catalog.to_regclass('public.announcements');
  v_active_check_oid oid := pg_catalog.to_regprocedure(
    'public.agenda_assert_user_active_v1(uuid)'
  );
  v_read_rpc_oid oid := pg_catalog.to_regprocedure(
    'public.mark_announcement_read_v1(uuid,bigint)'
  );
  v_active_check_owner name;
  v_active_check_security_definer boolean;
  v_active_check_config text[];
  v_active_check_return_type oid;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'Run as postgres; no announcement read-state objects were changed.';
  END IF;

  IF v_announcements_oid IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = v_announcements_oid
          AND attname = 'id'
          AND atttypid = 'uuid'::regtype
          AND attnotnull
          AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = v_announcements_oid
          AND attname = 'version'
          AND atttypid = 'bigint'::regtype
          AND attnotnull
          AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = v_announcements_oid
          AND attname = 'deleted_at'
          AND atttypid = 'timestamptz'::regtype
          AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION
      'The announcements table is missing the required id, version, or deleted_at schema.';
  END IF;

  IF v_active_check_oid IS NULL THEN
    RAISE EXCEPTION
      'Required account-suspension validator public.agenda_assert_user_active_v1(uuid) is missing; no announcement read-state objects were changed.';
  END IF;

  SELECT owner_role.rolname,
         function_row.prosecdef,
         function_row.proconfig,
         function_row.prorettype
    INTO v_active_check_owner,
         v_active_check_security_definer,
         v_active_check_config,
         v_active_check_return_type
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = function_row.proowner
   WHERE function_row.oid = v_active_check_oid;

  IF v_active_check_owner IS DISTINCT FROM 'postgres'
     OR v_active_check_security_definer IS DISTINCT FROM true
     OR v_active_check_config IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
     OR v_active_check_return_type IS DISTINCT FROM 'void'::regtype THEN
    RAISE EXCEPTION
      'The account-suspension validator metadata is incompatible; no announcement read-state objects were changed.';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon', v_active_check_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_active_check_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_active_check_oid, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege
        WHERE function_row.oid = v_active_check_oid
          AND privilege.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION
      'The account-suspension validator has unexpected execute grants; no announcement read-state objects were changed.';
  END IF;

  IF v_states_oid IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class
       WHERE oid = v_states_oid
         AND relkind = 'r'
    ) THEN
      RAISE EXCEPTION
        'public.announcement_read_states exists but is not an ordinary table.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM (VALUES
          ('user_id', 'uuid', true),
          ('announcement_id', 'uuid', true),
          ('read_version', 'bigint', true),
          ('read_at', 'timestamp with time zone', true)
        ) AS expected(column_name, type_name, must_be_not_null)
       WHERE NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = v_states_oid
            AND attribute.attname = expected.column_name
            AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                  = expected.type_name
            AND attribute.attnotnull = expected.must_be_not_null
            AND NOT attribute.attisdropped
       )
    ) OR (
      SELECT count(*)
        FROM pg_catalog.pg_attribute
       WHERE attrelid = v_states_oid
         AND attnum > 0
         AND NOT attisdropped
    ) <> 4 THEN
      RAISE EXCEPTION
        'public.announcement_read_states has an incompatible schema; inspect it before installation.';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = v_states_oid
         AND constraint_row.contype = 'p'
         AND NOT constraint_row.condeferrable
         AND constraint_row.convalidated
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = v_states_oid
              AND attribute.attnum = key.attnum
         ) = ARRAY['user_id', 'announcement_id']::text[]
    ) OR NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = v_states_oid
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid = 'auth.users'::regclass
         AND constraint_row.confdeltype = 'c'
         AND constraint_row.convalidated
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = v_states_oid
              AND attribute.attnum = key.attnum
         ) = ARRAY['user_id']::text[]
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.confkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = constraint_row.confrelid
              AND attribute.attnum = key.attnum
         ) = ARRAY['id']::text[]
    ) OR NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = v_states_oid
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid = 'public.announcements'::regclass
         AND constraint_row.confdeltype = 'c'
         AND constraint_row.convalidated
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = v_states_oid
              AND attribute.attnum = key.attnum
         ) = ARRAY['announcement_id']::text[]
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.confkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = constraint_row.confrelid
              AND attribute.attnum = key.attnum
         ) = ARRAY['id']::text[]
    ) OR NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = v_states_oid
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.strpos(
           pg_catalog.replace(
             pg_catalog.pg_get_constraintdef(constraint_row.oid),
             ' ',
             ''
           ),
           'read_version>=1'
         ) > 0
    ) THEN
      RAISE EXCEPTION
        'public.announcement_read_states is missing a required key, foreign key, or version constraint; inspect it before installation.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'announcement_read_states'
         AND policyname <> 'announcement_read_states_own'
    ) THEN
      RAISE EXCEPTION
        'Unexpected policies exist on public.announcement_read_states; inspect them before installation.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS grantee
          ON grantee.oid = privilege.grantee
       WHERE relation.oid = v_states_oid
         AND privilege.grantee <> relation.relowner
         AND privilege.grantee <> 0
         AND grantee.rolname NOT IN ('anon', 'authenticated', 'service_role')
    ) OR EXISTS (
      SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS grantee
          ON grantee.oid = privilege.grantee
       WHERE attribute.attrelid = v_states_oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND privilege.grantee <> (
           SELECT relation.relowner
             FROM pg_catalog.pg_class AS relation
            WHERE relation.oid = v_states_oid
         )
         AND privilege.grantee <> 0
         AND grantee.rolname NOT IN ('anon', 'authenticated', 'service_role')
    ) THEN
      RAISE EXCEPTION
        'Unexpected role grants exist on public.announcement_read_states; inspect them before installation.';
    END IF;
  END IF;

  IF v_read_rpc_oid IS NOT NULL AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee
        ON grantee.oid = privilege.grantee
     WHERE function_row.oid = v_read_rpc_oid
       AND privilege.grantee <> function_row.proowner
       AND privilege.grantee <> 0
       AND grantee.rolname NOT IN ('anon', 'authenticated', 'service_role')
  ) THEN
    RAISE EXCEPTION
      'Unexpected role grants exist on public.mark_announcement_read_v1; inspect them before installation.';
  END IF;
END;
$announcement_read_state_preflight$;

CREATE TABLE IF NOT EXISTS public.announcement_read_states (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  read_version bigint NOT NULL CHECK (read_version >= 1),
  read_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (user_id, announcement_id)
);

ALTER TABLE public.announcement_read_states ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.announcement_read_states
  FROM PUBLIC, anon, authenticated, service_role;

DO $announcement_read_state_column_privileges$
DECLARE
  v_column record;
BEGIN
  FOR v_column IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.announcement_read_states'::regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE public.announcement_read_states FROM PUBLIC, anon, authenticated, service_role',
      v_column.attname
    );
  END LOOP;
END;
$announcement_read_state_column_privileges$;

GRANT SELECT ON TABLE public.announcement_read_states TO authenticated;

DROP POLICY IF EXISTS announcement_read_states_own
  ON public.announcement_read_states;
CREATE POLICY announcement_read_states_own
  ON public.announcement_read_states
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.mark_announcement_read_v1(
  p_announcement_id uuid,
  p_version bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_current_version bigint;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;
  PERFORM public.agenda_assert_user_active_v1(v_user_id);
  IF p_announcement_id IS NULL OR p_version IS NULL OR p_version < 1 THEN
    RETURN FALSE;
  END IF;

  SELECT announcement.version
    INTO v_current_version
    FROM public.announcements AS announcement
   WHERE announcement.id = p_announcement_id
     AND announcement.deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND OR v_current_version <> p_version THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.announcement_read_states (
    user_id,
    announcement_id,
    read_version,
    read_at
  )
  VALUES (v_user_id, p_announcement_id, p_version, pg_catalog.clock_timestamp())
  ON CONFLICT (user_id, announcement_id)
  DO UPDATE SET
    read_version = GREATEST(public.announcement_read_states.read_version, EXCLUDED.read_version),
    read_at = CASE
      WHEN EXCLUDED.read_version > public.announcement_read_states.read_version
        THEN EXCLUDED.read_at
      ELSE public.announcement_read_states.read_at
    END;

  RETURN TRUE;
END;
$function$;

ALTER FUNCTION public.mark_announcement_read_v1(uuid, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_announcement_read_v1(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_announcement_read_v1(uuid, bigint)
  TO authenticated;

COMMIT;
