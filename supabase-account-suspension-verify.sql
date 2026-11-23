-- NO EJECUTAR automáticamente: un único SELECT consolidado para ORIGINAL.
-- No modifica objetos, datos, configuración ni permisos.
-- PASS/FAIL/MISSING informa estado de catálogo o pruebas pendientes; PASS no
-- sustituye las verificaciones de comportamiento contra PostgREST/Realtime.
-- Los FAIL con "Known Realtime DELETE risk" señalan riesgos conocidos del
-- transporte DELETE y no significan, por sí solos, que la instalación haya fallado.

WITH
expected_rpc(signature) AS (
  VALUES
    ('public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'),
    ('public.activate_profile_settings_verification_v1(uuid,uuid)'),
    ('public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'),
    ('public.cancel_profile_settings_verification_v1(uuid,uuid)')
),
resolved_rpc AS (
  SELECT signature, pg_catalog.to_regprocedure(signature)::oid AS function_oid
  FROM expected_rpc
),
assert_helper AS (
  SELECT pg_catalog.to_regprocedure(
    'public.agenda_assert_user_active_v1(uuid)'
  )::oid AS function_oid
),
rpc_checks AS (
  SELECT
    'RPC: ' || resolved.signature AS check_name,
    CASE
      WHEN resolved.function_oid IS NULL THEN 'MISSING'
      WHEN assert_helper.function_oid IS NULL THEN 'MISSING'
      WHEN NOT rpc.prosecdef THEN 'FAIL'
      WHEN owner_role.rolname IN ('anon', 'authenticated') THEN 'FAIL'
      WHEN position(
        'agenda_assert_user_active_v1(p_user_id)' IN
          pg_catalog.pg_get_functiondef(resolved.function_oid)
      ) = 0 THEN 'FAIL'
      WHEN position(
        'p_user_id IS NULL' IN
          pg_catalog.pg_get_functiondef(resolved.function_oid)
      ) = 0 THEN 'FAIL'
      WHEN NOT COALESCE(pg_catalog.has_function_privilege(
        rpc.proowner, assert_helper.function_oid, 'EXECUTE'
      ), false) THEN 'FAIL'
      WHEN NOT COALESCE(pg_catalog.has_function_privilege(
        'service_role', resolved.function_oid, 'EXECUTE'
      ), false) THEN 'FAIL'
      WHEN COALESCE(pg_catalog.has_function_privilege(
        'authenticated', resolved.function_oid, 'EXECUTE'
      ), false) THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    pg_catalog.concat_ws(
      '; ',
      'owner=' || COALESCE(owner_role.rolname, 'unknown'),
      'acl=' || COALESCE(rpc.proacl::text, 'default'),
      'SECURITY DEFINER=' || COALESCE(rpc.prosecdef::text, 'unknown'),
      'owner can execute helper=' || COALESCE(pg_catalog.has_function_privilege(
        rpc.proowner, assert_helper.function_oid, 'EXECUTE'
      )::text, 'unknown')
    ) AS details
  FROM resolved_rpc AS resolved
  CROSS JOIN assert_helper
  LEFT JOIN pg_catalog.pg_proc AS rpc ON rpc.oid = resolved.function_oid
  LEFT JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = rpc.proowner
),
expected_helpers(helper_name, signature, kind) AS (
  VALUES
    ('agenda_account_is_active_v1', 'public.agenda_account_is_active_v1()', 'active'),
    ('agenda_assert_user_active_v1', 'public.agenda_assert_user_active_v1(uuid)', 'assert'),
    ('agenda_account_suspension_pre_request_v1', 'public.agenda_account_suspension_pre_request_v1()', 'hook')
),
resolved_helpers AS (
  SELECT helper_name,
         signature,
         kind,
         pg_catalog.to_regprocedure(signature)::oid AS function_oid
  FROM expected_helpers
),
helper_checks AS (
  SELECT
    'Helper: ' || resolved.helper_name AS check_name,
    CASE
      WHEN resolved.function_oid IS NULL THEN 'MISSING'
      WHEN owner_role.rolname <> 'postgres' THEN 'FAIL'
      WHEN NOT helper.prosecdef
        OR helper.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
        THEN 'FAIL'
      WHEN EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(COALESCE(
          helper.proacl,
          pg_catalog.acldefault('f', helper.proowner)
        )) AS acl
        WHERE acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
      ) THEN 'FAIL'
      WHEN EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(COALESCE(
          helper.proacl,
          pg_catalog.acldefault('f', helper.proowner)
        )) AS acl
        WHERE acl.privilege_type = 'EXECUTE'
          AND acl.grantee <> helper.proowner
          AND NOT (
            (
              resolved.kind = 'active'
              AND acl.grantee = (
                SELECT oid FROM pg_catalog.pg_roles
                WHERE rolname = 'authenticated'
              )
            )
            OR (
              resolved.kind = 'assert'
              AND acl.grantee IN (
                SELECT rpc.proowner
                FROM resolved_rpc AS expected
                JOIN pg_catalog.pg_proc AS rpc
                  ON rpc.oid = expected.function_oid
              )
            )
            OR (
              resolved.kind = 'hook'
              AND acl.grantee IN (
                SELECT oid FROM pg_catalog.pg_roles
                WHERE rolname IN ('anon', 'authenticated', 'service_role')
              )
            )
          )
      ) THEN 'FAIL'
      WHEN resolved.kind = 'active'
        AND (
          NOT COALESCE(pg_catalog.has_function_privilege(
            'authenticated', resolved.function_oid, 'EXECUTE'
          ), false)
          OR pg_catalog.has_function_privilege(
            'anon', resolved.function_oid, 'EXECUTE'
          )
          OR pg_catalog.has_function_privilege(
            'service_role', resolved.function_oid, 'EXECUTE'
          )
          OR position(
            'banned_until' IN pg_catalog.pg_get_functiondef(resolved.function_oid)
          ) = 0
        ) THEN 'FAIL'
      WHEN resolved.kind = 'assert'
        AND (
          pg_catalog.has_function_privilege(
            'anon', resolved.function_oid, 'EXECUTE'
          )
          OR pg_catalog.has_function_privilege(
            'authenticated', resolved.function_oid, 'EXECUTE'
          )
          OR position(
            '{"code":"account_suspended","message":"Account suspended"}'
            IN pg_catalog.pg_get_functiondef(resolved.function_oid)
          ) = 0
          OR position(
            '"status":403' IN pg_catalog.pg_get_functiondef(resolved.function_oid)
          ) = 0
        ) THEN 'FAIL'
      WHEN resolved.kind = 'hook'
        AND (
          NOT COALESCE(pg_catalog.has_function_privilege(
            'anon', resolved.function_oid, 'EXECUTE'
          ), false)
          OR NOT COALESCE(pg_catalog.has_function_privilege(
            'authenticated', resolved.function_oid, 'EXECUTE'
          ), false)
          OR NOT COALESCE(pg_catalog.has_function_privilege(
            'service_role', resolved.function_oid, 'EXECUTE'
          ), false)
          OR position(
            'account_suspended' IN pg_catalog.pg_get_functiondef(resolved.function_oid)
          ) = 0
          OR position(
            '"status":403' IN pg_catalog.pg_get_functiondef(resolved.function_oid)
          ) = 0
        ) THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    pg_catalog.concat_ws(
      '; ',
      'owner=' || COALESCE(owner_role.rolname, 'unknown'),
      'acl=' || COALESCE(helper.proacl::text, 'default'),
      'kind=' || resolved.kind
    ) AS details
  FROM resolved_helpers AS resolved
  LEFT JOIN pg_catalog.pg_proc AS helper ON helper.oid = resolved.function_oid
  LEFT JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = helper.proowner
),
expected_policies(tablename, policyname) AS (
  VALUES
    ('event_sync_changes', 'account_active_event_sync_select'),
    ('resource_change_signals', 'account_active_resource_signal_select'),
    ('announcement_change_signals', 'account_active_announcement_signal_select'),
    ('notification_change_signals', 'account_active_notification_signal_select')
),
policy_checks AS (
  SELECT
    'Policy: ' || expected.policyname AS check_name,
    CASE
      WHEN policy.policyname IS NULL THEN 'MISSING'
      WHEN policy.permissive <> 'RESTRICTIVE'
        OR policy.cmd <> 'SELECT'
        OR policy.roles <> ARRAY['authenticated']::name[]
        OR COALESCE(position(
          'agenda_account_is_active_v1()' IN policy.qual
        ), 0) = 0
        OR COALESCE(position('IS TRUE' IN policy.qual), 0) = 0
        THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    'table=' || expected.tablename || '; qual=' ||
      COALESCE(policy.qual, 'missing') AS details
  FROM expected_policies AS expected
  LEFT JOIN pg_catalog.pg_policies AS policy
    ON policy.schemaname = 'public'
   AND policy.tablename = expected.tablename
   AND policy.policyname = expected.policyname
),
expected_tables(tablename, expected_identity_columns) AS (
  VALUES
    ('event_sync_changes', 'user_id,cursor'),
    ('resource_change_signals', 'id'),
    ('announcement_change_signals', 'id'),
    ('notification_change_signals', 'recipient_id')
),
resolved_tables AS (
  SELECT expected.tablename,
         expected.expected_identity_columns,
         relation.oid AS relation_oid,
         relation.relrowsecurity,
         relation.relreplident,
         replica_key.identity_columns
  FROM expected_tables AS expected
  LEFT JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.nspname = 'public'
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = namespace.oid
   AND relation.relname = expected.tablename
  LEFT JOIN LATERAL (
    SELECT pg_catalog.string_agg(
      attribute.attname::text, ',' ORDER BY key_column.ordinality
    ) AS identity_columns
    FROM pg_catalog.pg_index AS index_row
    CROSS JOIN LATERAL pg_catalog.unnest(index_row.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = index_row.indrelid
     AND attribute.attnum = key_column.attnum
    WHERE index_row.indrelid = relation.oid
      AND (
        (relation.relreplident = 'd' AND index_row.indisprimary)
        OR (relation.relreplident = 'i' AND index_row.indisreplident)
      )
      AND key_column.ordinality <= index_row.indnkeyatts
  ) AS replica_key ON true
),
table_checks AS (
  SELECT
    'RLS table: ' || resolved.tablename AS check_name,
    CASE
      WHEN resolved.relation_oid IS NULL THEN 'MISSING'
      WHEN NOT resolved.relrowsecurity THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    'relrowsecurity=' || COALESCE(resolved.relrowsecurity::text, 'missing')
      AS details
  FROM resolved_tables AS resolved

  UNION ALL

  SELECT
    'Realtime membership: ' || resolved.tablename AS check_name,
    CASE
      WHEN resolved.relation_oid IS NULL THEN 'MISSING'
      WHEN publication.tablename IS NULL THEN 'MISSING'
      ELSE 'PASS'
    END AS status,
    'publication=supabase_realtime; schema=public' AS details
  FROM resolved_tables AS resolved
  LEFT JOIN pg_catalog.pg_publication_tables AS publication
    ON publication.pubname = 'supabase_realtime'
   AND publication.schemaname = 'public'
   AND publication.tablename = resolved.tablename

  UNION ALL

  SELECT
    'Known Realtime DELETE risk: replica identity: ' || resolved.tablename AS check_name,
    CASE
      WHEN resolved.relation_oid IS NULL THEN 'MISSING'
      WHEN resolved.relreplident = 'f' THEN 'FAIL'
      WHEN resolved.relreplident = 'n' THEN 'MISSING'
      WHEN resolved.identity_columns IS NULL THEN 'MISSING'
      WHEN resolved.identity_columns <> resolved.expected_identity_columns THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    pg_catalog.concat_ws(
      '; ',
      'Known DELETE risk check; FAIL here is not an installation failure by itself',
      'relreplident=' || COALESCE(resolved.relreplident::text, 'missing'),
      'DELETE identity columns=' || COALESCE(resolved.identity_columns, 'none'),
      'expected columns=' || resolved.expected_identity_columns,
      'RLS does not filter DELETE events'
    ) AS details
  FROM resolved_tables AS resolved
),
publication_state AS (
  SELECT pubname, pubinsert, pubupdate, pubdelete, pubtruncate
  FROM pg_catalog.pg_publication
  WHERE pubname = 'supabase_realtime'
),
publication_checks AS (
  SELECT
    'Known Realtime DELETE risk: publication scope' AS check_name,
    CASE
      WHEN publication.pubname IS NULL THEN 'MISSING'
      WHEN publication.pubdelete THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    CASE
      WHEN publication.pubname IS NULL THEN 'supabase_realtime publication not found'
      ELSE pg_catalog.concat_ws(
        '; ',
        'publish insert=' || publication.pubinsert::text,
        'update=' || publication.pubupdate::text,
        'delete=' || publication.pubdelete::text,
        'truncate=' || publication.pubtruncate::text,
        CASE WHEN publication.pubdelete
          THEN 'Known residual risk, not an installation failure by itself: DELETE is enabled; RLS does not filter it'
          ELSE 'DELETE is disabled for this publication'
        END
      )
    END AS details
  FROM (VALUES (1)) AS seed(dummy)
  LEFT JOIN publication_state AS publication ON true
),
notification_delete_checks AS (
  SELECT
    'Known Realtime DELETE risk: notification signal profile-delete cascade' AS check_name,
    CASE
      WHEN pg_catalog.to_regclass('public.notification_change_signals') IS NULL
        OR pg_catalog.to_regclass('public.profiles') IS NULL THEN 'MISSING'
      WHEN EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.contype = 'f'
          AND constraint_row.conrelid =
            pg_catalog.to_regclass('public.notification_change_signals')
          AND constraint_row.confrelid = pg_catalog.to_regclass('public.profiles')
          AND constraint_row.confdeltype = 'c'
      ) THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    'Known DELETE risk check, not installation validity: a profile DELETE cascades to its signal when the FK is ON DELETE CASCADE; inspect production constraints.' AS details
),
config_counts AS (
  SELECT
    (
      SELECT count(*)
      FROM pg_catalog.pg_db_role_setting AS role_setting
      JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = role_setting.setrole
      JOIN pg_catalog.pg_database AS database_row
        ON database_row.oid = role_setting.setdatabase
      CROSS JOIN LATERAL pg_catalog.unnest(role_setting.setconfig) AS setting(config)
      WHERE role_row.rolname = 'authenticator'
        AND database_row.datname = 'postgres'
        AND setting.config =
          'pgrst.db_pre_request=public.agenda_account_suspension_pre_request_v1'
    ) AS exact_count,
    (
      SELECT count(*)
      FROM pg_catalog.pg_db_role_setting AS role_setting
      CROSS JOIN LATERAL pg_catalog.unnest(role_setting.setconfig) AS setting(config)
      WHERE setting.config ILIKE 'pgrst.db_pre_request=%'
        AND NOT (
          role_setting.setrole = (
            SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticator'
          )
          AND role_setting.setdatabase = (
            SELECT oid FROM pg_catalog.pg_database WHERE datname = 'postgres'
          )
          AND setting.config =
            'pgrst.db_pre_request=public.agenda_account_suspension_pre_request_v1'
        )
    ) AS conflicting_count
),
config_checks AS (
  SELECT
    'PostgREST scoped pre-request setting' AS check_name,
    CASE
      WHEN exact_count = 0 THEN 'MISSING'
      WHEN exact_count <> 1 THEN 'FAIL'
      ELSE 'PASS'
    END AS status,
    'expected authenticator IN DATABASE postgres; exact_count=' ||
      exact_count::text AS details
  FROM config_counts

  UNION ALL

  SELECT
    'Other pgrst.db_pre_request scopes' AS check_name,
    CASE WHEN conflicting_count = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
    'conflicting_count=' || conflicting_count::text AS details
  FROM config_counts
),
database_checks AS (
  SELECT
    'Database target' AS check_name,
    CASE WHEN current_database() = 'postgres' THEN 'PASS' ELSE 'FAIL' END AS status,
    'current_database=' || current_database() AS details

  UNION ALL

  SELECT
    'SQL execution role' AS check_name,
    CASE WHEN current_user = 'postgres' THEN 'PASS' ELSE 'FAIL' END AS status,
    'current_user=' || current_user AS details
),
auth_privilege_checks AS (
  SELECT
    'Auth table privileges for helper owner' AS check_name,
    CASE
      WHEN pg_catalog.to_regclass('auth.users') IS NULL THEN 'MISSING'
      WHEN pg_catalog.has_table_privilege('postgres', 'auth.users', 'SELECT')
       AND pg_catalog.has_table_privilege('postgres', 'auth.users', 'UPDATE')
        THEN 'PASS'
      ELSE 'FAIL'
    END AS status,
    CASE
      WHEN pg_catalog.to_regclass('auth.users') IS NULL THEN
        'auth.users missing; no grants to auth.users are added'
      ELSE
        'postgres SELECT=' ||
          COALESCE(pg_catalog.has_table_privilege(
            'postgres', 'auth.users', 'SELECT'
          )::text, 'unknown')
          || '; UPDATE=' ||
          COALESCE(pg_catalog.has_table_privilege(
            'postgres', 'auth.users', 'UPDATE'
          )::text, 'unknown')
          || '; no grants to auth.users are added'
    END AS details
),
expected_baseline(signature, expected_md5) AS (
  VALUES
    ('public.issue_profile_settings_verification_v1(uuid,uuid,text,text)',
     '2d78f67ffd7f8e6e535e1cb636d8d5a6'),
    ('public.list_assignable_event_users()',
     '78915a3d6d1159e2036dd0449171f153'),
    ('public.can_manage_resources()',
     'eb2e089baac09325062834848932b855')
),
baseline_checks AS (
  SELECT
    'Unchanged function: ' || expected.signature AS check_name,
    CASE
      WHEN function_info.function_oid IS NULL THEN 'MISSING'
      WHEN expected.expected_md5 IS NULL THEN 'MISSING'
      WHEN pg_catalog.md5(pg_catalog.pg_get_functiondef(function_info.function_oid))
           = expected.expected_md5 THEN 'PASS'
      ELSE 'FAIL'
    END AS status,
    COALESCE('expected MD5=' || expected.expected_md5,
      'canonical MD5 unavailable in supplied production CSV')
      || '; actual MD5=' ||
      COALESCE(pg_catalog.md5(pg_catalog.pg_get_functiondef(
        function_info.function_oid
      )), 'missing') AS details
  FROM expected_baseline AS expected
  CROSS JOIN LATERAL (
    SELECT pg_catalog.to_regprocedure(expected.signature)::oid AS function_oid
  ) AS function_info
),
service_checks(check_name, status, details) AS (
  VALUES
    (
      'Service test: PostgREST loaded config and schema cache',
      'MISSING',
      'Must be confirmed against the running PostgREST service.'
    ),
    (
      'Service test: active/suspended HTTP response and CORS',
      'MISSING',
      'Verify HTTP 403 plus account_suspended and CORS; do not infer suspension from network/Auth failures.'
    ),
    (
      'Service test: deployed profile-settings-verification RPC paths',
      'MISSING',
      'Verify cancel, request/reserve/activate, and verify return HTTP 403 account_suspended.'
    ),
    (
      'Service test: existing Realtime connections and DELETE delivery',
      'MISSING',
      'SQL catalog checks cannot prove a live WebSocket is closed or a DELETE event is withheld.'
    ),
    (
      'Service test: service_role, Cron, OTP, and email-change flows',
      'MISSING',
      'Run focused post-deployment checks without changing existing jobs or flows.'
    )
),
all_checks(check_name, status, details) AS (
  SELECT check_name, status, details FROM database_checks
  UNION ALL SELECT check_name, status, details FROM rpc_checks
  UNION ALL SELECT check_name, status, details FROM helper_checks
  UNION ALL SELECT check_name, status, details FROM policy_checks
  UNION ALL SELECT check_name, status, details FROM table_checks
  UNION ALL SELECT check_name, status, details FROM publication_checks
  UNION ALL SELECT check_name, status, details FROM notification_delete_checks
  UNION ALL SELECT check_name, status, details FROM config_checks
  UNION ALL SELECT check_name, status, details FROM auth_privilege_checks
  UNION ALL SELECT check_name, status, details FROM baseline_checks
  UNION ALL SELECT check_name, status, details FROM service_checks
)
SELECT status, check_name, details
FROM all_checks
ORDER BY
  CASE status WHEN 'FAIL' THEN 0 WHEN 'MISSING' THEN 1 ELSE 2 END,
  check_name;
