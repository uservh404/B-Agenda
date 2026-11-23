-- NO EJECUTAR: propuesta para revisión de AgendaJuventud ORIGINAL.
-- Protege PostgREST, lecturas Realtime y las cuatro RPC de verificación.
-- La Edge Function local ya propaga account_suspended; confirmar por separado
-- que la versión desplegada tenga el mismo manejo antes de instalar.

BEGIN;

DO $suspension_install_preflight$
DECLARE
  v_signature regprocedure;
BEGIN
  IF current_user <> 'postgres'
     OR current_database() <> 'postgres'
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.profile_settings_verification_challenges') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid = 'auth.users'::regclass
         AND attname = 'banned_until'
         AND atttypid = 'timestamp with time zone'::regtype
         AND NOT attisdropped
     )
     OR NOT pg_catalog.has_table_privilege('postgres', 'auth.users', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('postgres', 'auth.users', 'UPDATE')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticator')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION
      'Preflight failed: expected ORIGINAL postgres database, Auth privileges/column, profile table, or API roles are missing.';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = ANY (ARRAY[
        'event_sync_changes',
        'resource_change_signals',
        'announcement_change_signals',
        'notification_change_signals'
      ])
      AND relation.relrowsecurity
  ) <> 4 OR (
    SELECT count(*)
    FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'event_sync_changes',
        'resource_change_signals',
        'announcement_change_signals',
        'notification_change_signals'
      ])
  ) <> 4 THEN
    RAISE EXCEPTION
      'Preflight failed: the four confirmed Realtime tables or their RLS/publication state changed.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND policyname = ANY (ARRAY[
        'account_active_event_sync_select',
        'account_active_resource_signal_select',
        'account_active_announcement_signal_select',
        'account_active_notification_signal_select'
      ])
  ) OR pg_catalog.to_regprocedure('public.agenda_account_is_active_v1()') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.agenda_assert_user_active_v1(uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.agenda_account_suspension_pre_request_v1()') IS NOT NULL THEN
    RAISE EXCEPTION
      'Preflight failed: a proposed policy or helper already exists; inspect it rather than replacing it.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting AS setting
    CROSS JOIN LATERAL unnest(setting.setconfig) AS config(value)
    WHERE config.value ILIKE 'pgrst.db_pre_request=%'
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: a pgrst.db_pre_request setting now exists; preserve and review it before proceeding.';
  END IF;

  FOR v_signature IN
    SELECT signature::regprocedure
    FROM (VALUES
      ('public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'),
      ('public.activate_profile_settings_verification_v1(uuid,uuid)'),
      ('public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'),
      ('public.cancel_profile_settings_verification_v1(uuid,uuid)'),
      ('public.issue_profile_settings_verification_v1(uuid,uuid,text,text)'),
      ('public.list_assignable_event_users()')
    ) AS signatures(signature)
  LOOP
    IF v_signature IS NULL THEN
      RAISE EXCEPTION 'Preflight failed: a canonical ORIGINAL function is missing.';
    END IF;
  END LOOP;

  IF pg_catalog.md5(pg_catalog.pg_get_functiondef(
       'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'::regprocedure
     )) <> '2ee0e5e7128dd6ff1e7d070fac5915f2'
     OR pg_catalog.md5(pg_catalog.pg_get_functiondef(
       'public.activate_profile_settings_verification_v1(uuid,uuid)'::regprocedure
     )) <> '902390e89f10cd3cacaa69e0cf5b45c4'
     OR pg_catalog.md5(pg_catalog.pg_get_functiondef(
       'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'::regprocedure
     )) <> '0a79fd156aad17df0e0082b4b3b663bc'
     OR pg_catalog.md5(pg_catalog.pg_get_functiondef(
       'public.cancel_profile_settings_verification_v1(uuid,uuid)'::regprocedure
     )) <> 'cf75b889ff3c1eee0234dfe413d5c05f'
     OR pg_catalog.md5(pg_catalog.pg_get_functiondef(
       'public.issue_profile_settings_verification_v1(uuid,uuid,text,text)'::regprocedure
     )) <> '2d78f67ffd7f8e6e535e1cb636d8d5a6'
     OR pg_catalog.md5(pg_catalog.pg_get_functiondef(
       'public.list_assignable_event_users()'::regprocedure
     )) <> '78915a3d6d1159e2036dd0449171f153' THEN
    RAISE EXCEPTION
      'Preflight failed: one or more canonical function definitions differ from CSV (10)/(11).';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS rpc
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = rpc.pronamespace
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = rpc.proowner
    WHERE namespace.nspname = 'public'
      AND rpc.oid IN (
        'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'::regprocedure,
        'public.activate_profile_settings_verification_v1(uuid,uuid)'::regprocedure,
        'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'::regprocedure,
        'public.cancel_profile_settings_verification_v1(uuid,uuid)'::regprocedure
      )
      AND (
        NOT rpc.prosecdef
        OR owner_role.rolname IN ('anon', 'authenticated')
        OR NOT pg_catalog.pg_has_role(
          current_user, rpc.proowner, 'USAGE'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: a verification RPC is not SECURITY DEFINER or is owned by an API caller role.';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.activate_profile_settings_verification_v1(uuid,uuid)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.cancel_profile_settings_verification_v1(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.activate_profile_settings_verification_v1(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.cancel_profile_settings_verification_v1(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'Preflight failed: profile verification RPC privileges differ from the confirmed production grants.';
  END IF;
END;
$suspension_install_preflight$;

CREATE FUNCTION public.agenda_account_is_active_v1()
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN auth_user.id IS NULL THEN NULL::boolean
    ELSE auth_user.banned_until IS NULL
      OR auth_user.banned_until <= pg_catalog.clock_timestamp()
  END
  FROM (SELECT auth.uid() AS user_id) AS request_user
  LEFT JOIN auth.users AS auth_user
    ON auth_user.id = request_user.user_id;
$function$;

ALTER FUNCTION public.agenda_account_is_active_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.agenda_account_is_active_v1()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.agenda_account_is_active_v1() TO authenticated;

CREATE FUNCTION public.agenda_assert_user_active_v1(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_banned_until timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  SELECT auth_user.banned_until
  INTO v_banned_until
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  IF v_banned_until IS NOT NULL
     AND v_banned_until > pg_catalog.clock_timestamp() THEN
    RAISE SQLSTATE 'PGRST'
      USING MESSAGE = '{"code":"account_suspended","message":"Account suspended"}',
            DETAIL = '{"status":403,"headers":{}}';
  END IF;
END;
$function$;

ALTER FUNCTION public.agenda_assert_user_active_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.agenda_assert_user_active_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $suspension_rpc_owner_grants$
DECLARE
  r record;
  v_helper regprocedure := 'public.agenda_assert_user_active_v1(uuid)'::regprocedure;
BEGIN
  FOR r IN
    SELECT DISTINCT owner_role.oid AS owner_oid, owner_role.rolname
    FROM pg_catalog.pg_proc AS rpc
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = rpc.proowner
    WHERE rpc.oid IN (
      'public.reserve_profile_settings_verification_v1(uuid,uuid,text,text)'::regprocedure,
      'public.activate_profile_settings_verification_v1(uuid,uuid)'::regprocedure,
      'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'::regprocedure,
      'public.cancel_profile_settings_verification_v1(uuid,uuid)'::regprocedure
    )
  LOOP
    IF r.rolname IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION
        'Installation aborted: granting the suspension helper to API role % would expose it directly.',
        r.rolname;
    END IF;

    IF NOT pg_catalog.has_function_privilege(r.owner_oid, v_helper, 'EXECUTE') THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.agenda_assert_user_active_v1(uuid) TO %I',
        r.rolname
      );
    END IF;

    IF NOT pg_catalog.has_function_privilege(r.owner_oid, v_helper, 'EXECUTE') THEN
      RAISE EXCEPTION
        'Installation aborted: RPC owner % cannot execute the suspension helper.',
        r.rolname;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege('anon', v_helper, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_helper, 'EXECUTE') THEN
    RAISE EXCEPTION
      'Installation aborted: the suspension helper is executable by an API caller role.';
  END IF;
END;
$suspension_rpc_owner_grants$;

CREATE FUNCTION public.agenda_account_suspension_pre_request_v1()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_is_active boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RETURN;
  END IF;

  IF pg_catalog.current_setting('transaction_read_only') = 'off' THEN
    PERFORM public.agenda_assert_user_active_v1(auth.uid());
    RETURN;
  END IF;

  v_is_active := public.agenda_account_is_active_v1();
  IF v_is_active IS TRUE THEN
    RETURN;
  END IF;

  IF v_is_active IS FALSE THEN
    RAISE SQLSTATE 'PGRST'
      USING MESSAGE = '{"code":"account_suspended","message":"Account suspended"}',
            DETAIL = '{"status":403,"headers":{}}';
  END IF;

  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
END;
$function$;

ALTER FUNCTION public.agenda_account_suspension_pre_request_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.agenda_account_suspension_pre_request_v1()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agenda_account_suspension_pre_request_v1()
  TO anon, authenticated, service_role;

CREATE POLICY account_active_event_sync_select
  ON public.event_sync_changes
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (public.agenda_account_is_active_v1() IS TRUE);

CREATE POLICY account_active_resource_signal_select
  ON public.resource_change_signals
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (public.agenda_account_is_active_v1() IS TRUE);

CREATE POLICY account_active_announcement_signal_select
  ON public.announcement_change_signals
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (public.agenda_account_is_active_v1() IS TRUE);

CREATE POLICY account_active_notification_signal_select
  ON public.notification_change_signals
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (public.agenda_account_is_active_v1() IS TRUE);

-- These SELECT policies restrict row visibility; they do not close Realtime
-- sockets and PostgreSQL DELETE change events are not filtered by RLS.

DO $suspension_rpc_guard_install$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_new_definition text;
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
    v_expected_md5 := r.expected_md5;
    v_needle := r.needle;
    v_replacement := r.replacement;
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    v_occurrences := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, ''))
    ) / pg_catalog.length(v_needle);

    IF pg_catalog.md5(v_definition) <> v_expected_md5 OR v_occurrences <> 1 THEN
      RAISE EXCEPTION 'RPC guard insertion aborted for %: canonical body/marker changed.', r.signature;
    END IF;

    v_new_definition := pg_catalog.replace(v_definition, v_needle, v_replacement);
    SELECT rpc.proowner, rpc.proacl::text
    INTO v_owner_oid, v_acl
    FROM pg_catalog.pg_proc AS rpc
    WHERE rpc.oid = v_signature;

    EXECUTE v_new_definition;

    SELECT rpc.proowner, rpc.proacl::text
    INTO v_owner_after, v_acl_after
    FROM pg_catalog.pg_proc AS rpc
    WHERE rpc.oid = v_signature;

    IF v_owner_after IS DISTINCT FROM v_owner_oid
       OR v_acl_after IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION
        'RPC owner or grants changed unexpectedly while installing guard for %.',
        r.signature;
    END IF;

    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    IF position(
         'agenda_assert_user_active_v1(p_user_id)' IN v_definition
       ) = 0
       OR position('p_user_id IS NULL' IN v_definition) = 0 THEN
      RAISE EXCEPTION
        'Postcondition failed: suspension guard or null-ID rejection missing from %.',
        r.signature;
    END IF;
  END LOOP;
END;
$suspension_rpc_guard_install$;

ALTER ROLE authenticator IN DATABASE postgres
  SET pgrst.db_pre_request = 'public.agenda_account_suspension_pre_request_v1';

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

COMMIT;
