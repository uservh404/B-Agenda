BEGIN;

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
            THEN (notification.summary - 'event') || pg_catalog.jsonb_build_object(
              'eventId',
              COALESCE(event.id::text, notification.summary #>> '{event,id}'),
              'eventAvailability',
              CASE
                WHEN event.id IS NULL THEN 'deleted'
                WHEN event.status = 'cancelled' THEN 'cancelled'
                WHEN event.owner_id IS DISTINCT FROM notification.recipient_id
                AND NOT EXISTS (
                  SELECT 1
                    FROM public.event_participants AS participant
                   WHERE participant.event_id = event.id
                     AND participant.user_id = notification.recipient_id
                )
                THEN 'unassigned'
                ELSE 'unavailable'
              END
            )
           WHEN notification.summary ? 'event'
           THEN pg_catalog.jsonb_set(
             notification.summary,
             '{event}',
             public.event_notification_summary(
               event.id,
               event.status,
               true
             ) -> 'event',
             true
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

COMMIT;
