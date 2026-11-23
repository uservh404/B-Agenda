-- NO EJECUTAR: reversión específica de supabase-account-suspension-install.sql.
-- No usa CASCADE, no elimina datos y no reemplaza políticas preexistentes.
-- CREATE OR REPLACE conserva propietario y ACL de las cuatro RPC; se verifican
-- antes y después de restaurar sus definiciones canónicas.

BEGIN;

DO $suspension_rollback_preflight$
DECLARE
  v_config_count integer;
  v_policy_count integer;
  r record;
  v_signature regprocedure;
  v_helper oid;
  v_definition text;
  v_restored_definition text;
  v_needle text;
  v_replacement text;
  v_expected_md5 text;
  v_occurrences integer;
BEGIN
  IF current_user <> 'postgres'
     OR current_database() <> 'postgres'
     OR pg_catalog.to_regprocedure('public.agenda_account_is_active_v1()') IS NULL
     OR pg_catalog.to_regprocedure('public.agenda_assert_user_active_v1(uuid)') IS NULL
     OR pg_catalog.to_regprocedure('public.agenda_account_suspension_pre_request_v1()') IS NULL THEN
    RAISE EXCEPTION
      'Rollback preflight failed: expected the installed suspension objects in the ORIGINAL postgres database.';
  END IF;

  v_helper := pg_catalog.to_regprocedure(
    'public.agenda_assert_user_active_v1(uuid)'
  )::oid;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS rpc
    WHERE rpc.oid IN (
      'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'::regprocedure,
      'public.activate_profile_settings_verification_v1(uuid,uuid)'::regprocedure,
      'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'::regprocedure,
      'public.cancel_profile_settings_verification_v1(uuid,uuid)'::regprocedure
    )
      AND NOT pg_catalog.pg_has_role(
        current_user, rpc.proowner, 'USAGE'
      )
  ) THEN
    RAISE EXCEPTION
      'Rollback preflight failed: current role cannot replace one or more RPC definitions.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS helper
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = helper.pronamespace
    WHERE namespace.nspname = 'public'
      AND helper.oid IN (
        'public.agenda_account_is_active_v1()'::regprocedure,
        'public.agenda_assert_user_active_v1(uuid)'::regprocedure,
        'public.agenda_account_suspension_pre_request_v1()'::regprocedure
      )
      AND (
        helper.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres')
        OR NOT helper.prosecdef
        OR helper.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
      )
  ) OR position(
       'auth.uid()' IN pg_catalog.pg_get_functiondef(
         'public.agenda_account_is_active_v1()'::regprocedure
       )
     ) = 0
    OR position(
       'FOR SHARE' IN pg_catalog.pg_get_functiondef(v_helper)
     ) = 0
    OR position(
       'account_suspended' IN pg_catalog.pg_get_functiondef(v_helper)
     ) = 0
    OR position(
       'auth.role()' IN pg_catalog.pg_get_functiondef(
         'public.agenda_account_suspension_pre_request_v1()'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION
      'Rollback preflight failed: a helper owner, security setting, or definition changed after installation.';
  END IF;

  IF EXISTS (
    WITH expected(signature, kind) AS (
      VALUES
        ('public.agenda_account_is_active_v1()', 'active'),
        ('public.agenda_assert_user_active_v1(uuid)', 'assert'),
        ('public.agenda_account_suspension_pre_request_v1()', 'hook')
    )
    SELECT 1
    FROM expected
    JOIN pg_catalog.pg_proc AS helper
      ON helper.oid = pg_catalog.to_regprocedure(expected.signature)::oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
      helper.proacl,
      pg_catalog.acldefault('f', helper.proowner)
    )) AS acl
    WHERE acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> helper.proowner
      AND NOT (
        (
          expected.kind = 'active'
          AND acl.grantee = (
            SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
          )
        )
        OR (
          expected.kind = 'assert'
          AND acl.grantee IN (
            SELECT rpc.proowner
            FROM pg_catalog.pg_proc AS rpc
            WHERE rpc.oid IN (
              'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'::regprocedure,
              'public.activate_profile_settings_verification_v1(uuid,uuid)'::regprocedure,
              'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'::regprocedure,
              'public.cancel_profile_settings_verification_v1(uuid,uuid)'::regprocedure
            )
          )
        )
        OR (
          expected.kind = 'hook'
          AND acl.grantee IN (
            SELECT oid FROM pg_catalog.pg_roles
            WHERE rolname IN ('anon', 'authenticated', 'service_role')
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Rollback preflight failed: a helper has an unexpected direct EXECUTE grant.';
  END IF;

  SELECT count(*)
  INTO v_config_count
  FROM pg_catalog.pg_db_role_setting AS role_setting
  JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = role_setting.setrole
  JOIN pg_catalog.pg_database AS database_row ON database_row.oid = role_setting.setdatabase
  CROSS JOIN LATERAL unnest(role_setting.setconfig) AS setting(config)
  WHERE role_row.rolname = 'authenticator'
    AND database_row.datname = 'postgres'
    AND setting.config = 'pgrst.db_pre_request=public.agenda_account_suspension_pre_request_v1';

  IF v_config_count <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS role_setting
    CROSS JOIN LATERAL unnest(role_setting.setconfig) AS setting(config)
    WHERE setting.config ILIKE 'pgrst.db_pre_request=%'
      AND NOT (
        role_setting.setrole = (
          SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticator'
        )
        AND role_setting.setdatabase = (
          SELECT oid FROM pg_catalog.pg_database WHERE datname = 'postgres'
        )
        AND setting.config = 'pgrst.db_pre_request=public.agenda_account_suspension_pre_request_v1'
      )
  ) THEN
    RAISE EXCEPTION
      'Rollback preflight failed: PostgREST setting changed or another scope now has a hook; preserve it and review manually.';
  END IF;

  IF pg_catalog.has_function_privilege('anon', v_helper, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_helper, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS helper
       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
         helper.proacl,
         pg_catalog.acldefault('f', helper.proowner)
       )) AS acl
       WHERE helper.oid = v_helper
         AND acl.privilege_type = 'EXECUTE'
         AND acl.grantee <> helper.proowner
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_proc AS rpc
           WHERE rpc.oid IN (
             'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'::regprocedure,
             'public.activate_profile_settings_verification_v1(uuid,uuid)'::regprocedure,
             'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'::regprocedure,
             'public.cancel_profile_settings_verification_v1(uuid,uuid)'::regprocedure
           )
             AND rpc.proowner = acl.grantee
         )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS rpc
       JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = rpc.proowner
       WHERE rpc.oid IN (
         'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'::regprocedure,
         'public.activate_profile_settings_verification_v1(uuid,uuid)'::regprocedure,
         'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'::regprocedure,
         'public.cancel_profile_settings_verification_v1(uuid,uuid)'::regprocedure
       )
         AND (
           owner_role.rolname IN ('anon', 'authenticated')
           OR NOT pg_catalog.has_function_privilege(
             rpc.proowner, v_helper, 'EXECUTE'
           )
         )
     ) THEN
    RAISE EXCEPTION
      'Rollback preflight failed: helper access no longer matches the installed RPC-owner grants.';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'authenticated',
       'public.agenda_account_is_active_v1()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.agenda_account_is_active_v1()',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'anon',
       'public.agenda_account_suspension_pre_request_v1()',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'authenticated',
       'public.agenda_account_suspension_pre_request_v1()',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.agenda_account_suspension_pre_request_v1()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'Rollback preflight failed: a helper privilege changed after installation.';
  END IF;

  SELECT count(*)
  INTO v_policy_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND policyname = ANY (ARRAY[
      'account_active_event_sync_select',
      'account_active_resource_signal_select',
      'account_active_announcement_signal_select',
      'account_active_notification_signal_select'
    ]);

  IF v_policy_count <> 4 THEN
    RAISE EXCEPTION
      'Rollback preflight failed: expected exactly the four policies created by the installation script.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('event_sync_changes', 'account_active_event_sync_select'),
      ('resource_change_signals', 'account_active_resource_signal_select'),
      ('announcement_change_signals', 'account_active_announcement_signal_select'),
      ('notification_change_signals', 'account_active_notification_signal_select')
    ) AS expected(tablename, policyname)
    LEFT JOIN pg_catalog.pg_policies AS policy
      ON policy.schemaname = 'public'
     AND policy.tablename = expected.tablename
     AND policy.policyname = expected.policyname
    WHERE policy.policyname IS NULL
       OR policy.permissive <> 'RESTRICTIVE'
       OR policy.cmd <> 'SELECT'
       OR policy.roles <> ARRAY['authenticated']::name[]
       OR COALESCE(position('agenda_account_is_active_v1()' IN policy.qual), 0) = 0
       OR COALESCE(position('IS TRUE' IN policy.qual), 0) = 0
  ) THEN
    RAISE EXCEPTION
      'Rollback preflight failed: a suspension policy was changed after installation.';
  END IF;

  FOR r IN
    SELECT *
    FROM (VALUES
      (
        'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)',
        '2ee0e5e7128dd6ff1e7d070fac5915f2',
        E'  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));',
        E'  PERFORM public.agenda_assert_user_active_v1(p_user_id);\n\n  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));'
      ),
      (
        'public.activate_profile_settings_verification_v1(uuid,uuid)',
        '902390e89f10cd3cacaa69e0cf5b45c4',
        E'  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));',
        E'  PERFORM public.agenda_assert_user_active_v1(p_user_id);\n\n  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));'
      ),
      (
        'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)',
        '0a79fd156aad17df0e0082b4b3b663bc',
        E'  SELECT challenge.*\r\n  INTO v_challenge\r\n  FROM public.profile_settings_verification_challenges AS challenge',
        E'  IF p_challenge_id IS NULL OR p_user_id IS NULL THEN\r\n    RETURN QUERY SELECT ''invalid_challenge''::text, NULL::text, NULL::text;\r\n    RETURN;\r\n  END IF;\r\n\r\n  PERFORM public.agenda_assert_user_active_v1(p_user_id);\r\n\r\n  SELECT challenge.*\r\n  INTO v_challenge\r\n  FROM public.profile_settings_verification_challenges AS challenge'
      ),
      (
        'public.cancel_profile_settings_verification_v1(uuid,uuid)',
        'cf75b889ff3c1eee0234dfe413d5c05f',
        E'  UPDATE public.profile_settings_verification_challenges AS challenge\r\n',
        E'  IF p_challenge_id IS NULL OR p_user_id IS NULL THEN\r\n    RETURN FALSE;\r\n  END IF;\r\n\r\n  PERFORM public.agenda_assert_user_active_v1(p_user_id);\r\n\r\n  UPDATE public.profile_settings_verification_challenges AS challenge\r\n'
      )
    ) AS definitions(signature, expected_md5, needle, replacement)
  LOOP
    v_signature := pg_catalog.to_regprocedure(r.signature);
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    v_needle := r.needle;
    v_replacement := r.replacement;
    v_expected_md5 := r.expected_md5;
    v_occurrences := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_replacement, ''))
    ) / pg_catalog.length(v_replacement);
    v_restored_definition := pg_catalog.replace(v_definition, v_replacement, v_needle);

    IF v_occurrences <> 1 OR pg_catalog.md5(v_restored_definition) <> v_expected_md5 THEN
      RAISE EXCEPTION
        'Rollback preflight failed for %: current RPC contains changes beyond the suspension guard.',
        r.signature;
    END IF;
  END LOOP;
END;
$suspension_rollback_preflight$;

ALTER ROLE authenticator IN DATABASE postgres
  RESET pgrst.db_pre_request;

DROP POLICY account_active_event_sync_select
  ON public.event_sync_changes;
DROP POLICY account_active_resource_signal_select
  ON public.resource_change_signals;
DROP POLICY account_active_announcement_signal_select
  ON public.announcement_change_signals;
DROP POLICY account_active_notification_signal_select
  ON public.notification_change_signals;

DO $suspension_rpc_guard_rollback$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_restored_definition text;
  v_needle text;
  v_replacement text;
  v_expected_md5 text;
  v_occurrences integer;
  v_owner_oid oid;
  v_owner_after oid;
  v_acl text;
  v_acl_after text;
  r record;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      (
        'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)',
        '2ee0e5e7128dd6ff1e7d070fac5915f2',
        E'  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));',
        E'  PERFORM public.agenda_assert_user_active_v1(p_user_id);\n\n  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));'
      ),
      (
        'public.activate_profile_settings_verification_v1(uuid,uuid)',
        '902390e89f10cd3cacaa69e0cf5b45c4',
        E'  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));',
        E'  PERFORM public.agenda_assert_user_active_v1(p_user_id);\n\n  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));'
      ),
      (
        'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)',
        '0a79fd156aad17df0e0082b4b3b663bc',
        E'  SELECT challenge.*\r\n  INTO v_challenge\r\n  FROM public.profile_settings_verification_challenges AS challenge',
        E'  IF p_challenge_id IS NULL OR p_user_id IS NULL THEN\r\n    RETURN QUERY SELECT ''invalid_challenge''::text, NULL::text, NULL::text;\r\n    RETURN;\r\n  END IF;\r\n\r\n  PERFORM public.agenda_assert_user_active_v1(p_user_id);\r\n\r\n  SELECT challenge.*\r\n  INTO v_challenge\r\n  FROM public.profile_settings_verification_challenges AS challenge'
      ),
      (
        'public.cancel_profile_settings_verification_v1(uuid,uuid)',
        'cf75b889ff3c1eee0234dfe413d5c05f',
        E'  UPDATE public.profile_settings_verification_challenges AS challenge\r\n',
        E'  IF p_challenge_id IS NULL OR p_user_id IS NULL THEN\r\n    RETURN FALSE;\r\n  END IF;\r\n\r\n  PERFORM public.agenda_assert_user_active_v1(p_user_id);\r\n\r\n  UPDATE public.profile_settings_verification_challenges AS challenge\r\n'
      )
    ) AS definitions(signature, expected_md5, needle, replacement)
  LOOP
    v_signature := pg_catalog.to_regprocedure(r.signature);
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    v_needle := r.needle;
    v_replacement := r.replacement;
    v_expected_md5 := r.expected_md5;
    v_occurrences := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_replacement, ''))
    ) / pg_catalog.length(v_replacement);
    v_restored_definition := pg_catalog.replace(v_definition, v_replacement, v_needle);

    IF v_occurrences <> 1 OR pg_catalog.md5(v_restored_definition) <> v_expected_md5 THEN
      RAISE EXCEPTION 'RPC rollback aborted for %: canonical restoration check failed.', r.signature;
    END IF;

    SELECT rpc.proowner, rpc.proacl::text
    INTO v_owner_oid, v_acl
    FROM pg_catalog.pg_proc AS rpc
    WHERE rpc.oid = v_signature;

    EXECUTE v_restored_definition;

    SELECT rpc.proowner, rpc.proacl::text
    INTO v_owner_after, v_acl_after
    FROM pg_catalog.pg_proc AS rpc
    WHERE rpc.oid = v_signature;

    IF v_owner_after IS DISTINCT FROM v_owner_oid
     OR v_acl_after IS DISTINCT FROM v_acl
     OR pg_catalog.md5(pg_catalog.pg_get_functiondef(v_signature)) <> v_expected_md5 THEN
    RAISE EXCEPTION
      'RPC rollback postcondition failed for %: definition, owner, or grants changed unexpectedly.',
      r.signature;
    END IF;
  END LOOP;
END;
$suspension_rpc_guard_rollback$;

DROP FUNCTION public.agenda_account_suspension_pre_request_v1();
DROP FUNCTION public.agenda_assert_user_active_v1(uuid);
DROP FUNCTION public.agenda_account_is_active_v1();

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

COMMIT;
