-- NO EJECUTAR automáticamente: verificador de solo lectura.
-- Los metadatos de agenda_assert_user_active_v1 no prueban su comportamiento:
-- confirmar su implementación y bloqueo efectivo de cuentas suspendidas en Supabase.

WITH target AS (
  SELECT
    pg_catalog.to_regclass('public.announcement_read_states') AS table_oid,
    pg_catalog.to_regprocedure(
      'public.mark_announcement_read_v1(uuid,bigint)'
    )::oid AS rpc_oid,
    pg_catalog.to_regprocedure(
      'public.agenda_assert_user_active_v1(uuid)'
    )::oid AS active_check_oid
),
table_shape AS (
  SELECT
    target.table_oid,
    relation.relkind = 'r' AS is_ordinary_table,
    relation.relrowsecurity AS rls_enabled,
    (
      SELECT count(*) = 4
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = target.table_oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    ) AND NOT EXISTS (
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
          WHERE attribute.attrelid = target.table_oid
            AND attribute.attname = expected.column_name
            AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                  = expected.type_name
            AND attribute.attnotnull = expected.must_be_not_null
            AND NOT attribute.attisdropped
       )
    ) AS expected_columns
  FROM target
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.oid = target.table_oid
),
constraints AS (
  SELECT
    target.table_oid,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
         AND constraint_row.contype = 'p'
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = target.table_oid
              AND attribute.attnum = key.attnum
         ) = ARRAY['user_id', 'announcement_id']::text[]
    ) AS primary_key_valid,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
         AND constraint_row.contype = 'p'
         AND NOT constraint_row.condeferrable
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = target.table_oid
              AND attribute.attnum = key.attnum
         ) = ARRAY['user_id', 'announcement_id']::text[]
    ) AS primary_key_not_deferrable,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
         AND constraint_row.contype = 'p'
         AND constraint_row.convalidated
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = target.table_oid
              AND attribute.attnum = key.attnum
         ) = ARRAY['user_id', 'announcement_id']::text[]
    ) AS primary_key_validated,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid = pg_catalog.to_regclass('auth.users')
         AND constraint_row.confdeltype = 'c'
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = target.table_oid
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
    ) AS user_foreign_key_valid,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid = pg_catalog.to_regclass('auth.users')
         AND constraint_row.confdeltype = 'c'
         AND constraint_row.convalidated
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = target.table_oid
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
    ) AS user_foreign_key_validated,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid =
               pg_catalog.to_regclass('public.announcements')
         AND constraint_row.confdeltype = 'c'
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = target.table_oid
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
    ) AS announcement_foreign_key_valid,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid =
               pg_catalog.to_regclass('public.announcements')
         AND constraint_row.confdeltype = 'c'
         AND constraint_row.convalidated
         AND (
           SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
             FROM pg_catalog.unnest(constraint_row.conkey)
                    WITH ORDINALITY AS key(attnum, ordinality)
             JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = target.table_oid
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
    ) AS announcement_foreign_key_validated,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
         AND constraint_row.contype = 'c'
         AND pg_catalog.strpos(
           pg_catalog.replace(
             pg_catalog.pg_get_constraintdef(constraint_row.oid),
             ' ',
             ''
           ),
           'read_version>=1'
         ) > 0
    ) AS positive_version_check,
    EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = target.table_oid
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
    ) AS positive_version_check_validated
  FROM target
),
policies AS (
  SELECT
    count(*) = 1 AS only_expected_policy,
    count(*) FILTER (
      WHERE policyname = 'announcement_read_states_own'
        AND cmd = 'SELECT'
        AND permissive = 'PERMISSIVE'
        AND roles = ARRAY['authenticated']::name[]
        AND pg_catalog.regexp_replace(
          qual,
          '[[:space:]]+',
          '',
          'g'
        ) = '(user_id=auth.uid())'
        AND with_check IS NULL
    ) = 1 AS own_select_policy_valid
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'announcement_read_states'
),
table_privileges AS (
  SELECT
    CASE
      WHEN target.table_oid IS NULL THEN false
      ELSE pg_catalog.has_table_privilege(
        'authenticated', target.table_oid, 'SELECT'
      )
    END AS authenticated_select,
    CASE
      WHEN target.table_oid IS NULL THEN false
      ELSE NOT (
        pg_catalog.has_table_privilege('authenticated', target.table_oid, 'INSERT')
        OR pg_catalog.has_table_privilege('authenticated', target.table_oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('authenticated', target.table_oid, 'DELETE')
        OR pg_catalog.has_table_privilege('authenticated', target.table_oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege('authenticated', target.table_oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege('authenticated', target.table_oid, 'TRIGGER')
        OR pg_catalog.has_any_column_privilege('authenticated', target.table_oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege('authenticated', target.table_oid, 'UPDATE')
      )
    END AS authenticated_writes_revoked,
    CASE
      WHEN target.table_oid IS NULL THEN false
      ELSE NOT (
        pg_catalog.has_table_privilege('anon', target.table_oid, 'SELECT')
        OR pg_catalog.has_table_privilege('anon', target.table_oid, 'INSERT')
        OR pg_catalog.has_table_privilege('anon', target.table_oid, 'UPDATE')
        OR pg_catalog.has_table_privilege('anon', target.table_oid, 'DELETE')
        OR pg_catalog.has_any_column_privilege('anon', target.table_oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege('anon', target.table_oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege('anon', target.table_oid, 'UPDATE')
      )
    END AS anon_access_revoked,
    CASE
      WHEN target.table_oid IS NULL THEN false
      ELSE NOT EXISTS (
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
         WHERE relation.oid = target.table_oid
           AND privilege.grantee <> relation.relowner
           AND (
             privilege.grantee = 0
             OR grantee.rolname <> 'authenticated'
             OR privilege.privilege_type <> 'SELECT'
             OR privilege.is_grantable
           )
      )
    END AS no_unexpected_table_grants,
    CASE
      WHEN target.table_oid IS NULL THEN false
      ELSE NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
         WHERE attribute.attrelid = target.table_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND privilege.privilege_type IN ('INSERT', 'UPDATE')
      )
    END AS no_column_write_grants,
    CASE
      WHEN target.table_oid IS NULL THEN false
      ELSE NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
         WHERE relation.oid = target.table_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND privilege.grantee <> relation.relowner
      )
    END AS no_unexpected_column_grants
  FROM target
),
rpc AS (
  SELECT
    target.rpc_oid,
    function_row.prosecdef,
    function_row.proconfig,
    owner_role.rolname AS owner_name,
    pg_catalog.pg_get_functiondef(function_row.oid) AS definition
  FROM target
  LEFT JOIN pg_catalog.pg_proc AS function_row
    ON function_row.oid = target.rpc_oid
  LEFT JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = function_row.proowner
),
rpc_privileges AS (
  SELECT
    CASE
      WHEN target.rpc_oid IS NULL THEN false
      ELSE pg_catalog.has_function_privilege(
        'authenticated', target.rpc_oid, 'EXECUTE'
      )
    END AS authenticated_execute,
    CASE
      WHEN target.rpc_oid IS NULL THEN false
      ELSE NOT (
        pg_catalog.has_function_privilege('anon', target.rpc_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', target.rpc_oid, 'EXECUTE')
      )
    END AS anon_and_service_execute_revoked,
    CASE
      WHEN target.rpc_oid IS NULL THEN false
      ELSE NOT EXISTS (
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
         WHERE function_row.oid = target.rpc_oid
           AND privilege.privilege_type = 'EXECUTE'
           AND privilege.grantee <> function_row.proowner
           AND (
             privilege.grantee = 0
             OR grantee.rolname <> 'authenticated'
             OR privilege.is_grantable
           )
      )
    END AS no_unexpected_execute_grants
  FROM target
),
active_check AS (
  SELECT
    target.active_check_oid,
    function_row.prosecdef,
    function_row.proconfig,
    function_row.prorettype,
    owner_role.rolname AS owner_name
  FROM target
  LEFT JOIN pg_catalog.pg_proc AS function_row
    ON function_row.oid = target.active_check_oid
  LEFT JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = function_row.proowner
)
SELECT
  target.table_oid IS NOT NULL AS table_exists,
  COALESCE(table_shape.is_ordinary_table, false) AS ordinary_table,
  COALESCE(table_shape.expected_columns, false) AS expected_columns,
  COALESCE(constraints.primary_key_valid, false) AS primary_key_valid,
  COALESCE(constraints.primary_key_not_deferrable, false) AS primary_key_not_deferrable,
  COALESCE(constraints.primary_key_validated, false) AS primary_key_validated,
  COALESCE(constraints.user_foreign_key_valid, false) AS user_foreign_key_valid,
  COALESCE(constraints.user_foreign_key_validated, false) AS user_foreign_key_validated,
  COALESCE(constraints.announcement_foreign_key_valid, false) AS announcement_foreign_key_valid,
  COALESCE(constraints.announcement_foreign_key_validated, false) AS announcement_foreign_key_validated,
  COALESCE(constraints.positive_version_check, false) AS positive_version_check,
  COALESCE(constraints.positive_version_check_validated, false) AS positive_version_check_validated,
  COALESCE(
    constraints.primary_key_valid
    AND constraints.primary_key_not_deferrable
    AND constraints.primary_key_validated,
    false
  ) AS on_conflict_primary_key_usable,
  COALESCE(
    constraints.primary_key_validated
    AND constraints.user_foreign_key_validated
    AND constraints.announcement_foreign_key_validated
    AND constraints.positive_version_check_validated,
    false
  ) AS all_relevant_constraints_validated,
  COALESCE(table_shape.rls_enabled, false) AS rls_enabled,
  COALESCE(policies.only_expected_policy, false) AS only_expected_policy,
  COALESCE(policies.own_select_policy_valid, false) AS own_select_policy_valid,
  COALESCE(table_privileges.authenticated_select, false) AS authenticated_select,
  COALESCE(table_privileges.authenticated_writes_revoked, false) AS authenticated_writes_revoked,
  COALESCE(table_privileges.anon_access_revoked, false) AS anon_access_revoked,
  COALESCE(table_privileges.no_unexpected_table_grants, false) AS no_unexpected_table_grants,
  COALESCE(table_privileges.no_column_write_grants, false) AS no_column_write_grants,
  COALESCE(table_privileges.no_unexpected_column_grants, false) AS no_unexpected_column_grants,
  target.rpc_oid IS NOT NULL AS rpc_exists,
  COALESCE(rpc.prosecdef, false) AS rpc_security_definer,
  COALESCE(rpc.owner_name = 'postgres', false) AS rpc_owner_postgres,
  COALESCE(
    rpc.proconfig = ARRAY['search_path=pg_catalog']::text[],
    false
  ) AS rpc_fixed_search_path,
  COALESCE(rpc_privileges.authenticated_execute, false) AS authenticated_rpc_execute,
  COALESCE(rpc_privileges.anon_and_service_execute_revoked, false) AS anon_and_service_rpc_execute_revoked,
  COALESCE(rpc_privileges.no_unexpected_execute_grants, false) AS no_unexpected_rpc_execute_grants,
  COALESCE(
    pg_catalog.strpos(pg_catalog.lower(rpc.definition), 'auth.uid()') > 0
    AND pg_catalog.strpos(
      pg_catalog.lower(rpc.definition),
      'agenda_assert_user_active_v1'
    ) > 0
    AND pg_catalog.strpos(
      pg_catalog.lower(rpc.definition),
      'deleted_at is null'
    ) > 0
    AND pg_catalog.strpos(
      pg_catalog.lower(rpc.definition),
      'v_current_version <> p_version'
    ) > 0
    AND pg_catalog.strpos(
      pg_catalog.lower(rpc.definition),
      'p_version < 1'
    ) > 0
    AND pg_catalog.strpos(pg_catalog.lower(rpc.definition), 'for update') > 0
    AND pg_catalog.strpos(pg_catalog.lower(rpc.definition), 'greatest(') > 0,
    false
  ) AS rpc_checks_identity_active_version_and_monotonicity,
  target.active_check_oid IS NOT NULL AS active_check_exists,
  COALESCE(
    active_check.prosecdef
    AND active_check.owner_name = 'postgres'
    AND active_check.proconfig = ARRAY['search_path=pg_catalog']::text[],
    false
  ) AS active_check_metadata_protected,
  COALESCE(
    active_check.prorettype = 'void'::regtype,
    false
  ) AS active_check_returns_void,
  COALESCE(
    NOT pg_catalog.has_function_privilege(
      'anon', active_check.active_check_oid, 'EXECUTE'
    )
    AND NOT pg_catalog.has_function_privilege(
      'authenticated', active_check.active_check_oid, 'EXECUTE'
    )
    AND NOT pg_catalog.has_function_privilege(
      'service_role', active_check.active_check_oid, 'EXECUTE'
    )
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS privilege
       WHERE function_row.oid = active_check.active_check_oid
         AND privilege.grantee <> function_row.proowner
    ),
    false
  ) AS active_check_execute_grants_restricted_to_owner,
  'Catalog checks do not prove suspension behavior; verify the implementation directly in Supabase.'
    AS active_check_behavior_requires_supabase_confirmation
FROM target
CROSS JOIN table_shape
CROSS JOIN constraints
CROSS JOIN policies
CROSS JOIN table_privileges
CROSS JOIN rpc
CROSS JOIN rpc_privileges
CROSS JOIN active_check;
