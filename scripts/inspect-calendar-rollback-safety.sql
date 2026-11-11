-- Read-only inspection for AgendaJuventud SQL Editor.
-- Run each SELECT and review all result sets before considering a ROLLBACK test.

-- 1. Calendar functions, owners, execution grants, source and external-effect markers.
WITH calendar_functions AS (
  SELECT
    p.oid,
    p.proacl,
    p.proowner,
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
    owner_role.rolname AS owner_name,
    language.lanname AS language_name,
    p.prosecdef AS is_security_definer,
    COALESCE(array_to_string(p.proconfig, ', '), '(none)') AS function_settings,
    pg_catalog.pg_get_functiondef(p.oid) AS function_definition
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n
    ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = p.proowner
  JOIN pg_catalog.pg_language AS language
    ON language.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND (
      p.proname = ANY (ARRAY[
        'save_event',
        'cancel_event',
        'reject_event_operation',
        'record_event_sync_conflict',
        'append_event_sync_changes',
        'can_read_event',
        'discard_event_sync_conflict'
      ])
      OR pg_catalog.pg_get_functiondef(p.oid) ILIKE ANY (ARRAY[
        '%public.events%',
        '%public.event_participants%',
        '%public.event_reservations%',
        '%public.event_operation_receipts%',
        '%public.event_sync_state%',
        '%public.event_sync_changes%',
        '%public.event_sync_conflicts%'
      ])
    )
)
SELECT
  function_name,
  identity_arguments,
  owner_name,
  language_name,
  is_security_definer,
  function_settings,
  CASE
    WHEN pg_catalog.to_regrole('anon') IS NULL THEN NULL
    ELSE pg_catalog.has_function_privilege('anon', oid, 'EXECUTE')
  END AS anon_can_execute,
  CASE
    WHEN pg_catalog.to_regrole('authenticated') IS NULL THEN NULL
    ELSE pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE')
  END AS authenticated_can_execute,
  (
    SELECT pg_catalog.string_agg(
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.pg_get_userbyid(acl.grantee)
      END || CASE WHEN acl.is_grantable THEN ':EXECUTE (grantable)' ELSE ':EXECUTE' END,
      ', ' ORDER BY acl.grantee
    )
    FROM pg_catalog.aclexplode(
      COALESCE(calendar_functions.proacl, pg_catalog.acldefault('f', calendar_functions.proowner))
    ) AS acl
    WHERE acl.privilege_type = 'EXECUTE'
  ) AS execute_grants,
  pg_catalog.array_remove(ARRAY[
    CASE WHEN function_definition ILIKE '%http%' THEN 'HTTP-related text' END,
    CASE WHEN function_definition ILIKE '%pg_net%' OR function_definition ILIKE '%net.http%' THEN 'pg_net/HTTP extension reference' END,
    CASE WHEN function_definition ILIKE '%dblink%' THEN 'dblink reference' END,
    CASE WHEN function_definition ILIKE '%pg_notify%' OR function_definition ~* '(^|[^a-z])notify([^a-z]|$)' THEN 'notification reference' END,
    CASE WHEN function_definition ILIKE '%webhook%' THEN 'webhook reference' END,
    CASE WHEN function_definition ILIKE '%lo_export%' OR function_definition ILIKE '%lo_import%' THEN 'large-object file operation reference' END,
    CASE WHEN function_definition ILIKE '%COPY %PROGRAM%' OR function_definition ILIKE '%pg_execute_server_program%' THEN 'server command/program reference' END,
    CASE WHEN function_definition ILIKE '%supabase_functions%' THEN 'supabase_functions reference' END,
    CASE WHEN function_definition ILIKE '%EXECUTE %' OR function_definition ILIKE '%EXECUTE format%' THEN 'dynamic SQL text; inspect manually' END
  ]::text[], NULL) AS possible_external_or_dynamic_effects,
  function_definition
FROM calendar_functions
ORDER BY function_name, identity_arguments;

-- 2. All triggers (including internal constraint triggers) on the seven event tables.
WITH calendar_tables(table_name) AS (
  VALUES
    ('events'),
    ('event_participants'),
    ('event_reservations'),
    ('event_operation_receipts'),
    ('event_sync_state'),
    ('event_sync_changes'),
    ('event_sync_conflicts')
)
SELECT
  calendar_tables.table_name,
  relation.oid IS NOT NULL AS table_exists,
  COALESCE(relation.relrowsecurity, false) AS row_level_security_enabled,
  COALESCE(relation.relforcerowsecurity, false) AS row_level_security_forced,
  trigger_row.tgname AS trigger_name,
  trigger_row.tgisinternal AS is_internal_trigger,
  CASE trigger_row.tgenabled
    WHEN 'O' THEN 'enabled'
    WHEN 'D' THEN 'disabled'
    WHEN 'R' THEN 'replica'
    WHEN 'A' THEN 'always'
    ELSE '(no trigger)'
  END AS trigger_state,
  CASE
    WHEN trigger_row.oid IS NULL THEN NULL
    ELSE pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
  END AS trigger_definition,
  trigger_owner.rolname AS trigger_function_owner,
  trigger_function.prosecdef AS trigger_function_is_security_definer,
  trigger_language.lanname AS trigger_function_language,
  CASE
    WHEN trigger_function.oid IS NULL THEN NULL
    ELSE pg_catalog.pg_get_functiondef(trigger_function.oid)
  END AS trigger_function_definition,
  pg_catalog.array_remove(ARRAY[
    CASE WHEN trigger_function.oid IS NOT NULL
      AND pg_catalog.pg_get_functiondef(trigger_function.oid) ILIKE '%http%'
      THEN 'HTTP-related text' END,
    CASE WHEN trigger_function.oid IS NOT NULL
      AND (pg_catalog.pg_get_functiondef(trigger_function.oid) ILIKE '%pg_net%'
        OR pg_catalog.pg_get_functiondef(trigger_function.oid) ILIKE '%net.http%')
      THEN 'pg_net/HTTP extension reference' END,
    CASE WHEN trigger_function.oid IS NOT NULL
      AND pg_catalog.pg_get_functiondef(trigger_function.oid) ILIKE '%dblink%'
      THEN 'dblink reference' END,
    CASE WHEN trigger_function.oid IS NOT NULL
      AND (pg_catalog.pg_get_functiondef(trigger_function.oid) ILIKE '%pg_notify%'
        OR pg_catalog.pg_get_functiondef(trigger_function.oid) ~* '(^|[^a-z])notify([^a-z]|$)')
      THEN 'notification reference' END,
    CASE WHEN trigger_function.oid IS NOT NULL
      AND pg_catalog.pg_get_functiondef(trigger_function.oid) ILIKE '%webhook%'
      THEN 'webhook reference' END,
    CASE WHEN trigger_function.oid IS NOT NULL
      AND (pg_catalog.pg_get_functiondef(trigger_function.oid) ILIKE '%dynamically%'
        OR pg_catalog.pg_get_functiondef(trigger_function.oid) ILIKE '%EXECUTE %')
      THEN 'dynamic execution text; inspect manually' END
  ]::text[], NULL) AS possible_external_or_dynamic_effects
FROM calendar_tables
LEFT JOIN pg_catalog.pg_class AS relation
  ON relation.relnamespace = 'public'::regnamespace
 AND relation.relname = calendar_tables.table_name
 AND relation.relkind IN ('r', 'p')
LEFT JOIN pg_catalog.pg_trigger AS trigger_row
  ON trigger_row.tgrelid = relation.oid
LEFT JOIN pg_catalog.pg_proc AS trigger_function
  ON trigger_function.oid = trigger_row.tgfoid
LEFT JOIN pg_catalog.pg_roles AS trigger_owner
  ON trigger_owner.oid = trigger_function.proowner
LEFT JOIN pg_catalog.pg_language AS trigger_language
  ON trigger_language.oid = trigger_function.prolang
ORDER BY calendar_tables.table_name, trigger_row.tgname;

-- 3. Installed extensions that can provide network, remote database or file effects.
SELECT
  extension.extname AS extension_name,
  extension.extversion AS extension_version,
  namespace.nspname AS extension_schema,
  owner_role.rolname AS extension_owner
FROM pg_catalog.pg_extension AS extension
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = extension.extnamespace
JOIN pg_catalog.pg_roles AS owner_role
  ON owner_role.oid = extension.extowner
WHERE extension.extname IN (
  'pg_net',
  'http',
  'dblink',
  'aws_s3',
  'supabase_vault'
)
ORDER BY extension.extname;
