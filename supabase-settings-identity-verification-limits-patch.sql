BEGIN;

DO $settings_verification_limits_preflight$
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.profile_settings_verification_challenges') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.issue_profile_settings_verification_v1(uuid,uuid,text,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.verify_and_apply_profile_settings_v1(uuid,uuid,text,text,text,text,boolean,boolean)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.cancel_profile_settings_verification_v1(uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Run as postgres after applying the identity-verification patch and confirming its table and RPCs exist.';
  END IF;
END;
$settings_verification_limits_preflight$;

ALTER TABLE public.profile_settings_verification_challenges
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'sent';

ALTER TABLE public.profile_settings_verification_challenges
  DROP CONSTRAINT IF EXISTS profile_settings_verification_challenges_attempts_check,
  DROP CONSTRAINT IF EXISTS profile_settings_verification_challenges_attempts_0_6_check,
  ADD CONSTRAINT profile_settings_verification_challenges_attempts_0_6_check
    CHECK (attempts BETWEEN 0 AND 6) NOT VALID,
  DROP CONSTRAINT IF EXISTS profile_settings_verification_challenges_delivery_status_check,
  ADD CONSTRAINT profile_settings_verification_challenges_delivery_status_check
    CHECK (delivery_status IN ('pending', 'sent', 'failed')) NOT VALID;

ALTER TABLE public.profile_settings_verification_challenges
  VALIDATE CONSTRAINT profile_settings_verification_challenges_attempts_0_6_check;
ALTER TABLE public.profile_settings_verification_challenges
  VALIDATE CONSTRAINT profile_settings_verification_challenges_delivery_status_check;

CREATE INDEX IF NOT EXISTS profile_settings_challenges_pending_user_idx
  ON public.profile_settings_verification_challenges (user_id, expires_at)
  WHERE delivery_status = 'pending' AND invalidated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profile_settings_challenges_one_pending_per_user_idx
  ON public.profile_settings_verification_challenges (user_id)
  WHERE delivery_status = 'pending' AND invalidated_at IS NULL;

CREATE OR REPLACE FUNCTION public.reserve_profile_settings_verification_v1(
  p_challenge_id uuid,
  p_user_id uuid,
  p_operation_digest text,
  p_code_digest text
)
RETURNS TABLE (
  status text,
  challenge_id uuid,
  expires_at timestamptz,
  retry_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz;
  v_expires_at timestamptz;
  v_retry_at timestamptz;
  v_pending_expires_at timestamptz;
  v_oldest_created_at timestamptz;
  v_last_created_at timestamptz;
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
  v_now := pg_catalog.clock_timestamp();

  UPDATE public.profile_settings_verification_challenges AS challenge
  SET
    delivery_status = 'failed',
    invalidated_at = v_now
  WHERE challenge.user_id = p_user_id
    AND challenge.delivery_status = 'pending'
    AND challenge.invalidated_at IS NULL
    AND challenge.expires_at <= v_now;

  SELECT challenge.expires_at
  INTO v_pending_expires_at
  FROM public.profile_settings_verification_challenges AS challenge
  WHERE challenge.user_id = p_user_id
    AND challenge.delivery_status = 'pending'
    AND challenge.invalidated_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT 'cooldown'::text, NULL::uuid, NULL::timestamptz, v_pending_expires_at;
    RETURN;
  END IF;

  SELECT
    count(*),
    min(challenge.created_at),
    max(challenge.created_at)
  INTO
    v_recent_count,
    v_oldest_created_at,
    v_last_created_at
  FROM public.profile_settings_verification_challenges AS challenge
  WHERE challenge.user_id = p_user_id
    AND challenge.delivery_status = 'sent'
    AND challenge.created_at > v_now - interval '60 minutes';

  IF v_recent_count >= 8 THEN
    v_retry_at := GREATEST(
      v_oldest_created_at + interval '60 minutes',
      v_last_created_at + interval '60 seconds'
    );
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::timestamptz, v_retry_at;
    RETURN;
  END IF;

  IF v_last_created_at > v_now - interval '60 seconds' THEN
    v_retry_at := v_last_created_at + interval '60 seconds';
    RETURN QUERY SELECT 'cooldown'::text, NULL::uuid, NULL::timestamptz, v_retry_at;
    RETURN;
  END IF;

  v_expires_at := v_now + interval '60 seconds';

  INSERT INTO public.profile_settings_verification_challenges (
    id,
    user_id,
    operation_digest,
    code_digest,
    attempts,
    created_at,
    expires_at,
    delivery_status
  )
  VALUES (
    p_challenge_id,
    p_user_id,
    p_operation_digest,
    p_code_digest,
    0,
    v_now,
    v_expires_at,
    'pending'
  );

  RETURN QUERY SELECT 'reserved'::text, p_challenge_id, v_expires_at, NULL::timestamptz;
END;
$function$;

CREATE OR REPLACE FUNCTION public.activate_profile_settings_verification_v1(
  p_challenge_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  status text,
  challenge_id uuid,
  expires_at timestamptz,
  resend_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_challenge public.profile_settings_verification_challenges%ROWTYPE;
  v_now timestamptz;
  v_expires_at timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  IF p_challenge_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_challenge_request';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_user_id::text));
  v_now := pg_catalog.clock_timestamp();

  SELECT challenge.*
  INTO v_challenge
  FROM public.profile_settings_verification_challenges AS challenge
  WHERE challenge.id = p_challenge_id
    AND challenge.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_challenge'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_challenge.delivery_status = 'sent' AND v_challenge.invalidated_at IS NULL THEN
    RETURN QUERY
      SELECT 'issued'::text, v_challenge.id, v_challenge.expires_at,
        v_challenge.created_at + interval '60 seconds';
    RETURN;
  END IF;

  IF v_challenge.delivery_status <> 'pending'
     OR v_challenge.invalidated_at IS NOT NULL
     OR v_challenge.expires_at <= v_now THEN
    UPDATE public.profile_settings_verification_challenges AS challenge
    SET
      delivery_status = CASE WHEN challenge.delivery_status = 'pending' THEN 'failed' ELSE challenge.delivery_status END,
      invalidated_at = COALESCE(challenge.invalidated_at, v_now)
    WHERE challenge.id = p_challenge_id;
    RETURN QUERY SELECT 'invalid_challenge'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE public.profile_settings_verification_challenges AS challenge
  SET invalidated_at = v_now
  WHERE challenge.user_id = p_user_id
    AND challenge.id <> p_challenge_id
    AND challenge.delivery_status = 'sent'
    AND challenge.consumed_at IS NULL
    AND challenge.invalidated_at IS NULL;

  v_expires_at := v_now + interval '5 minutes';

  UPDATE public.profile_settings_verification_challenges AS challenge
  SET
    delivery_status = 'sent',
    created_at = v_now,
    expires_at = v_expires_at
  WHERE challenge.id = p_challenge_id;

  RETURN QUERY
    SELECT 'issued'::text, p_challenge_id, v_expires_at, v_now + interval '60 seconds';
END;
$function$;

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
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  RETURN QUERY SELECT 'two_phase_required'::text, NULL::uuid, NULL::timestamptz;
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

  IF v_challenge.delivery_status <> 'sent' OR v_challenge.invalidated_at IS NOT NULL THEN
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

  IF v_challenge.attempts >= 6 THEN
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
      invalidated_at = CASE WHEN v_attempts >= 6 THEN now() ELSE NULL END
    WHERE challenge.id = p_challenge_id;

    IF v_attempts >= 6 THEN
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
  SET
    delivery_status = CASE WHEN challenge.delivery_status = 'pending' THEN 'failed' ELSE challenge.delivery_status END,
    invalidated_at = pg_catalog.clock_timestamp()
  WHERE challenge.id = p_challenge_id
    AND challenge.user_id = p_user_id
    AND challenge.consumed_at IS NULL
    AND challenge.invalidated_at IS NULL;

  RETURN FOUND;
END;
$function$;

ALTER FUNCTION public.reserve_profile_settings_verification_v1(uuid, uuid, text, text)
  OWNER TO postgres;
ALTER FUNCTION public.activate_profile_settings_verification_v1(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  OWNER TO postgres;
ALTER FUNCTION public.verify_and_apply_profile_settings_v1(uuid, uuid, text, text, text, text, boolean, boolean)
  OWNER TO postgres;
ALTER FUNCTION public.cancel_profile_settings_verification_v1(uuid, uuid)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.reserve_profile_settings_verification_v1(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_profile_settings_verification_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_and_apply_profile_settings_v1(uuid, uuid, text, text, text, text, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_profile_settings_verification_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_profile_settings_verification_v1(uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_profile_settings_verification_v1(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_and_apply_profile_settings_v1(uuid, uuid, text, text, text, text, boolean, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_profile_settings_verification_v1(uuid, uuid)
  TO service_role;

COMMIT;
