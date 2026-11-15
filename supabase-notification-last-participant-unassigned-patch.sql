CREATE OR REPLACE FUNCTION public.notify_event_record_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_recipient record;
  v_kind text;
  v_title text;
  v_message text;
  v_summary jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'cancelled'
     OR OLD.status IS DISTINCT FROM NEW.status
     OR OLD.scope IS DISTINCT FROM NEW.scope
     OR OLD.event_date IS DISTINCT FROM NEW.event_date
     OR OLD.start_time IS DISTINCT FROM NEW.start_time
     OR OLD.end_time IS DISTINCT FROM NEW.end_time
     OR OLD.start_at IS DISTINCT FROM NEW.start_at
     OR OLD.end_at IS DISTINCT FROM NEW.end_at
     OR OLD.reminder_enabled IS DISTINCT FROM NEW.reminder_enabled
     OR OLD.reminder_value IS DISTINCT FROM NEW.reminder_value
     OR OLD.reminder_unit IS DISTINCT FROM NEW.reminder_unit THEN
    UPDATE public.app_notifications AS notification
       SET deleted_at = pg_catalog.clock_timestamp(),
           dedupe_key = notification.dedupe_key ||
             ':invalidated:' || notification.id::text
     WHERE notification.kind = 'event_reminder'
       AND notification.deleted_at IS NULL
       AND notification.summary #>> '{event,id}' = NEW.id::text;
  END IF;

  IF OLD.status = 'confirmed' AND NEW.status = 'cancelled' THEN
    v_kind := 'event_cancelled';
    v_title := 'Evento cancelado';
    v_message := 'Se canceló el evento ' || NEW.title || '.';
    v_summary := public.event_notification_summary(NEW.id, 'cancelled', true);
  ELSIF OLD.status = 'confirmed'
     AND NEW.status = 'confirmed'
     AND OLD.scope = 'shared'
     AND NEW.scope = 'personal' THEN
    v_kind := 'event_unassigned';
    v_title := 'Te retiraron de un evento';
    v_message := 'Ya no participas en ' || NEW.title || '.';
    v_summary := public.event_notification_summary(NEW.id, 'unassigned', false);
  ELSIF NEW.scope = 'shared'
     AND (
       OLD.title IS DISTINCT FROM NEW.title
       OR OLD.description IS DISTINCT FROM NEW.description
       OR OLD.category IS DISTINCT FROM NEW.category
       OR OLD.event_date IS DISTINCT FROM NEW.event_date
       OR OLD.start_time IS DISTINCT FROM NEW.start_time
       OR OLD.end_time IS DISTINCT FROM NEW.end_time
     ) THEN
    v_kind := 'event_updated';
    v_title := 'Evento actualizado';
    v_message := 'Se actualizaron los datos de ' || NEW.title || '.';
    v_summary := public.event_notification_summary(NEW.id, 'confirmed', true);
  ELSE
    RETURN NEW;
  END IF;

  FOR v_recipient IN
    SELECT participant.user_id
      FROM public.event_participants AS participant
     WHERE participant.event_id = NEW.id
       AND participant.user_id IS DISTINCT FROM auth.uid()
     UNION
    SELECT NEW.owner_id
     WHERE v_kind <> 'event_unassigned'
       AND NEW.owner_id IS DISTINCT FROM auth.uid()
  LOOP
    PERFORM public.enqueue_app_notification(
      v_recipient.user_id,
      v_kind,
      v_title,
      v_message,
      v_summary,
      v_kind || ':' || NEW.id::text || ':' || NEW.version::text || ':' || v_recipient.user_id::text
    );
  END LOOP;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Notification trigger % on %.% failed; notification side effects may be incomplete (SQLSTATE %): %',
      TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_event_record_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_event_record_change() FROM PUBLIC, anon, authenticated;
