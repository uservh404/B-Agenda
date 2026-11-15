BEGIN;

DO $notification_history_patch$
DECLARE
  v_function_definition text;
  v_invalidation_block constant text := $invalidation$
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
$invalidation$;
  v_history_block constant text := $history$
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
       SET title = 'Recordatorio anterior',
           message = CASE
             WHEN NEW.status = 'cancelled' THEN
               'El evento fue cancelado. Este recordatorio se conserva como historial.'
             ELSE
               'El evento cambió. Este recordatorio corresponde a su configuración anterior.'
           END
     WHERE notification.kind = 'event_reminder'
       AND notification.deleted_at IS NULL
       AND notification.summary #>> '{event,id}' = NEW.id::text
       AND (
         notification.title IS DISTINCT FROM 'Recordatorio anterior'
         OR (
           NEW.status = 'cancelled'
           AND notification.message IS DISTINCT FROM
             'El evento fue cancelado. Este recordatorio se conserva como historial.'
         )
       );
  END IF;
$history$;
  v_occurrences integer;
  v_history_occurrences integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.notify_event_record_change()'::regprocedure
  )
    INTO v_function_definition;

  v_occurrences :=
    (
      pg_catalog.length(v_function_definition)
      - pg_catalog.length(
          pg_catalog.replace(v_function_definition, v_invalidation_block, '')
        )
    ) / pg_catalog.length(v_invalidation_block);

  IF v_occurrences = 1 THEN
    EXECUTE pg_catalog.replace(
      v_function_definition,
      v_invalidation_block,
      v_history_block
    );
  ELSIF v_occurrences = 0 THEN
    v_history_occurrences :=
      (
        pg_catalog.length(v_function_definition)
        - pg_catalog.length(
            pg_catalog.replace(v_function_definition, v_history_block, '')
          )
      ) / pg_catalog.length(v_history_block);
    IF v_history_occurrences = 1 THEN
      NULL;
    ELSE
      RAISE EXCEPTION
        'Could not safely locate the reminder history block in public.notify_event_record_change().';
    END IF;
  ELSE
    RAISE EXCEPTION
      'Could not safely replace the event-reminder invalidation block in public.notify_event_record_change(); found % exact matches.',
      v_occurrences;
  END IF;
END;
$notification_history_patch$;

DO $notification_kind_patch$
DECLARE
  v_constraint_count integer;
  v_constraint_name text;
BEGIN
  SELECT pg_catalog.count(*), pg_catalog.min(constraint_row.conname::text)
    INTO v_constraint_count, v_constraint_name
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'public.app_notifications'::regclass
     AND constraint_row.contype = 'c'
     AND pg_catalog.strpos(
       pg_catalog.pg_get_constraintdef(constraint_row.oid),
       'kind'
     ) > 0
     AND pg_catalog.strpos(
       pg_catalog.pg_get_constraintdef(constraint_row.oid),
       'event_assigned'
     ) > 0
     AND pg_catalog.strpos(
       pg_catalog.pg_get_constraintdef(constraint_row.oid),
       'announcement_created'
     ) > 0;

  IF v_constraint_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one app_notifications kind constraint; found %.',
      v_constraint_count;
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER TABLE public.app_notifications DROP CONSTRAINT %I',
    v_constraint_name
  );
END;
$notification_kind_patch$;

ALTER TABLE public.app_notifications
  ADD CONSTRAINT app_notifications_kind_check
  CHECK (kind IN (
    'event_assigned', 'event_updated', 'event_unassigned', 'event_cancelled',
    'event_reminder', 'permission_granted', 'permission_revoked',
    'role_changed', 'resource_created', 'announcement_created'
  ));

DO $profile_role_notification_patch$
DECLARE
  v_function_definition text;
  v_profile_marker constant text := $marker$BEGIN
  IF (OLD.role::text = 'administrador' OR COALESCE(OLD.can_assign_events, false))$marker$;
  v_role_notification constant text := $notification$
BEGIN
  IF OLD.role::text IN ('administrador', 'empleado')
     AND NEW.role::text IN ('administrador', 'empleado')
     AND OLD.role IS DISTINCT FROM NEW.role THEN
    PERFORM public.enqueue_app_notification(
      NEW.id,
      'role_changed',
      'Cambio de rol',
      'Tu rol ha cambiado de ' || OLD.role::text || ' a ' || NEW.role::text,
      '{}'::jsonb,
      'role_changed:' || NEW.id::text || ':' || NEW.role::text || ':' ||
        pg_catalog.txid_current()::text
    );
  END IF;

  IF (OLD.role::text = 'administrador' OR COALESCE(OLD.can_assign_events, false))$notification$;
  v_occurrences integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS notification_trigger
     WHERE notification_trigger.tgrelid = 'public.profiles'::regclass
       AND notification_trigger.tgname = 'profiles_app_permission_notification'
       AND NOT notification_trigger.tgisinternal
       AND notification_trigger.tgenabled <> 'D'
       AND pg_catalog.strpos(
         pg_catalog.lower(pg_catalog.pg_get_triggerdef(notification_trigger.oid)),
         'update of role'
       ) > 0
  ) THEN
    RAISE EXCEPTION
      'Expected an enabled profiles_app_permission_notification trigger that watches role updates.';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.notify_profile_permission_change()'::regprocedure
  )
    INTO v_function_definition;

  IF pg_catalog.strpos(v_function_definition, 'role_changed') > 0 THEN
    RAISE EXCEPTION
      'public.notify_profile_permission_change() already contains role_changed; review before applying this patch again.';
  END IF;

  v_occurrences :=
    (
      pg_catalog.length(v_function_definition)
      - pg_catalog.length(
          pg_catalog.replace(v_function_definition, v_profile_marker, '')
        )
    ) / pg_catalog.length(v_profile_marker);

  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION
      'Expected one permission-change insertion point in public.notify_profile_permission_change(); found %.',
      v_occurrences;
  END IF;

  EXECUTE pg_catalog.replace(
    v_function_definition,
    v_profile_marker,
    v_role_notification
  );
END;
$profile_role_notification_patch$;

COMMIT;
