BEGIN;

DO $settings_identity_preflight$
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.profiles') IS NULL
     OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid = pg_catalog.to_regclass('public.profiles')
         AND attname = 'id'
         AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid = pg_catalog.to_regclass('public.profiles')
         AND attname = 'full_name'
         AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute
       WHERE attrelid = pg_catalog.to_regclass('public.profiles')
         AND attname = 'phone'
         AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION
      'Run as postgres after confirming public.profiles(id, full_name, phone), auth.uid(), and auth.role() exist.';
  END IF;
END;
$settings_identity_preflight$;

REVOKE UPDATE ON TABLE public.profiles
  FROM PUBLIC, anon, authenticated;

DO $settings_identity_revoke_column_updates$
DECLARE
  v_column_name text;
BEGIN
  FOR v_column_name IN
    SELECT attribute.attname
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.profiles'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE (%I) ON TABLE public.profiles FROM PUBLIC, anon, authenticated',
      v_column_name
    );
  END LOOP;
END;
$settings_identity_revoke_column_updates$;

DO $settings_identity_revoke_old_rpc$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.update_own_profile_settings_v1(text,text,boolean)'
  ) IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.update_own_profile_settings_v1(text, text, boolean)
      FROM PUBLIC, anon, authenticated, service_role;
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.update_own_profile_settings_v1(text,text)'
  ) IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.update_own_profile_settings_v1(text, text)
      FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END;
$settings_identity_revoke_old_rpc$;

CREATE TABLE IF NOT EXISTS public.profile_settings_verification_challenges (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_digest text NOT NULL CHECK (operation_digest ~ '^[0-9a-f]{64}$'),
  code_digest text NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz
);

CREATE INDEX IF NOT EXISTS profile_settings_challenges_user_created_idx
  ON public.profile_settings_verification_challenges (user_id, created_at DESC);

ALTER TABLE public.profile_settings_verification_challenges
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.profile_settings_verification_challenges
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.issue_profile_settings_verification_v1(
  p_challenge_id uuid,
  p_user_id uuid,
  p_operation_digest text,
  p_code_digest text
)
RETURNS TABLE (
  status text,
  challenge_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_challenge_id uuid;
  v_expires_at timestamptz;
  v_recent_count bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  IF p_challenge_id IS NULL
     OR p_user_id IS NULL
     OR p_operation_digest IS NULL
     OR p_code_digest IS NULL
     OR p_operation_digest !~ '^[0-9a-f]{64}$'
     OR p_code_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_challenge_request';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));

  SELECT count(*)
  INTO v_recent_count
  FROM public.profile_settings_verification_challenges AS challenge
  WHERE challenge.user_id = p_user_id
    AND challenge.created_at > now() - interval '1 hour';

  IF v_recent_count >= 3 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.profile_settings_verification_challenges AS challenge
  SET invalidated_at = now()
  WHERE challenge.user_id = p_user_id
    AND challenge.consumed_at IS NULL
    AND challenge.invalidated_at IS NULL;

  v_expires_at := now() + interval '10 minutes';

  INSERT INTO public.profile_settings_verification_challenges (
    id,
    user_id,
    operation_digest,
    code_digest,
    expires_at
  )
  VALUES (
    p_challenge_id,
    p_user_id,
    p_operation_digest,
    p_code_digest,
    v_expires_at
  )
  RETURNING id INTO v_challenge_id;

  RETURN QUERY SELECT 'issued'::text, v_challenge_id, v_expires_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_and_apply_profile_settings_v1(
  p_challenge_id uuid,
  p_user_id uuid,
  p_operation_digest text,
  p_code_digest text,
  p_full_name text,
  p_phone text,
  p_update_phone boolean,
  p_update_profile boolean
)
RETURNS TABLE (
  status text,
  full_name text,
  phone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_challenge public.profile_settings_verification_challenges%ROWTYPE;
  v_attempts smallint;
  v_full_name text := pg_catalog.regexp_replace(
    pg_catalog.btrim(COALESCE(p_full_name, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  v_phone text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  SELECT challenge.*
  INTO v_challenge
  FROM public.profile_settings_verification_challenges AS challenge
  WHERE challenge.id = p_challenge_id
    AND challenge.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_challenge'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_challenge.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_used'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_challenge.invalidated_at IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid_challenge'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_challenge.expires_at <= now() THEN
    UPDATE public.profile_settings_verification_challenges
    SET invalidated_at = now()
    WHERE id = p_challenge_id;
    RETURN QUERY SELECT 'expired'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_challenge.attempts >= 5 THEN
    UPDATE public.profile_settings_verification_challenges
    SET invalidated_at = now()
    WHERE id = p_challenge_id;
    RETURN QUERY SELECT 'too_many_attempts'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF p_operation_digest IS DISTINCT FROM v_challenge.operation_digest
     OR p_code_digest IS DISTINCT FROM v_challenge.code_digest THEN
    v_attempts := v_challenge.attempts + 1;
    UPDATE public.profile_settings_verification_challenges AS challenge
    SET
      attempts = v_attempts,
      invalidated_at = CASE WHEN v_attempts >= 5 THEN now() ELSE NULL END
    WHERE challenge.id = p_challenge_id;

    IF v_attempts >= 5 THEN
      RETURN QUERY SELECT 'too_many_attempts'::text, NULL::text, NULL::text;
    ELSE
      RETURN QUERY SELECT 'incorrect_code'::text, NULL::text, NULL::text;
    END IF;
    RETURN;
  END IF;

  IF p_update_phone IS NULL OR p_update_profile IS NULL
     OR (NOT p_update_profile AND p_update_phone) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_profile_update';
  END IF;

  IF p_update_profile THEN
    IF pg_catalog.char_length(v_full_name) < 2
       OR pg_catalog.char_length(v_full_name) > 100
       OR v_full_name !~ '^[[:alpha:]][[:alpha:] .''-]*$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'invalid_full_name';
    END IF;

    IF p_update_phone
       AND p_phone IS NOT NULL
       AND p_phone !~ '^\+52[0-9]{10}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'invalid_mexican_phone';
    END IF;
  END IF;

  UPDATE public.profile_settings_verification_challenges AS challenge
  SET consumed_at = now()
  WHERE challenge.id = p_challenge_id;

  IF p_update_profile THEN
    UPDATE public.profiles AS profile
    SET
      full_name = v_full_name,
      phone = CASE WHEN p_update_phone THEN p_phone ELSE profile.phone END
    WHERE profile.id = p_user_id
    RETURNING profile.full_name::text, profile.phone::text
    INTO v_full_name, v_phone;
  ELSE
    SELECT profile.full_name::text, profile.phone::text
    INTO v_full_name, v_phone
    FROM public.profiles AS profile
    WHERE profile.id = p_user_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'profile_not_found';
  END IF;

  RETURN QUERY SELECT 'verified'::text, v_full_name, v_phone;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_profile_settings_verification_v1(
  p_challenge_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  UPDATE public.profile_settings_verification_challenges AS challenge
  SET invalidated_at = now()
  WHERE challenge.id = p_challenge_id
    AND challenge.user_id = p_user_id
    AND challenge.consumed_at IS NULL
    AND challenge.invalidated_at IS NULL;

  RETURN FOUND;
END;
$function$;

ALTER FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  OWNER TO postgres;
ALTER FUNCTION public.verify_and_apply_profile_settings_v1(uuid, uuid, text, text, text, text, boolean, boolean)
  OWNER TO postgres;
ALTER FUNCTION public.cancel_profile_settings_verification_v1(uuid, uuid)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_and_apply_profile_settings_v1(uuid, uuid, text, text, text, text, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_profile_settings_verification_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_and_apply_profile_settings_v1(uuid, uuid, text, text, text, text, boolean, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_profile_settings_verification_v1(uuid, uuid)
  TO service_role;

COMMIT;
