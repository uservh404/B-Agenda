BEGIN;

DO $preflight$
DECLARE
  v_generator_oid oid;
  v_summary_oid oid;
  v_enqueue_oid oid;
  v_is_definer boolean;
  v_return_type text;
  v_definition text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'Run this patch as postgres; no database objects were changed.';
  END IF;

  IF pg_catalog.to_regclass('public.events') IS NULL
     OR pg_catalog.to_regclass('public.event_participants') IS NULL
     OR pg_catalog.to_regclass('public.profiles') IS NULL
     OR pg_catalog.to_regclass('public.app_notifications') IS NULL THEN
    RAISE EXCEPTION
      'Required event and notification tables are missing; no database objects were changed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.events'::regclass
      AND attribute.attname = 'reminder_mode'
      AND attribute.atttypid = 'text'::regtype
      AND NOT attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid = 'public.events'::regclass
      AND constraint_info.conname = 'events_reminder_mode_valid'
  ) THEN
    RAISE EXCEPTION
      'Apply and verify supabase-event-reminder-mode-patch.sql first.';
  END IF;

  IF EXISTS (
    SELECT required.table_name, required.column_name
    FROM (VALUES
      ('public.events', 'id'),
      ('public.events', 'owner_id'),
      ('public.events', 'scope'),
      ('public.events', 'title'),
      ('public.events', 'status'),
      ('public.events', 'start_at'),
      ('public.events', 'event_date'),
      ('public.events', 'start_time'),
      ('public.events', 'end_time'),
      ('public.events', 'description'),
      ('public.events', 'category'),
      ('public.events', 'reminder_enabled'),
      ('public.events', 'reminder_value'),
      ('public.events', 'reminder_unit'),
      ('public.event_participants', 'event_id'),
      ('public.event_participants', 'user_id'),
      ('public.profiles', 'id'),
      ('public.profiles', 'full_name'),
      ('public.app_notifications', 'dedupe_key')
    ) AS required(table_name, column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(required.table_name)
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION
      'A required event, participant, profile, or notification column is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid = 'public.app_notifications'::regclass
      AND constraint_info.contype IN ('p', 'u')
      AND constraint_info.conkey = ARRAY[(
        SELECT attribute.attnum::smallint
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.app_notifications'::regclass
          AND attribute.attname = 'dedupe_key'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'app_notifications.dedupe_key must have a unique constraint; duplicate protection is required.';
  END IF;

  v_enqueue_oid := pg_catalog.to_regprocedure(
    'public.enqueue_app_notification(uuid,text,text,text,jsonb,text)'
  );
  IF v_enqueue_oid IS NULL THEN
    RAISE EXCEPTION 'public.enqueue_app_notification() is missing.';
  END IF;

  SELECT p.prosecdef, pg_catalog.format_type(p.prorettype, NULL)
    INTO v_is_definer, v_return_type
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = v_enqueue_oid;
  IF v_is_definer IS DISTINCT FROM true
     OR v_return_type IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION
      'enqueue_app_notification() must remain SECURITY DEFINER and return boolean.';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_enqueue_oid)
    INTO v_definition;
  IF pg_catalog.strpos(v_definition, 'ON CONFLICT (dedupe_key) DO NOTHING') = 0 THEN
    RAISE EXCEPTION
      'enqueue_app_notification() does not have the reviewed dedupe behavior.';
  END IF;

  v_summary_oid := pg_catalog.to_regprocedure(
    'public.event_notification_summary(uuid,text,boolean)'
  );
  IF v_summary_oid IS NULL THEN
    RAISE EXCEPTION 'public.event_notification_summary() is missing.';
  END IF;

  SELECT p.prosecdef, pg_catalog.format_type(p.prorettype, NULL)
    INTO v_is_definer, v_return_type
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = v_summary_oid;
  IF v_is_definer IS DISTINCT FROM true
     OR v_return_type IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION
      'event_notification_summary() must remain SECURITY DEFINER and return jsonb.';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_summary_oid)
    INTO v_definition;
  IF pg_catalog.strpos(v_definition, 'assignedWorkers') = 0
     OR pg_catalog.strpos(v_definition, 'reminderEnabled') = 0
     OR pg_catalog.strpos(v_definition, 'reminderValue') = 0
     OR pg_catalog.strpos(v_definition, 'reminderUnit') = 0
     OR pg_catalog.strpos(v_definition, 'location') > 0 THEN
    RAISE EXCEPTION
      'event_notification_summary() differs from the reviewed event-detail shape; inspect it before applying this patch.';
  END IF;

  v_generator_oid := pg_catalog.to_regprocedure(
    'public.generate_due_event_reminders()'
  );
  IF v_generator_oid IS NULL THEN
    RAISE EXCEPTION 'public.generate_due_event_reminders() is missing.';
  END IF;

  SELECT p.prosecdef, pg_catalog.format_type(p.prorettype, NULL)
    INTO v_is_definer, v_return_type
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = v_generator_oid;
  IF v_is_definer IS DISTINCT FROM true
     OR v_return_type IS DISTINCT FROM 'bigint' THEN
    RAISE EXCEPTION
      'generate_due_event_reminders() must remain SECURITY DEFINER and return bigint.';
  END IF;

END;
$preflight$;

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
AS $summary$
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
      'reminderUnit', event.reminder_unit,
      'reminderMode', event.reminder_mode
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
$summary$;

ALTER FUNCTION public.event_notification_summary(uuid, text, boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.event_notification_summary(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.generate_due_event_reminders()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_event record;
  v_recipient record;
  v_delivery_grace constant interval := interval '5 minutes';
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_offset interval;
  v_count bigint := 0;
  v_summary jsonb;
  v_dedupe text;
BEGIN
  FOR v_event IN
    SELECT event.*
      FROM public.events AS event
     WHERE event.status = 'confirmed'
       AND (
         (
           event.reminder_mode IS NULL
           AND event.reminder_enabled
           AND event.reminder_value > 0
           AND event.start_at > pg_catalog.clock_timestamp()
         )
         OR (
           event.reminder_mode = 'start'
           AND event.start_at <= v_now
           AND event.start_at >= v_now - v_delivery_grace
         )
         OR (
           event.reminder_mode = 'anticipation'
           AND event.reminder_enabled
           AND event.reminder_value > 0
           AND event.reminder_unit IN ('minutes', 'hours', 'days', 'weeks')
           AND event.start_at > v_now
         )
       )
  LOOP
    IF v_event.reminder_mode IS NULL THEN
      v_offset := CASE v_event.reminder_unit
        WHEN 'minutes' THEN pg_catalog.make_interval(mins => v_event.reminder_value)
        WHEN 'hours' THEN pg_catalog.make_interval(hours => v_event.reminder_value)
        WHEN 'days' THEN pg_catalog.make_interval(days => v_event.reminder_value)
        WHEN 'weeks' THEN pg_catalog.make_interval(weeks => v_event.reminder_value)
        ELSE NULL
      END;

      IF v_offset IS NULL
         OR v_event.start_at - v_offset > pg_catalog.clock_timestamp() THEN
        CONTINUE;
      END IF;
    ELSIF v_event.reminder_mode = 'anticipation' THEN
      v_offset := CASE v_event.reminder_unit
        WHEN 'minutes' THEN pg_catalog.make_interval(mins => v_event.reminder_value)
        WHEN 'hours' THEN pg_catalog.make_interval(hours => v_event.reminder_value)
        WHEN 'days' THEN pg_catalog.make_interval(days => v_event.reminder_value)
        WHEN 'weeks' THEN pg_catalog.make_interval(weeks => v_event.reminder_value)
        ELSE NULL
      END;

      IF v_offset IS NULL
         OR v_event.start_at - v_offset > v_now THEN
        CONTINUE;
      END IF;
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
      IF v_event.reminder_mode = 'start' THEN
        v_dedupe := 'event_reminder:' || v_event.id::text || ':' ||
          v_recipient.user_id::text || ':' || v_event.start_at::text || ':start';
      ELSE
        v_dedupe := 'event_reminder:' || v_event.id::text || ':' ||
          v_recipient.user_id::text || ':' || v_event.start_at::text || ':' ||
          v_event.reminder_value::text || ':' || v_event.reminder_unit;
      END IF;

      IF public.enqueue_app_notification(
        v_recipient.user_id,
        'event_reminder',
        CASE
          WHEN v_event.reminder_mode = 'start' THEN 'Evento iniciado'
          ELSE 'Próximo evento'
        END,
        CASE
          WHEN v_event.reminder_mode = 'start'
            THEN 'El evento ' || v_event.title || ' ha comenzado.'
          ELSE 'El evento ' || v_event.title || ' está próximo.'
        END,
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

COMMIT;
