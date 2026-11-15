BEGIN;

DO $admin_notification_preflight$
DECLARE
  v_kind_constraint_count integer;
  v_constraint_name text;
  v_legacy_trigger_function oid;
  v_legacy_function_definition text;
  v_enqueue_definition text;
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.app_notifications') IS NULL
     OR pg_catalog.to_regclass('public.profiles') IS NULL
     OR pg_catalog.to_regclass('public.events') IS NULL
     OR pg_catalog.to_regclass('public.event_participants') IS NULL
     OR pg_catalog.to_regclass('public.resources') IS NULL
     OR pg_catalog.to_regclass('public.announcements') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.enqueue_app_notification(uuid,text,text,text,jsonb,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Notifications, Profiles, Events, Resources, Announcements, and enqueue_app_notification() must already exist; run this patch as postgres.';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.enqueue_app_notification(uuid,text,text,text,jsonb,text)'::regprocedure
  )
    INTO v_enqueue_definition;
  IF v_enqueue_definition !~*
     'ON[[:space:]]+CONFLICT[[:space:]]*\([[:space:]]*dedupe_key[[:space:]]*\)[[:space:]]+DO[[:space:]]+NOTHING'
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_index AS index_row
        WHERE index_row.indrelid = 'public.app_notifications'::regclass
          AND index_row.indisunique
          AND index_row.indpred IS NULL
          AND index_row.indnkeyatts = 1
          AND pg_catalog.strpos(
            pg_catalog.pg_get_indexdef(index_row.indexrelid),
            '(dedupe_key)'
          ) > 0
     ) THEN
    RAISE EXCEPTION
      'enqueue_app_notification() must use ON CONFLICT (dedupe_key) DO NOTHING and app_notifications must have a unique dedupe_key index.';
  END IF;

  SELECT trigger_row.tgfoid
    INTO v_legacy_trigger_function
    FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = 'public.resources'::regclass
     AND trigger_row.tgname = 'resources_app_notification_after_insert'
     AND NOT trigger_row.tgisinternal;
  IF FOUND THEN
    IF v_legacy_trigger_function IS DISTINCT FROM
       'public.notify_employee_resource_created()'::regprocedure::oid THEN
      RAISE EXCEPTION
        'The existing resource creation trigger uses an unexpected function; inspect it before applying this patch.';
    END IF;
    SELECT pg_catalog.pg_get_functiondef(v_legacy_trigger_function)
      INTO v_legacy_function_definition;
    IF pg_catalog.strpos(
      v_legacy_function_definition,
      $dedupe$'resource_created:' || NEW.id::text || ':' || v_admin.id::text$dedupe$
    ) = 0 THEN
      RAISE EXCEPTION
        'The existing resource creation trigger does not use the reviewed deduplication key; inspect it before applying this patch.';
    END IF;
  END IF;

  SELECT trigger_row.tgfoid
    INTO v_legacy_trigger_function
    FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = 'public.announcements'::regclass
     AND trigger_row.tgname = 'announcements_app_notification_after_insert'
     AND NOT trigger_row.tgisinternal;
  IF FOUND THEN
    IF v_legacy_trigger_function IS DISTINCT FROM
       'public.notify_employee_announcement_created()'::regprocedure::oid THEN
      RAISE EXCEPTION
        'The existing announcement creation trigger uses an unexpected function; inspect it before applying this patch.';
    END IF;
    SELECT pg_catalog.pg_get_functiondef(v_legacy_trigger_function)
      INTO v_legacy_function_definition;
    IF pg_catalog.strpos(
      v_legacy_function_definition,
      $dedupe$'announcement_created:' || NEW.id::text || ':' || v_admin.id::text$dedupe$
    ) = 0 THEN
      RAISE EXCEPTION
        'The existing announcement creation trigger does not use the reviewed deduplication key; inspect it before applying this patch.';
    END IF;
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.min(constraint_row.conname::text)
    INTO v_kind_constraint_count, v_constraint_name
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

  IF v_kind_constraint_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one app_notifications kind constraint; found %.',
      v_kind_constraint_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.app_notifications AS notification
     WHERE notification.kind NOT IN (
       'event_assigned', 'event_updated', 'event_unassigned', 'event_cancelled',
       'event_reminder', 'event_admin_created', 'event_admin_updated',
       'event_admin_cancelled', 'event_admin_deleted',
       'permission_granted', 'permission_revoked', 'role_changed',
       'admin_role_changed', 'admin_permission_changed',
       'resource_created', 'resource_updated', 'resource_deleted',
       'announcement_created', 'announcement_updated', 'announcement_deleted'
     )
  ) THEN
    RAISE EXCEPTION
      'app_notifications contains a kind not covered by this patch; inspect existing notification types before continuing.';
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER TABLE public.app_notifications DROP CONSTRAINT %I',
    v_constraint_name
  );
END;
$admin_notification_preflight$;

ALTER TABLE public.app_notifications
  ADD CONSTRAINT app_notifications_kind_check
  CHECK (kind IN (
    'event_assigned', 'event_updated', 'event_unassigned', 'event_cancelled',
    'event_reminder', 'event_admin_created', 'event_admin_updated',
    'event_admin_cancelled', 'event_admin_deleted',
    'permission_granted', 'permission_revoked', 'role_changed',
    'admin_role_changed', 'admin_permission_changed',
    'resource_created', 'resource_updated', 'resource_deleted',
    'announcement_created', 'announcement_updated', 'announcement_deleted'
  ));

CREATE OR REPLACE FUNCTION public.enqueue_admin_action_notification(
  p_actor_id uuid,
  p_subject_id uuid,
  p_event_id uuid,
  p_kind text,
  p_title text,
  p_message text,
  p_summary jsonb,
  p_dedupe_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_recipient record;
BEGIN
  IF p_actor_id IS NULL
     OR p_kind IS NULL
     OR p_title IS NULL
     OR p_message IS NULL
     OR p_dedupe_key IS NULL
     OR p_dedupe_key = '' THEN
    RAISE EXCEPTION 'Invalid administrative notification arguments.';
  END IF;

  FOR v_recipient IN
    SELECT administrator.id
      FROM public.profiles AS administrator
     WHERE administrator.role::text = 'administrador'
       AND administrator.id IS DISTINCT FROM p_actor_id
       AND (
         p_subject_id IS NULL
         OR administrator.id IS DISTINCT FROM p_subject_id
       )
       AND (
         p_event_id IS NULL
         OR NOT EXISTS (
           SELECT 1
             FROM public.app_notifications AS existing_notification
            WHERE existing_notification.recipient_id = administrator.id
              AND existing_notification.summary #>> '{event,id}' = p_event_id::text
              AND existing_notification.kind IN (
                'event_assigned', 'event_updated', 'event_unassigned',
                'event_cancelled'
              )
              AND existing_notification.deleted_at IS NULL
              AND existing_notification.created_at >= pg_catalog.transaction_timestamp()
         )
       )
  LOOP
    PERFORM public.enqueue_app_notification(
      v_recipient.id,
      p_kind,
      p_title,
      p_message,
      COALESCE(p_summary, '{}'::jsonb),
      p_dedupe_key || ':' || v_recipient.id::text
    );
  END LOOP;
END;
$function$;

ALTER FUNCTION public.enqueue_admin_action_notification(
  uuid, uuid, uuid, text, text, text, jsonb, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_admin_action_notification(
  uuid, uuid, uuid, text, text, text, jsonb, text
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_resource_admin_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_kind text;
  v_title text;
  v_message text;
  v_action_key text;
BEGIN
  IF v_actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(pg_catalog.btrim(profile.full_name::text), ''), 'Usuario')
    INTO v_actor_name
    FROM public.profiles AS profile
   WHERE profile.id = v_actor_id;
  v_actor_name := COALESCE(v_actor_name, 'Usuario');

  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_kind := 'resource_created';
    v_title := 'Recurso creado';
    v_message := v_actor_name || ' creó el recurso ' || NEW.name || '.';
    v_action_key := 'resource_created';
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      v_kind := 'resource_deleted';
      v_title := 'Recurso eliminado';
      v_message := v_actor_name || ' eliminó el recurso ' || NEW.name || '.';
      v_action_key := 'resource_deleted';
    ELSIF OLD.deleted_at IS NULL
       AND NEW.deleted_at IS NULL
       AND (
         OLD.name IS DISTINCT FROM NEW.name
         OR OLD.category IS DISTINCT FROM NEW.category
         OR OLD.quantity IS DISTINCT FROM NEW.quantity
         OR OLD.stored_in IS DISTINCT FROM NEW.stored_in
         OR OLD.notes IS DISTINCT FROM NEW.notes
       ) THEN
      v_kind := 'resource_updated';
      v_title := 'Recurso actualizado';
      v_message := v_actor_name || ' actualizó el recurso ' || NEW.name || '.';
      v_action_key := 'resource_updated';
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM public.enqueue_admin_action_notification(
    v_actor_id,
    NULL,
    NULL,
    v_kind,
    v_title,
    v_message,
    jsonb_build_object('resource', jsonb_build_object(
      'name', NEW.name,
      'category', NEW.category,
      'quantity', NEW.quantity,
      'storedIn', NEW.stored_in,
      'notes', to_jsonb(NEW.notes),
      'authorName', v_actor_name,
      'actionBy', v_actor_name
    )),
    CASE
      WHEN v_kind = 'resource_created'
        THEN v_action_key || ':' || NEW.id::text
      ELSE v_action_key || ':' || NEW.id::text || ':' || NEW.version::text
    END
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Administrative resource notification failed (SQLSTATE %): %',
      SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_resource_admin_action() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_resource_admin_action()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS resources_admin_notification_after_insert
  ON public.resources;
DROP TRIGGER IF EXISTS resources_admin_notification_after_update
  ON public.resources;
CREATE TRIGGER resources_admin_notification_after_insert
  AFTER INSERT ON public.resources
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_resource_admin_action();
CREATE TRIGGER resources_admin_notification_after_update
  AFTER UPDATE ON public.resources
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_resource_admin_action();

CREATE OR REPLACE FUNCTION public.notify_announcement_admin_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_kind text;
  v_title text;
  v_message text;
  v_action_key text;
BEGIN
  IF v_actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(pg_catalog.btrim(profile.full_name::text), ''), 'Usuario')
    INTO v_actor_name
    FROM public.profiles AS profile
   WHERE profile.id = v_actor_id;
  v_actor_name := COALESCE(v_actor_name, 'Usuario');

  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_kind := 'announcement_created';
    v_title := 'Anuncio creado';
    v_message := v_actor_name || ' creó el anuncio ' || NEW.title || '.';
    v_action_key := 'announcement_created';
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      v_kind := 'announcement_deleted';
      v_title := 'Anuncio eliminado';
      v_message := v_actor_name || ' eliminó el anuncio ' || NEW.title || '.';
      v_action_key := 'announcement_deleted';
    ELSIF OLD.deleted_at IS NULL
       AND NEW.deleted_at IS NULL
       AND (
         OLD.title IS DISTINCT FROM NEW.title
         OR OLD.content IS DISTINCT FROM NEW.content
         OR OLD.category IS DISTINCT FROM NEW.category
       ) THEN
      v_kind := 'announcement_updated';
      v_title := 'Anuncio actualizado';
      v_message := v_actor_name || ' actualizó el anuncio ' || NEW.title || '.';
      v_action_key := 'announcement_updated';
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM public.enqueue_admin_action_notification(
    v_actor_id,
    NULL,
    NULL,
    v_kind,
    v_title,
    v_message,
    jsonb_build_object('announcement', jsonb_build_object(
      'title', NEW.title,
      'content', NEW.content,
      'category', NEW.category,
      'authorName', COALESCE(NEW.author_name, 'Usuario'),
      'publishedAt', NEW.created_at,
      'actionBy', v_actor_name
    )),
    CASE
      WHEN v_kind = 'announcement_created'
        THEN v_action_key || ':' || NEW.id::text
      ELSE v_action_key || ':' || NEW.id::text || ':' || NEW.version::text
    END
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Administrative announcement notification failed (SQLSTATE %): %',
      SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_announcement_admin_action() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_announcement_admin_action()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS announcements_admin_notification_after_insert
  ON public.announcements;
DROP TRIGGER IF EXISTS announcements_admin_notification_after_update
  ON public.announcements;
CREATE TRIGGER announcements_admin_notification_after_insert
  AFTER INSERT ON public.announcements
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_announcement_admin_action();
CREATE TRIGGER announcements_admin_notification_after_update
  AFTER UPDATE ON public.announcements
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_announcement_admin_action();

CREATE OR REPLACE FUNCTION public.notify_event_admin_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_event_id uuid;
  v_event_version bigint;
  v_event_status text;
  v_kind text;
  v_title text;
  v_message text;
  v_action_key text;
BEGIN
  IF v_actor_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_event_id := OLD.id;
    v_event_version := OLD.version;
    v_kind := 'event_admin_deleted';
    v_title := 'Evento eliminado';
    v_action_key := 'event_admin_deleted';
  ELSIF TG_OP = 'INSERT' THEN
    v_event_id := NEW.id;
    v_event_version := NEW.version;
    v_kind := 'event_admin_created';
    v_title := 'Evento creado';
    v_action_key := 'event_admin_created';

    SELECT event.status, event.version
      INTO v_event_status, v_event_version
      FROM public.events AS event
     WHERE event.id = v_event_id;
    IF NOT FOUND OR v_event_status <> 'confirmed' THEN
      RETURN NULL;
    END IF;
    IF v_event_version IS DISTINCT FROM NEW.version THEN
      RETURN NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    v_event_id := NEW.id;
    v_event_version := NEW.version;

    SELECT event.status, event.version
      INTO v_event_status, v_event_version
      FROM public.events AS event
     WHERE event.id = v_event_id;
    IF NOT FOUND OR v_event_version IS DISTINCT FROM NEW.version THEN
      RETURN NULL;
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status
       AND NEW.status = 'cancelled' THEN
      v_kind := 'event_admin_cancelled';
      v_title := 'Evento cancelado';
      v_action_key := 'event_admin_cancelled';
    ELSIF NEW.status = 'confirmed'
       AND OLD.version IS DISTINCT FROM NEW.version THEN
      v_kind := 'event_admin_updated';
      v_title := 'Evento actualizado';
      v_action_key := 'event_admin_updated';
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    RETURN NULL;
  END IF;

  SELECT COALESCE(NULLIF(pg_catalog.btrim(profile.full_name::text), ''), 'Usuario')
    INTO v_actor_name
    FROM public.profiles AS profile
   WHERE profile.id = v_actor_id;
  v_actor_name := COALESCE(v_actor_name, 'Usuario');

  v_message := CASE v_kind
    WHEN 'event_admin_created' THEN v_actor_name || ' creó un evento.'
    WHEN 'event_admin_updated' THEN v_actor_name || ' actualizó un evento.'
    WHEN 'event_admin_cancelled' THEN v_actor_name || ' canceló un evento.'
    ELSE v_actor_name || ' eliminó un evento.'
  END;

  PERFORM public.enqueue_admin_action_notification(
    v_actor_id,
    NULL,
    v_event_id,
    v_kind,
    v_title,
    v_message,
    jsonb_build_object('event', jsonb_build_object('id', v_event_id)),
    v_action_key || ':' || v_event_id::text || ':' || v_event_version::text
  );
  RETURN NULL;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Administrative event notification failed (SQLSTATE %): %',
      SQLSTATE, SQLERRM;
    RETURN NULL;
END;
$function$;

ALTER FUNCTION public.notify_event_admin_action() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_event_admin_action()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS events_admin_notification_after_insert
  ON public.events;
DROP TRIGGER IF EXISTS events_admin_notification_after_update
  ON public.events;
DROP TRIGGER IF EXISTS events_admin_notification_after_delete
  ON public.events;
CREATE CONSTRAINT TRIGGER events_admin_notification_after_insert
  AFTER INSERT ON public.events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_event_admin_action();
CREATE CONSTRAINT TRIGGER events_admin_notification_after_update
  AFTER UPDATE ON public.events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_event_admin_action();
CREATE CONSTRAINT TRIGGER events_admin_notification_after_delete
  AFTER DELETE ON public.events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_event_admin_action();

CREATE OR REPLACE FUNCTION public.notify_profile_admin_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_subject_name text;
  v_permission_name text;
  v_granted boolean;
  v_changed_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF v_actor_id IS NULL OR v_actor_id = NEW.id THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS actor
     WHERE actor.id = v_actor_id
       AND actor.role::text = 'administrador'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(pg_catalog.btrim(profile.full_name::text), ''), 'Usuario')
    INTO v_actor_name
    FROM public.profiles AS profile
   WHERE profile.id = v_actor_id;
  SELECT COALESCE(NULLIF(pg_catalog.btrim(profile.full_name::text), ''), 'Usuario')
    INTO v_subject_name
    FROM public.profiles AS profile
   WHERE profile.id = NEW.id;
  v_actor_name := COALESCE(v_actor_name, 'Usuario');
  v_subject_name := COALESCE(v_subject_name, 'Usuario');

  IF OLD.role IS DISTINCT FROM NEW.role
     AND OLD.role::text IN ('administrador', 'empleado')
     AND NEW.role::text IN ('administrador', 'empleado') THEN
    PERFORM public.enqueue_admin_action_notification(
      v_actor_id,
      NEW.id,
      NULL,
      'admin_role_changed',
      'Cambio de rol de usuario',
      v_actor_name || ' cambió el rol de ' || v_subject_name || ' de ' ||
        OLD.role::text || ' a ' || NEW.role::text || '.',
      jsonb_build_object('roleChange', jsonb_build_object(
        'affectedUserName', v_subject_name,
        'actionBy', v_actor_name,
        'oldRole', OLD.role::text,
        'newRole', NEW.role::text,
        'changedAt', v_changed_at
      )),
      'admin_role_changed:' || NEW.id::text || ':' ||
        NEW.role::text || ':' || v_actor_id::text || ':' ||
        pg_catalog.txid_current()::text
    );
  END IF;

  IF OLD.can_assign_events IS DISTINCT FROM NEW.can_assign_events THEN
      v_permission_name := 'asignar eventos';
      v_granted := COALESCE(NEW.can_assign_events, false);
      PERFORM public.enqueue_admin_action_notification(
        v_actor_id,
        NEW.id,
        NULL,
        'admin_permission_changed',
        CASE WHEN v_granted THEN 'Permiso concedido' ELSE 'Permiso retirado' END,
        v_actor_name || CASE WHEN v_granted THEN ' concedió a ' ELSE ' retiró a ' END ||
          v_subject_name || ' el permiso para ' || v_permission_name || '.',
        jsonb_build_object('permission', jsonb_build_object(
          'permission', 'can_assign_events',
          'granted', v_granted,
          'changedAt', v_changed_at,
          'affectedUserName', v_subject_name,
          'actionBy', v_actor_name
        )),
        'admin_permission_changed:' || NEW.id::text ||
          ':can_assign_events:' || v_granted::text || ':' ||
          v_actor_id::text || ':' || pg_catalog.txid_current()::text
      );
  END IF;

  IF OLD.can_publish_announcements IS DISTINCT FROM NEW.can_publish_announcements THEN
      v_permission_name := 'publicar anuncios';
      v_granted := COALESCE(NEW.can_publish_announcements, false);
      PERFORM public.enqueue_admin_action_notification(
        v_actor_id,
        NEW.id,
        NULL,
        'admin_permission_changed',
        CASE WHEN v_granted THEN 'Permiso concedido' ELSE 'Permiso retirado' END,
        v_actor_name || CASE WHEN v_granted THEN ' concedió a ' ELSE ' retiró a ' END ||
          v_subject_name || ' el permiso para ' || v_permission_name || '.',
        jsonb_build_object('permission', jsonb_build_object(
          'permission', 'can_publish_announcements',
          'granted', v_granted,
          'changedAt', v_changed_at,
          'affectedUserName', v_subject_name,
          'actionBy', v_actor_name
        )),
        'admin_permission_changed:' || NEW.id::text ||
          ':can_publish_announcements:' || v_granted::text || ':' ||
          v_actor_id::text || ':' || pg_catalog.txid_current()::text
      );
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING
      'Administrative profile notification failed (SQLSTATE %): %',
      SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_profile_admin_action() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_profile_admin_action()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_admin_action_notification
  ON public.profiles;
CREATE TRIGGER profiles_admin_action_notification
  AFTER UPDATE OF role, can_assign_events, can_publish_announcements
  ON public.profiles
  FOR EACH ROW
  WHEN (
    OLD.role IS DISTINCT FROM NEW.role
    OR OLD.can_assign_events IS DISTINCT FROM NEW.can_assign_events
    OR OLD.can_publish_announcements IS DISTINCT FROM NEW.can_publish_announcements
  )
  EXECUTE FUNCTION public.notify_profile_admin_action();

DO $notification_list_preflight$
DECLARE
  v_list_definition text;
  v_event_details_definition text;
  v_event_summary_definition text;
BEGIN
  IF pg_catalog.to_regprocedure('public.list_notifications_v1()') IS NULL THEN
    RAISE EXCEPTION
      'public.list_notifications_v1() must exist; this patch will not replace it.';
  END IF;
  IF pg_catalog.to_regprocedure(
    'public.get_notification_event_details_v1(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION
      'public.get_notification_event_details_v1(uuid) must exist; inspect the installed event privacy patch.';
  END IF;
  IF pg_catalog.to_regprocedure(
    'public.event_notification_summary(uuid,text,boolean)'
  ) IS NULL THEN
    RAISE EXCEPTION
      'public.event_notification_summary(uuid,text,boolean) must exist; inspect the installed event privacy patch.';
  END IF;
  SELECT pg_catalog.pg_get_functiondef(
    'public.event_notification_summary(uuid,text,boolean)'::regprocedure
  )
    INTO v_event_summary_definition;
  IF pg_catalog.strpos(v_event_summary_definition, 'assignedWorkers') = 0
     OR pg_catalog.strpos(v_event_summary_definition, 'reminderEnabled') = 0
     OR pg_catalog.strpos(v_event_summary_definition, 'reminderValue') = 0
     OR pg_catalog.strpos(v_event_summary_definition, 'reminderUnit') = 0
     OR pg_catalog.strpos(v_event_summary_definition, 'location') > 0 THEN
    RAISE EXCEPTION
      'The installed event_notification_summary(uuid,text,boolean) does not match the reviewed private event-detail shape; inspect it before applying this patch.';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.list_notifications_v1()'::regprocedure
  )
    INTO v_list_definition;
  IF pg_catalog.strpos(v_list_definition, 'can_read_event') = 0
     OR pg_catalog.strpos(v_list_definition, 'IS NOT TRUE') = 0
     OR pg_catalog.strpos(v_list_definition, 'cancelled') = 0 THEN
    RAISE EXCEPTION
      'The installed list_notifications_v1() does not match the reviewed event-privacy shape; inspect it before applying this patch.';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.get_notification_event_details_v1(uuid)'::regprocedure
  )
    INTO v_event_details_definition;
  IF pg_catalog.strpos(v_event_details_definition, 'can_read_event') = 0
     OR pg_catalog.strpos(v_event_details_definition, 'cancelled') = 0
     OR pg_catalog.strpos(v_event_details_definition, 'deleted') = 0 THEN
    RAISE EXCEPTION
      'The installed get_notification_event_details_v1(uuid) does not match the reviewed event-privacy shape; inspect it before applying this patch.';
  END IF;
END;
$notification_list_preflight$;

CREATE OR REPLACE FUNCTION public.get_notification_event_details_v1(
  p_notification_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_summary jsonb;
  v_event_id uuid;
  v_event_status text;
  v_notification_kind text;
BEGIN
  IF auth.uid() IS NULL OR p_notification_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  PERFORM profile.id
    FROM public.profiles AS profile
   WHERE profile.id = (SELECT auth.uid())
   FOR SHARE;
  IF NOT FOUND THEN
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
   WHERE event.id = v_event_id
   FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'deleted'
    );
  END IF;

  IF v_event_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'cancelled'
    );
  END IF;

  IF v_event_status IS DISTINCT FROM 'confirmed' THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'not_authorized'
    );
  END IF;

  PERFORM participant.user_id
    FROM public.event_participants AS participant
   WHERE participant.event_id = v_event_id
   FOR SHARE;

  IF public.can_read_event(v_event_id) IS TRUE THEN
    RETURN public.event_notification_summary(
      v_event_id,
      v_event_status,
      true
    ) -> 'event';
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

ALTER FUNCTION public.get_notification_event_details_v1(uuid)
  OWNER TO postgres;

ALTER TABLE public.app_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_notifications
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_notifications_v1()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.list_notifications_admin_scope_v1()
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
DECLARE
  v_is_administrator boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  SELECT COALESCE(profile.role::text = 'administrador', false)
    INTO v_is_administrator
    FROM public.profiles AS profile
   WHERE profile.id = (SELECT auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  RETURN QUERY
  SELECT notification.id,
         notification.recipient_id,
         notification.kind,
         CASE
           WHEN v_is_administrator IS NOT TRUE
            AND notification.kind IN (
              'resource_created', 'resource_updated', 'resource_deleted',
              'announcement_created', 'announcement_updated', 'announcement_deleted',
              'event_admin_created', 'event_admin_updated',
              'event_admin_cancelled', 'event_admin_deleted',
              'admin_role_changed', 'admin_permission_changed'
            )
           THEN 'Aviso administrativo'
           ELSE notification.title
         END,
         CASE
           WHEN v_is_administrator IS NOT TRUE
            AND notification.kind IN (
              'resource_created', 'resource_updated', 'resource_deleted',
              'announcement_created', 'announcement_updated', 'announcement_deleted',
              'event_admin_created', 'event_admin_updated',
              'event_admin_cancelled', 'event_admin_deleted',
              'admin_role_changed', 'admin_permission_changed'
            )
           THEN 'Aviso administrativo no disponible para esta cuenta.'
           WHEN stored_notification.summary ? 'event'
            AND (
              event.id IS NULL
              OR event.status = 'cancelled'
              OR (
                event.status IS DISTINCT FROM 'confirmed'
                OR public.can_read_event(event.id) IS NOT TRUE
              )
              OR (
                v_is_administrator IS NOT TRUE
                AND notification.kind IN (
                  'event_admin_created', 'event_admin_updated',
                  'event_admin_cancelled', 'event_admin_deleted'
                )
              )
            )
           THEN 'La información de este evento ya no está disponible para su consulta.'
           ELSE notification.message
         END,
         CASE
           WHEN stored_notification.summary ? 'event'
            AND (
              event.id IS NULL
              OR event.status = 'cancelled'
              OR event.status IS DISTINCT FROM 'confirmed'
              OR public.can_read_event(event.id) IS NOT TRUE
              OR (
                v_is_administrator IS NOT TRUE
                AND notification.kind IN (
                  'event_admin_created', 'event_admin_updated',
                  'event_admin_cancelled', 'event_admin_deleted'
                )
              )
            )
           THEN jsonb_build_object(
             'eventAvailability',
             CASE
               WHEN event.id IS NULL THEN 'deleted'
               WHEN event.status = 'cancelled' THEN 'cancelled'
               WHEN v_is_administrator IS NOT TRUE
                AND notification.kind IN (
                  'event_admin_created', 'event_admin_updated',
                  'event_admin_cancelled', 'event_admin_deleted'
                )
               THEN CASE notification.kind
                 WHEN 'event_admin_cancelled' THEN 'cancelled'
                 WHEN 'event_admin_deleted' THEN 'deleted'
                 ELSE 'unavailable'
               END
               WHEN notification.kind IN ('event_unassigned', 'event_cancelled')
                 THEN 'unassigned'
               ELSE 'unavailable'
             END
           ) || CASE
             WHEN v_is_administrator IS NOT TRUE
              AND notification.kind IN (
                'event_admin_created', 'event_admin_updated',
                'event_admin_cancelled', 'event_admin_deleted'
              )
             THEN '{}'::jsonb
             ELSE jsonb_build_object(
               'eventId',
               COALESCE(
                 event.id::text,
                 stored_notification.summary #>> '{event,id}'
               )
             )
           END
           WHEN v_is_administrator IS NOT TRUE
            AND notification.kind IN (
              'resource_created', 'resource_updated', 'resource_deleted',
              'announcement_created', 'announcement_updated', 'announcement_deleted',
              'admin_role_changed', 'admin_permission_changed'
            )
           THEN '{}'::jsonb
           ELSE notification.summary
         END,
         notification.created_at,
         notification.read_at
    FROM public.list_notifications_v1() AS notification
    JOIN public.app_notifications AS stored_notification
      ON stored_notification.id = notification.id
     AND stored_notification.recipient_id = (SELECT auth.uid())
     AND stored_notification.deleted_at IS NULL
    LEFT JOIN public.events AS event
      ON event.id = (
        stored_notification.summary -> 'event' ->> 'id'
      )::uuid;
END;
$function$;

ALTER FUNCTION public.list_notifications_admin_scope_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_notifications_admin_scope_v1()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_notifications_admin_scope_v1()
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_notification_event_details_v1(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_notification_admin_scope_event_details_v1(
  p_notification_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_is_administrator boolean;
  v_notification_kind text;
  v_summary jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_notification_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  SELECT COALESCE(profile.role::text = 'administrador', false)
    INTO v_is_administrator
    FROM public.profiles AS profile
   WHERE profile.id = (SELECT auth.uid())
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  SELECT notification.kind, notification.summary
    INTO v_notification_kind, v_summary
    FROM public.app_notifications AS notification
   WHERE notification.id = p_notification_id
     AND notification.recipient_id = (SELECT auth.uid())
     AND notification.deleted_at IS NULL;
  IF NOT FOUND OR NOT (v_summary ? 'event') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;

  IF v_is_administrator IS NOT TRUE
     AND v_notification_kind IN (
       'event_admin_created', 'event_admin_updated',
       'event_admin_cancelled', 'event_admin_deleted'
     ) THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'not_authorized'
    );
  END IF;

  RETURN public.get_notification_event_details_v1(p_notification_id);
END;
$function$;

ALTER FUNCTION public.get_notification_admin_scope_event_details_v1(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_notification_admin_scope_event_details_v1(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_notification_admin_scope_event_details_v1(uuid)
  TO authenticated;

COMMIT;
