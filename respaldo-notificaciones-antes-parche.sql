CREATE OR REPLACE FUNCTION public.list_notifications_v1()
 RETURNS TABLE(id uuid, recipient_id uuid, kind text, title text, message text, summary jsonb, created_at timestamp with time zone, read_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
         notification.message,
         CASE
           WHEN notification.summary ? 'event'
            AND notification.kind IS DISTINCT FROM 'event_cancelled'
            AND public.can_read_event(
              (notification.summary -> 'event' ->> 'id')::uuid
            ) IS NOT TRUE
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
   WHERE notification.recipient_id = (SELECT auth.uid())
     AND notification.deleted_at IS NULL
   ORDER BY notification.created_at DESC, notification.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_notification_event_details_v1(p_notification_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_summary jsonb;
  v_event_id uuid;
  v_event_status text;
  v_notification_kind text;
  v_event_available boolean;
BEGIN
  IF auth.uid() IS NULL OR p_notification_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  SELECT notification.summary, notification.kind
    INTO v_summary, v_notification_kind
    FROM public.app_notifications AS notification
   WHERE notification.id = p_notification_id
     AND notification.recipient_id = (SELECT auth.uid())
     AND notification.deleted_at IS NULL;

  IF NOT FOUND OR NOT (v_summary ? 'event') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  v_event_id := (v_summary -> 'event' ->> 'id')::uuid;

  SELECT event.status
    INTO v_event_status
    FROM public.events AS event
   WHERE event.id = v_event_id;

  v_event_available := FOUND;

  IF v_event_available AND public.can_read_event(v_event_id) IS TRUE THEN
    RETURN public.event_notification_summary(
      v_event_id,
      v_event_status,
      true
    ) -> 'event';
  END IF;

  IF v_notification_kind = 'event_cancelled' THEN
    RETURN v_summary -> 'event';
  END IF;

  IF v_notification_kind = 'event_unassigned' THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'unassigned'
    );
  END IF;

  RETURN jsonb_build_object(
    'available', false,
    'reason', 'not_authorized'
  );
END;
$function$;
