BEGIN;

DO $settings_verification_policy_preflight$
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.profile_settings_verification_challenges') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.issue_profile_settings_verification_v1(uuid,uuid,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Run as postgres after applying the identity-verification patch and confirming the challenge table and issue RPC exist.';
  END IF;
END;
$settings_verification_policy_preflight$;

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
  v_now timestamptz;
  v_expires_at timestamptz;
  v_retry_at timestamptz;
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
    AND challenge.created_at > v_now - interval '1 hour';

  IF v_recent_count >= 3 THEN
    v_retry_at := GREATEST(
      v_oldest_created_at + interval '1 hour',
      v_last_created_at + interval '1 minute'
    );
    -- On a denied request, expires_at carries the first allowed retry timestamp.
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, v_retry_at;
    RETURN;
  END IF;

  IF v_last_created_at > v_now - interval '1 minute' THEN
    v_retry_at := v_last_created_at + interval '1 minute';
    RETURN QUERY SELECT 'cooldown'::text, NULL::uuid, v_retry_at;
    RETURN;
  END IF;

  UPDATE public.profile_settings_verification_challenges AS challenge
  SET invalidated_at = v_now
  WHERE challenge.user_id = p_user_id
    AND challenge.consumed_at IS NULL
    AND challenge.invalidated_at IS NULL;

  v_expires_at := v_now + interval '5 minutes';

  INSERT INTO public.profile_settings_verification_challenges (
    id,
    user_id,
    operation_digest,
    code_digest,
    created_at,
    expires_at
  )
  VALUES (
    p_challenge_id,
    p_user_id,
    p_operation_digest,
    p_code_digest,
    v_now,
    v_expires_at
  )
  RETURNING id INTO v_challenge_id;

  RETURN QUERY SELECT 'issued'::text, v_challenge_id, v_expires_at;
END;
$function$;

ALTER FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_profile_settings_verification_v1(uuid, uuid, text, text)
  TO service_role;

COMMIT;
