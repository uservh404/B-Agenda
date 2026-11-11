CREATE FUNCTION public.list_event_participants(p_event_ids uuid[])
RETURNS TABLE (
  event_id uuid,
  user_id uuid,
  full_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT
    event_row.id,
    participant.user_id,
    participant_profile.full_name::text
  FROM public.events AS event_row
  JOIN public.event_participants AS participant
    ON participant.event_id = event_row.id
  JOIN public.profiles AS participant_profile
    ON participant_profile.id = participant.user_id
  WHERE event_row.id = ANY(COALESCE(p_event_ids, ARRAY[]::uuid[]))
    AND public.can_read_event(event_row.id);
END;
$function$;

ALTER FUNCTION public.list_event_participants(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_event_participants(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_event_participants(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_event_participants(uuid[]) TO authenticated;
