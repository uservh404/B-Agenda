CREATE OR REPLACE FUNCTION public.event_notification_summary(
  p_event_id uuid,
  p_status text,
  p_include_participants boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'event', CASE WHEN p_include_participants THEN jsonb_build_object(
      'id', event.id,
      'title', event.title,
      'date', pg_catalog.to_char(event.event_date, 'YYYY-MM-DD'),
      'startTime', pg_catalog.to_char(event.start_time, 'HH24:MI'),
      'endTime', pg_catalog.to_char(event.end_time, 'HH24:MI'),
      'description', event.description,
      'category', event.category,
      'status', p_status,
      'createdBy', jsonb_build_object(
        'id', event.owner_id,
        'name', COALESCE(owner.full_name, 'Usuario')
      ),
      'assignedWorkers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', participant.user_id,
          'name', COALESCE(profile.full_name, 'Usuario')
        ) ORDER BY profile.full_name, participant.user_id)
        FROM public.event_participants AS participant
        JOIN public.profiles AS profile ON profile.id = participant.user_id
        WHERE participant.event_id = event.id
      ), '[]'::jsonb),
      'reminderEnabled', event.reminder_enabled,
      'reminderValue', event.reminder_value,
      'reminderUnit', event.reminder_unit
    ) ELSE jsonb_build_object(
      'id', event.id,
      'title', event.title,
      'date', pg_catalog.to_char(event.event_date, 'YYYY-MM-DD'),
      'startTime', pg_catalog.to_char(event.start_time, 'HH24:MI'),
      'endTime', pg_catalog.to_char(event.end_time, 'HH24:MI'),
      'description', event.description,
      'status', p_status,
      'createdBy', jsonb_build_object(
        'name', owner.full_name
      )
    ) END
  )
  FROM public.events AS event
  LEFT JOIN public.profiles AS owner ON owner.id = event.owner_id
  WHERE event.id = p_event_id;
$function$;

ALTER FUNCTION public.event_notification_summary(uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.event_notification_summary(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.list_notifications_v1()
RETURNS TABLE (
  id uuid,
  recipient_id uuid,
  kind text,
  title text,
  message text,
  summary jsonb,
  created_at timestamptz,
  read_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT notification.id,
         notification.recipient_id,
         notification.kind,
         notification.title,
         CASE
           WHEN notification.summary ? 'event'
            AND (
              event.status = 'cancelled'
              OR (
                notification.kind = 'event_cancelled'
                AND (
                  event.id IS NULL
                  OR public.can_read_event(event.id) IS NOT TRUE
                )
              )
            )
            AND COALESCE(
              event.owner_id = (SELECT auth.uid()),
              notification.summary #>> '{event,createdBy,id}' = (SELECT auth.uid())::text,
              false
            ) IS NOT TRUE
           THEN 'La información de este evento ya no está disponible para su consulta.'
           ELSE notification.message
         END,
         CASE
           WHEN notification.summary ? 'event'
            AND (
              event.status = 'cancelled'
              OR (
                notification.kind = 'event_cancelled'
                AND event.id IS NULL
              )
            )
            AND COALESCE(
              event.owner_id = (SELECT auth.uid()),
              notification.summary #>> '{event,createdBy,id}' = (SELECT auth.uid())::text,
              false
            ) IS NOT TRUE
           THEN notification.summary - 'event'
           WHEN notification.summary ? 'event'
            AND NOT public.can_read_event(
              (notification.summary -> 'event' ->> 'id')::uuid
            )
           THEN jsonb_build_object(
             'event', jsonb_build_object(
               'id', notification.summary -> 'event' ->> 'id',
               'title', notification.summary -> 'event' ->> 'title',
               'date', notification.summary -> 'event' ->> 'date',
               'startTime', notification.summary -> 'event' ->> 'startTime',
               'endTime', notification.summary -> 'event' ->> 'endTime',
               'status', notification.summary -> 'event' ->> 'status'
             )
           )
           ELSE notification.summary
         END,
         notification.created_at,
         notification.read_at
    FROM public.app_notifications AS notification
    LEFT JOIN public.events AS event
      ON event.id = (notification.summary -> 'event' ->> 'id')::uuid
   WHERE notification.recipient_id = (SELECT auth.uid())
     AND notification.deleted_at IS NULL
   ORDER BY notification.created_at DESC, notification.id;
END;
$function$;

ALTER FUNCTION public.list_notifications_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_notifications_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_notifications_v1() TO authenticated;
