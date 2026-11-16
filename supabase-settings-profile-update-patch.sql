BEGIN;

DO $settings_profile_preflight$
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.profiles') IS NULL
     OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
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
      'Run as postgres after confirming public.profiles(id, full_name, phone) and auth.uid() exist.';
  END IF;
END;
$settings_profile_preflight$;

CREATE OR REPLACE FUNCTION public.update_own_profile_settings_v1(
  p_full_name text,
  p_phone text,
  p_update_phone boolean
)
RETURNS TABLE (
  full_name text,
  phone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_full_name text := pg_catalog.regexp_replace(
    pg_catalog.btrim(COALESCE(p_full_name, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  IF p_update_phone IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_phone_update_flag';
  END IF;

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

  RETURN QUERY
  UPDATE public.profiles AS profile
  SET
    full_name = v_full_name,
    phone = CASE WHEN p_update_phone THEN p_phone ELSE profile.phone END
  WHERE profile.id = v_user_id
  RETURNING profile.full_name::text, profile.phone::text;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'profile_not_found';
  END IF;
END;
$function$;

ALTER FUNCTION public.update_own_profile_settings_v1(text, text, boolean)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.update_own_profile_settings_v1(text, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_own_profile_settings_v1(text, text, boolean)
  TO authenticated;

COMMIT;
