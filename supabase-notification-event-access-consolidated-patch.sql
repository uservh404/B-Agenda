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
              event.id IS NOT NULL
              AND event.status IS DISTINCT FROM 'cancelled'
              AND public.can_read_event(event.id) IS TRUE
            ) IS NOT TRUE
           THEN 'La información de este evento ya no está disponible para su consulta.'
           ELSE notification.message
         END,
         CASE
           WHEN notification.summary ? 'event'
            AND (
              event.id IS NOT NULL
              AND event.status IS DISTINCT FROM 'cancelled'
              AND public.can_read_event(event.id) IS TRUE
            ) IS NOT TRUE
           THEN notification.summary - 'event'
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

CREATE OR REPLACE FUNCTION public.get_notification_event_details_v1(
  p_notification_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
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

  IF v_event_available AND v_event_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'cancelled'
    );
  END IF;

  IF v_event_available AND public.can_read_event(v_event_id) IS TRUE THEN
    RETURN public.event_notification_summary(
      v_event_id,
      v_event_status,
      true
    ) -> 'event';
  END IF;

  IF NOT v_event_available THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'deleted'
    );
  END IF;

  IF v_notification_kind IN ('event_unassigned', 'event_cancelled') THEN
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
