WITH test_event AS (
  SELECT 'REPLACE_WITH_TEMP_EVENT_UUID'::uuid AS id
)
SELECT
  (SELECT count(*)::integer
   FROM public.events AS event
   JOIN test_event ON test_event.id = event.id
   WHERE event.scope = 'shared') AS shared_events,
  (SELECT count(*)::integer
   FROM public.event_participants AS participant
   JOIN test_event ON test_event.id = participant.event_id) AS event_participants,
  (SELECT count(*)::integer
   FROM public.event_reservations AS reservation
   JOIN test_event ON test_event.id = reservation.event_id) AS schedule_reservations;
