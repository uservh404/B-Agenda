BEGIN;

DO $preflight$
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regnamespace('cron') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION
      'Run as postgres with Supabase pg_cron enabled; no scheduled jobs were changed.';
  END IF;

  IF pg_catalog.to_regclass('public.events') IS NULL
     OR pg_catalog.to_regclass('public.event_participants') IS NULL
     OR pg_catalog.to_regclass('public.resources') IS NULL
     OR pg_catalog.to_regclass('public.announcements') IS NULL
     OR pg_catalog.to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION
      'Apply the existing Events, Resources, profiles, and Announcements migrations first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.resources'::regclass
      AND attname = 'deleted_at' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Apply the existing Resources 60-day retention migration first.';
  END IF;

  IF pg_catalog.to_regprocedure('public.can_read_event(uuid)') IS NULL THEN
    RAISE EXCEPTION
      'Apply the Events authorization migration before Notifications.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.events', 'id', 'uuid', true),
        ('public.events', 'owner_id', 'uuid', true),
        ('public.events', 'scope', 'text', true),
        ('public.events', 'title', 'text', true),
        ('public.events', 'description', 'text', true),
        ('public.events', 'category', 'text', true),
        ('public.events', 'event_date', 'date', true),
        ('public.events', 'start_time', 'time without time zone', true),
        ('public.events', 'end_time', 'time without time zone', true),
        ('public.events', 'start_at', 'timestamp with time zone', true),
        ('public.events', 'status', 'text', true),
        ('public.events', 'version', 'bigint', true),
        ('public.events', 'reminder_enabled', 'boolean', true),
        ('public.events', 'reminder_value', 'integer', false),
        ('public.events', 'reminder_unit', 'text', false),
        ('public.event_participants', 'event_id', 'uuid', true),
        ('public.event_participants', 'user_id', 'uuid', true),
        ('public.event_participants', 'created_at', 'timestamp with time zone', true),
        ('public.profiles', 'id', 'uuid', true),
        ('public.profiles', 'full_name', NULL, false),
        ('public.profiles', 'can_assign_events', 'boolean', true),
        ('public.profiles', 'can_publish_announcements', 'boolean', true),
        ('public.profiles', 'can_manage_resources', 'boolean', true),
        ('public.resources', 'deleted_at', 'timestamp with time zone', false),
        ('public.resources', 'name', 'text', true),
        ('public.resources', 'category', 'text', true),
        ('public.resources', 'quantity', 'integer', true),
        ('public.resources', 'stored_in', 'text', true),
        ('public.resources', 'notes', 'text[]', true),
        ('public.announcements', 'id', 'uuid', true),
        ('public.announcements', 'author_id', 'uuid', false),
        ('public.announcements', 'title', 'text', true),
        ('public.announcements', 'content', 'text', true),
        ('public.announcements', 'category', 'text', true),
        ('public.announcements', 'created_at', 'timestamp with time zone', true)
      ) AS required(table_name, column_name, type_name, must_be_not_null)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = pg_catalog.to_regclass(required.table_name)
          AND attribute.attname = required.column_name
          AND NOT attribute.attisdropped
          AND (
            (
              required.type_name IS NULL
              AND EXISTS (
                SELECT 1
                  FROM pg_catalog.pg_type AS column_type
                 WHERE column_type.oid = attribute.atttypid
                   AND column_type.typcategory = 'S'
              )
            )
            OR (
              required.type_name IS NOT NULL
              AND attribute.atttypid = pg_catalog.to_regtype(required.type_name)::oid
            )
          )
          AND (
            NOT required.must_be_not_null
            OR attribute.attnotnull
          )
     )
  ) THEN
    RAISE EXCEPTION
      'The Events, Resources, profiles, or Announcements schema is incompatible with Notifications. Verify required columns and types, including events.start_at/reminder fields and event_participants.created_at.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.events AS event
     WHERE event.status NOT IN ('confirmed', 'cancelled')
        OR event.scope NOT IN ('personal', 'shared')
        OR (
          event.reminder_enabled
          AND (
            event.reminder_value IS NULL
            OR event.reminder_value <= 0
            OR event.reminder_unit IS NULL
            OR event.reminder_unit NOT IN ('minutes', 'hours', 'days', 'weeks')
          )
        )
        OR (
          NOT event.reminder_enabled
          AND (event.reminder_value IS NOT NULL OR event.reminder_unit IS NOT NULL)
        )
  ) THEN
    RAISE EXCEPTION
      'Existing Events rows contain unsupported statuses, scopes, or reminder settings; correct them before Notifications.';
  END IF;

  IF EXISTS (
    SELECT required.attname
    FROM (VALUES
      ('role'),
      ('can_assign_events'),
      ('can_publish_announcements'),
      ('can_manage_resources')
    ) AS required(attname)
     WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.profiles'::regclass
        AND attribute.attname = required.attname
        AND NOT attribute.attisdropped
     )
  ) THEN
    RAISE EXCEPTION 'Apply the profile permission migrations before Notifications.';
  END IF;
END;
$preflight$;

CREATE INDEX IF NOT EXISTS events_reminder_scan_idx
  ON public.events (start_at)
  WHERE status = 'confirmed' AND reminder_enabled;

CREATE TABLE IF NOT EXISTS public.app_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'event_assigned', 'event_updated', 'event_unassigned', 'event_cancelled',
    'event_reminder', 'permission_granted', 'permission_revoked',
    'resource_created', 'announcement_created'
  )),
  title text NOT NULL,
  message text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  read_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS app_notifications_recipient_created_idx
  ON public.app_notifications (recipient_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.notification_change_signals (
  recipient_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE IF NOT EXISTS public.notification_operation_receipts (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('read', 'delete')),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.app_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_change_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_operation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_notifications,
  public.notification_operation_receipts
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.notification_change_signals
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.notification_change_signals TO authenticated;

DROP POLICY IF EXISTS app_notifications_read_own
  ON public.app_notifications;
DROP POLICY IF EXISTS notification_change_signals_read_own
  ON public.notification_change_signals;
CREATE POLICY notification_change_signals_read_own
  ON public.notification_change_signals
  FOR SELECT TO authenticated
  USING (recipient_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS notification_operation_receipts_private
  ON public.notification_operation_receipts;
CREATE POLICY notification_operation_receipts_private
  ON public.notification_operation_receipts
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

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
         notification.message,
         CASE
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
   WHERE notification.recipient_id = (SELECT auth.uid())
     AND notification.deleted_at IS NULL
   ORDER BY notification.created_at DESC, notification.id;
END;
$function$;

ALTER FUNCTION public.list_notifications_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_notifications_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_notifications_v1() TO authenticated;

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
BEGIN
  IF auth.uid() IS NULL OR p_notification_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;
  SELECT notification.summary
    INTO v_summary
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
  IF FOUND AND public.can_read_event(v_event_id) THEN
    RETURN public.event_notification_summary(
      v_event_id,
      v_event_status,
      true
    ) -> 'event';
  END IF;

  RETURN jsonb_build_object(
    'id', v_summary -> 'event' ->> 'id',
    'title', v_summary -> 'event' ->> 'title',
    'date', v_summary -> 'event' ->> 'date',
    'startTime', v_summary -> 'event' ->> 'startTime',
    'endTime', v_summary -> 'event' ->> 'endTime',
    'status', v_summary -> 'event' ->> 'status'
  );
END;
$function$;

ALTER FUNCTION public.get_notification_event_details_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_notification_event_details_v1(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_notification_event_details_v1(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.notify_notification_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_recipient uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_recipient := OLD.recipient_id;
    IF pg_catalog.pg_trigger_depth() > 1
       OR NOT EXISTS (
         SELECT 1 FROM public.profiles AS profile
          WHERE profile.id = v_recipient
       ) THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    v_recipient := NEW.recipient_id;
    IF OLD.recipient_id IS DISTINCT FROM NEW.recipient_id
       AND EXISTS (
         SELECT 1 FROM public.profiles AS profile
          WHERE profile.id = OLD.recipient_id
       ) THEN
      INSERT INTO public.notification_change_signals (
        recipient_id, revision, changed_at
      ) VALUES (
        OLD.recipient_id, 1, pg_catalog.clock_timestamp()
      )
      ON CONFLICT (recipient_id) DO UPDATE
        SET revision = public.notification_change_signals.revision + 1,
            changed_at = EXCLUDED.changed_at;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_recipient := NEW.recipient_id;
  ELSE
    RAISE EXCEPTION 'Unsupported notification trigger operation: %', TG_OP;
  END IF;

  INSERT INTO public.notification_change_signals (recipient_id, revision, changed_at)
  VALUES (v_recipient, 1, pg_catalog.clock_timestamp())
  ON CONFLICT (recipient_id) DO UPDATE
    SET revision = public.notification_change_signals.revision + 1,
        changed_at = EXCLUDED.changed_at;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Notification trigger % on %.% failed (SQLSTATE %): %',
      TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE, SQLERRM;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_notification_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_notification_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS app_notifications_change_signal ON public.app_notifications;
CREATE TRIGGER app_notifications_change_signal
  AFTER INSERT OR UPDATE OR DELETE ON public.app_notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_notification_change();

CREATE OR REPLACE FUNCTION public.apply_notification_operation_v1(
  p_operation_id uuid,
  p_kind text,
  p_notification_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_receipt public.notification_operation_receipts%ROWTYPE;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;
  IF p_operation_id IS NULL OR p_notification_id IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('read', 'delete') THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_operation');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );
  SELECT * INTO v_receipt
    FROM public.notification_operation_receipts
   WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_receipt.actor_id = v_actor
       AND v_receipt.notification_id = p_notification_id
       AND v_receipt.operation_kind = p_kind THEN
      RETURN v_receipt.response;
    END IF;
    RETURN jsonb_build_object('status', 'rejected', 'code', 'operation_id_reused');
  END IF;

  IF p_kind = 'read' THEN
    UPDATE public.app_notifications
       SET read_at = COALESCE(read_at, pg_catalog.clock_timestamp())
     WHERE id = p_notification_id
       AND recipient_id = v_actor
       AND deleted_at IS NULL;
  ELSE
    UPDATE public.app_notifications
       SET deleted_at = COALESCE(deleted_at, pg_catalog.clock_timestamp())
     WHERE id = p_notification_id
       AND recipient_id = v_actor
       AND deleted_at IS NULL;
  END IF;

  IF FOUND THEN
    v_response := jsonb_build_object('status', 'confirmed');
  ELSIF EXISTS (
    SELECT 1 FROM public.app_notifications
     WHERE id = p_notification_id AND recipient_id = v_actor
  ) THEN
    v_response := jsonb_build_object('status', 'confirmed');
  ELSE
    v_response := jsonb_build_object('status', 'rejected', 'code', 'not_authorized_or_not_found');
  END IF;

  INSERT INTO public.notification_operation_receipts (
    operation_id, actor_id, notification_id, operation_kind, response
  ) VALUES (
    p_operation_id, v_actor, p_notification_id, p_kind, v_response
  );
  RETURN v_response;
END;
$function$;

ALTER FUNCTION public.apply_notification_operation_v1(uuid, text, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_notification_operation_v1(uuid, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_notification_operation_v1(uuid, text, uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_app_notification(
  p_recipient_id uuid,
  p_kind text,
  p_title text,
  p_message text,
  p_summary jsonb,
  p_dedupe_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_recipient_id IS NULL OR p_dedupe_key IS NULL OR p_dedupe_key = '' THEN
    RETURN false;
  END IF;
  INSERT INTO public.app_notifications (
    recipient_id, kind, title, message, summary, dedupe_key
  ) VALUES (
    p_recipient_id, p_kind, p_title, p_message,
    COALESCE(p_summary, '{}'::jsonb), p_dedupe_key
  )
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN FOUND;
END;
$function$;

ALTER FUNCTION public.enqueue_app_notification(uuid, text, text, text, jsonb, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_app_notification(uuid, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;

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
      'assignedWorkers', CASE WHEN p_include_participants THEN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', participant.user_id,
          'name', COALESCE(profile.full_name, 'Usuario')
        ) ORDER BY profile.full_name, participant.user_id)
        FROM public.event_participants AS participant
        JOIN public.profiles AS profile ON profile.id = participant.user_id
        WHERE participant.event_id = event.id
      ), '[]'::jsonb) ELSE '[]'::jsonb END,
      'reminderEnabled', event.reminder_enabled,
      'reminderValue', event.reminder_value,
      'reminderUnit', event.reminder_unit
    ) ELSE jsonb_build_object(
      'id', event.id,
      'title', event.title,
      'date', pg_catalog.to_char(event.event_date, 'YYYY-MM-DD'),
      'startTime', pg_catalog.to_char(event.start_time, 'HH24:MI'),
      'endTime', pg_catalog.to_char(event.end_time, 'HH24:MI'),
      'status', p_status
    ) END
  )
  FROM public.events AS event
  LEFT JOIN public.profiles AS owner ON owner.id = event.owner_id
  WHERE event.id = p_event_id;
$function$;

ALTER FUNCTION public.event_notification_summary(uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.event_notification_summary(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;

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
     WHERE NEW.owner_id IS DISTINCT FROM auth.uid()
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
DROP TRIGGER IF EXISTS events_app_notification_after_update ON public.events;
CREATE TRIGGER events_app_notification_after_update
  AFTER UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_event_record_change();

CREATE OR REPLACE FUNCTION public.notify_event_participant_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_event public.events%ROWTYPE;
  v_recipient uuid;
  v_kind text;
  v_title text;
  v_message text;
  v_summary jsonb;
  v_dedupe text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_recipient := NEW.user_id;
    SELECT * INTO v_event FROM public.events WHERE id = NEW.event_id;
    v_kind := 'event_assigned';
    v_title := 'Te asignaron a un evento';
    v_message := 'Fuiste asignado a ' || COALESCE(v_event.title, 'un evento') || '.';
    v_summary := public.event_notification_summary(NEW.event_id, 'confirmed', true);
    v_dedupe := 'event_assigned:' || NEW.event_id::text || ':' ||
      NEW.user_id::text || ':' || NEW.created_at::text;
  ELSIF TG_OP = 'DELETE' THEN
    v_recipient := OLD.user_id;
    SELECT * INTO v_event FROM public.events WHERE id = OLD.event_id;
    v_kind := 'event_unassigned';
    v_title := 'Te retiraron de un evento';
    v_message := 'Ya no participas en ' || COALESCE(v_event.title, 'el evento') || '.';
    v_summary := public.event_notification_summary(OLD.event_id, 'unassigned', false);
    v_dedupe := 'event_unassigned:' || OLD.event_id::text || ':' ||
      OLD.user_id::text || ':' || OLD.created_at::text;
  ELSE
    RAISE EXCEPTION 'Unsupported participant trigger operation: %', TG_OP;
  END IF;

  IF v_event.id IS NULL OR v_event.scope <> 'shared' OR v_recipient IS NULL
     OR v_recipient = auth.uid() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  PERFORM public.enqueue_app_notification(
    v_recipient, v_kind, v_title, v_message, v_summary, v_dedupe
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Notification trigger % on %.% failed (SQLSTATE %): %',
      TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE, SQLERRM;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_event_participant_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_event_participant_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS event_participant_app_notification_after_change
  ON public.event_participants;
CREATE TRIGGER event_participant_app_notification_after_change
  AFTER INSERT OR DELETE ON public.event_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_event_participant_change();

CREATE OR REPLACE FUNCTION public.notify_profile_permission_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_permission text;
  v_granted boolean;
  v_label text;
BEGIN
  IF (OLD.role::text = 'administrador' OR COALESCE(OLD.can_assign_events, false))
     IS DISTINCT FROM
     (NEW.role::text = 'administrador' OR COALESCE(NEW.can_assign_events, false)) THEN
    v_permission := 'can_assign_events';
    v_granted := COALESCE(NEW.can_assign_events, false) OR NEW.role::text = 'administrador';
    v_label := 'asignar eventos';
    PERFORM public.enqueue_app_notification(
      NEW.id,
      CASE WHEN v_granted THEN 'permission_granted' ELSE 'permission_revoked' END,
      CASE WHEN v_granted THEN 'Permiso habilitado' ELSE 'Permiso retirado' END,
      'Se te ' || CASE WHEN v_granted THEN 'otorgó' ELSE 'retiró' END ||
        ' permiso para ' || v_label || '.',
      jsonb_build_object('permission', jsonb_build_object(
        'permission', v_permission, 'granted', v_granted,
        'changedAt', pg_catalog.clock_timestamp()
      )),
      'permission:' || NEW.id::text || ':' || v_permission || ':' ||
        pg_catalog.clock_timestamp()::text || ':' || v_granted::text
    );
  END IF;

  IF (OLD.role::text = 'administrador' OR COALESCE(OLD.can_publish_announcements, false))
     IS DISTINCT FROM
     (NEW.role::text = 'administrador' OR COALESCE(NEW.can_publish_announcements, false)) THEN
    v_permission := 'can_publish_announcements';
    v_granted := COALESCE(NEW.can_publish_announcements, false) OR NEW.role::text = 'administrador';
    v_label := 'publicar Anuncios';
    PERFORM public.enqueue_app_notification(
      NEW.id,
      CASE WHEN v_granted THEN 'permission_granted' ELSE 'permission_revoked' END,
      CASE WHEN v_granted THEN 'Permiso habilitado' ELSE 'Permiso retirado' END,
      'Se te ' || CASE WHEN v_granted THEN 'otorgó' ELSE 'retiró' END ||
        ' permiso para ' || v_label || '.',
      jsonb_build_object('permission', jsonb_build_object(
        'permission', v_permission, 'granted', v_granted,
        'changedAt', pg_catalog.clock_timestamp()
      )),
      'permission:' || NEW.id::text || ':' || v_permission || ':' ||
        pg_catalog.clock_timestamp()::text || ':' || v_granted::text
    );
  END IF;

  IF (OLD.role::text = 'administrador' OR COALESCE(OLD.can_manage_resources, false))
     IS DISTINCT FROM
     (NEW.role::text = 'administrador' OR COALESCE(NEW.can_manage_resources, false)) THEN
    v_permission := 'can_manage_resources';
    v_granted := COALESCE(NEW.can_manage_resources, false) OR NEW.role::text = 'administrador';
    v_label := 'gestionar Recursos';
    PERFORM public.enqueue_app_notification(
      NEW.id,
      CASE WHEN v_granted THEN 'permission_granted' ELSE 'permission_revoked' END,
      CASE WHEN v_granted THEN 'Permiso habilitado' ELSE 'Permiso retirado' END,
      'Se te ' || CASE WHEN v_granted THEN 'otorgó' ELSE 'retiró' END ||
        ' permiso para ' || v_label || '.',
      jsonb_build_object('permission', jsonb_build_object(
        'permission', v_permission, 'granted', v_granted,
        'changedAt', pg_catalog.clock_timestamp()
      )),
      'permission:' || NEW.id::text || ':' || v_permission || ':' ||
        pg_catalog.clock_timestamp()::text || ':' || v_granted::text
    );
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Notification trigger % on %.% failed (SQLSTATE %): %',
      TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_profile_permission_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_profile_permission_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS profiles_app_permission_notification
  ON public.profiles;
CREATE TRIGGER profiles_app_permission_notification
  AFTER UPDATE OF role, can_assign_events, can_publish_announcements, can_manage_resources
  ON public.profiles
  FOR EACH ROW
  WHEN (
    OLD.role IS DISTINCT FROM NEW.role
    OR OLD.can_assign_events IS DISTINCT FROM NEW.can_assign_events
    OR OLD.can_publish_announcements IS DISTINCT FROM NEW.can_publish_announcements
    OR OLD.can_manage_resources IS DISTINCT FROM NEW.can_manage_resources
  )
  EXECUTE FUNCTION public.notify_profile_permission_change();

CREATE OR REPLACE FUNCTION public.notify_employee_resource_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_author_name text;
  v_admin record;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(full_name, 'Empleado') INTO v_author_name
    FROM public.profiles WHERE id = auth.uid();
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND role::text = 'empleado'
  ) THEN
    RETURN NEW;
  END IF;

  FOR v_admin IN
    SELECT id FROM public.profiles
     WHERE role::text = 'administrador'
       AND id <> auth.uid()
  LOOP
    PERFORM public.enqueue_app_notification(
      v_admin.id,
      'resource_created',
      'Nuevo recurso registrado',
      v_author_name || ' registró el recurso ' || NEW.name || '.',
      jsonb_build_object('resource', jsonb_build_object(
        'name', NEW.name,
        'category', NEW.category,
        'quantity', NEW.quantity,
        'storedIn', NEW.stored_in,
        'notes', to_jsonb(NEW.notes),
        'authorName', v_author_name
      )),
      'resource_created:' || NEW.id::text || ':' || v_admin.id::text
    );
  END LOOP;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Notification trigger % on %.% failed (SQLSTATE %): %',
      TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_employee_resource_created() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_employee_resource_created() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS resources_app_notification_after_insert ON public.resources;
CREATE TRIGGER resources_app_notification_after_insert
  AFTER INSERT ON public.resources
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_employee_resource_created();

CREATE OR REPLACE FUNCTION public.notify_employee_announcement_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_author_name text;
  v_admin record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = NEW.author_id AND role::text = 'empleado'
  ) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(full_name, 'Empleado') INTO v_author_name
    FROM public.profiles WHERE id = NEW.author_id;
  FOR v_admin IN
    SELECT id FROM public.profiles
     WHERE role::text = 'administrador'
       AND id <> NEW.author_id
  LOOP
    PERFORM public.enqueue_app_notification(
      v_admin.id,
      'announcement_created',
      'Nuevo anuncio publicado',
      v_author_name || ' publicó el anuncio ' || NEW.title || '.',
      jsonb_build_object('announcement', jsonb_build_object(
        'title', NEW.title,
        'content', NEW.content,
        'category', NEW.category,
        'authorName', v_author_name,
        'publishedAt', NEW.created_at
      )),
      'announcement_created:' || NEW.id::text || ':' || v_admin.id::text
    );
  END LOOP;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Notification trigger % on %.% failed (SQLSTATE %): %',
      TG_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_employee_announcement_created() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_employee_announcement_created() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS announcements_app_notification_after_insert ON public.announcements;
CREATE TRIGGER announcements_app_notification_after_insert
  AFTER INSERT ON public.announcements
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_employee_announcement_created();

CREATE OR REPLACE FUNCTION public.generate_due_event_reminders()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_event record;
  v_recipient record;
  v_offset interval;
  v_count bigint := 0;
  v_summary jsonb;
  v_dedupe text;
BEGIN
  FOR v_event IN
    SELECT event.*
      FROM public.events AS event
     WHERE event.status = 'confirmed'
       AND event.reminder_enabled
       AND event.reminder_value > 0
       AND event.start_at > pg_catalog.clock_timestamp()
  LOOP
    v_offset := CASE v_event.reminder_unit
      WHEN 'minutes' THEN pg_catalog.make_interval(mins => v_event.reminder_value)
      WHEN 'hours' THEN pg_catalog.make_interval(hours => v_event.reminder_value)
      WHEN 'days' THEN pg_catalog.make_interval(days => v_event.reminder_value)
      WHEN 'weeks' THEN pg_catalog.make_interval(weeks => v_event.reminder_value)
      ELSE NULL
    END;
    IF v_offset IS NULL OR v_event.start_at - v_offset > pg_catalog.clock_timestamp() THEN
      CONTINUE;
    END IF;

    v_summary := public.event_notification_summary(v_event.id, 'confirmed', true);
    FOR v_recipient IN
      SELECT v_event.owner_id AS user_id
      UNION
      SELECT participant.user_id
        FROM public.event_participants AS participant
       WHERE participant.event_id = v_event.id
         AND v_event.scope = 'shared'
    LOOP
      v_dedupe := 'event_reminder:' || v_event.id::text || ':' ||
        v_recipient.user_id::text || ':' || v_event.start_at::text || ':' ||
        v_event.reminder_value::text || ':' || v_event.reminder_unit;
      IF public.enqueue_app_notification(
        v_recipient.user_id,
        'event_reminder',
        'Próximo evento',
        'El evento ' || v_event.title || ' está próximo.',
        v_summary,
        v_dedupe
      ) THEN
        v_count := v_count + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_count;
END;
$function$;

ALTER FUNCTION public.generate_due_event_reminders() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.generate_due_event_reminders()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.purge_expired_app_notifications()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.app_notifications
   WHERE deleted_at IS NOT NULL
     AND deleted_at <= pg_catalog.clock_timestamp() - interval '60 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM public.notification_operation_receipts
   WHERE created_at <= pg_catalog.clock_timestamp() - interval '90 days';
  RETURN v_count;
END;
$function$;

ALTER FUNCTION public.purge_expired_app_notifications() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.purge_expired_app_notifications()
  FROM PUBLIC, anon, authenticated;

DO $publication$
DECLARE
  v_all_tables boolean;
BEGIN
  SELECT puballtables INTO v_all_tables
    FROM pg_catalog.pg_publication
   WHERE pubname = 'supabase_realtime';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supabase publication supabase_realtime does not exist.';
  END IF;
  IF NOT v_all_tables AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'notification_change_signals'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_change_signals';
  END IF;
END;
$publication$;

DO $cron$
BEGIN
  PERFORM cron.schedule(
    'agenda-event-reminders-every-minute',
    '* * * * *',
    'SELECT public.generate_due_event_reminders();'
  );
  PERFORM cron.schedule(
    'agenda-notifications-purge-60-days',
    '30 0 * * *',
    'SELECT public.purge_expired_app_notifications();'
  );

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'agenda-event-reminders-every-minute'
       AND schedule = '* * * * *'
       AND command = 'SELECT public.generate_due_event_reminders();'
       AND active
  ) OR NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'agenda-notifications-purge-60-days'
       AND schedule = '30 0 * * *'
       AND command = 'SELECT public.purge_expired_app_notifications();'
       AND active
  ) THEN
    RAISE EXCEPTION 'The reminders/notification-retention jobs were not registered.';
  END IF;
END;
$cron$;

COMMIT;
