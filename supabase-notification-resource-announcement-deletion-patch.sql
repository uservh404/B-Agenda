BEGIN;

DO $resource_announcement_deletion_preflight$
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.app_notifications') IS NULL
     OR pg_catalog.to_regclass('public.resources') IS NULL
     OR pg_catalog.to_regclass('public.announcements') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.list_notifications_admin_scope_v1()'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Run as postgres after the notifications, resources, announcements, and administrative notification patches are installed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.app_notifications'::regclass
       AND attname = 'dedupe_key'
       AND atttypid = 'text'::regtype
       AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.resources'::regclass
       AND attname = 'id'
       AND atttypid = 'uuid'::regtype
       AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.resources'::regclass
       AND attname = 'deleted_at'
       AND atttypid = 'timestamptz'::regtype
       AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.announcements'::regclass
       AND attname = 'id'
       AND atttypid = 'uuid'::regtype
       AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.announcements'::regclass
       AND attname = 'deleted_at'
       AND atttypid = 'timestamptz'::regtype
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'Expected UUID entity IDs, deleted_at columns, and app_notifications.dedupe_key; inspect the installed schema.';
  END IF;
END;
$resource_announcement_deletion_preflight$;

CREATE OR REPLACE FUNCTION public.list_notifications_resource_announcement_scope_v1()
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
  WITH listed AS (
    SELECT notification.id,
           notification.recipient_id,
           notification.kind,
           notification.title,
           notification.message,
           notification.summary,
           notification.created_at,
           notification.read_at,
           stored_notification.dedupe_key
      FROM public.list_notifications_admin_scope_v1() AS notification
      JOIN public.app_notifications AS stored_notification
        ON stored_notification.id = notification.id
       AND stored_notification.recipient_id = (SELECT auth.uid())
       AND stored_notification.deleted_at IS NULL
  ),
  identified AS (
    SELECT listed.*,
           (
             listed.kind IN (
               'resource_created', 'resource_updated', 'resource_deleted',
               'announcement_created', 'announcement_updated', 'announcement_deleted'
             )
             AND listed.title = 'Aviso administrativo'
             AND listed.message = 'Aviso administrativo no disponible para esta cuenta.'
             AND listed.summary = '{}'::jsonb
           ) AS is_admin_redacted,
           CASE
             WHEN listed.kind IN (
               'resource_created', 'resource_updated', 'resource_deleted'
             )
              AND listed.dedupe_key ~*
                '^resource_(created|updated|deleted):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
             THEN pg_catalog.split_part(listed.dedupe_key, ':', 2)::uuid
             ELSE NULL
           END AS resource_id,
           CASE
             WHEN listed.kind IN (
               'announcement_created', 'announcement_updated', 'announcement_deleted'
             )
              AND listed.dedupe_key ~*
                '^announcement_(created|updated|deleted):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
             THEN pg_catalog.split_part(listed.dedupe_key, ':', 2)::uuid
             ELSE NULL
           END AS announcement_id
      FROM listed
  )
  SELECT identified.id,
         identified.recipient_id,
         identified.kind,
         CASE
           WHEN identified.is_admin_redacted THEN identified.title
           WHEN identified.kind IN (
             'resource_created', 'resource_updated', 'resource_deleted'
           )
            AND (
              identified.resource_id IS NULL
              OR resource.id IS NULL
              OR resource.deleted_at IS NOT NULL
            )
           THEN 'Aviso de recurso'
           WHEN identified.kind IN (
             'announcement_created', 'announcement_updated', 'announcement_deleted'
           )
            AND (
              identified.announcement_id IS NULL
              OR announcement.id IS NULL
              OR announcement.deleted_at IS NOT NULL
            )
           THEN 'Aviso de anuncio'
           ELSE identified.title
         END,
         CASE
           WHEN identified.is_admin_redacted THEN identified.message
           WHEN identified.kind IN (
             'resource_created', 'resource_updated', 'resource_deleted'
           )
            AND identified.resource_id IS NULL
           THEN 'Información del recurso no disponible'
           WHEN identified.kind IN (
             'resource_created', 'resource_updated', 'resource_deleted'
           )
            AND (
              resource.id IS NULL
              OR resource.deleted_at IS NOT NULL
            )
           THEN 'Este recurso fue eliminado'
           WHEN identified.kind IN (
             'announcement_created', 'announcement_updated', 'announcement_deleted'
           )
            AND identified.announcement_id IS NULL
           THEN 'Información del anuncio no disponible'
           WHEN identified.kind IN (
             'announcement_created', 'announcement_updated', 'announcement_deleted'
           )
            AND (
              announcement.id IS NULL
              OR announcement.deleted_at IS NOT NULL
            )
           THEN 'Este anuncio fue eliminado'
           ELSE identified.message
         END,
         CASE
           WHEN identified.is_admin_redacted THEN identified.summary
           WHEN identified.kind IN (
             'resource_created', 'resource_updated', 'resource_deleted'
           )
            AND identified.resource_id IS NULL
           THEN pg_catalog.jsonb_build_object(
             'resourceAvailability', 'unavailable'
           )
           WHEN identified.kind IN (
             'resource_created', 'resource_updated', 'resource_deleted'
           )
            AND (
              resource.id IS NULL
              OR resource.deleted_at IS NOT NULL
            )
           THEN pg_catalog.jsonb_build_object(
             'resourceAvailability', 'deleted'
           )
           WHEN identified.kind IN (
             'announcement_created', 'announcement_updated', 'announcement_deleted'
           )
            AND identified.announcement_id IS NULL
           THEN pg_catalog.jsonb_build_object(
             'announcementAvailability', 'unavailable'
           )
           WHEN identified.kind IN (
             'announcement_created', 'announcement_updated', 'announcement_deleted'
           )
            AND (
              announcement.id IS NULL
              OR announcement.deleted_at IS NOT NULL
            )
           THEN pg_catalog.jsonb_build_object(
             'announcementAvailability', 'deleted'
           )
           ELSE identified.summary
         END,
         identified.created_at,
         identified.read_at
    FROM identified
    LEFT JOIN public.resources AS resource
      ON resource.id = identified.resource_id
    LEFT JOIN public.announcements AS announcement
      ON announcement.id = identified.announcement_id
   ORDER BY identified.created_at DESC, identified.id;
END;
$function$;

ALTER FUNCTION public.list_notifications_resource_announcement_scope_v1()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_notifications_resource_announcement_scope_v1()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_notifications_resource_announcement_scope_v1()
  TO authenticated;
REVOKE ALL ON FUNCTION public.list_notifications_admin_scope_v1()
  FROM PUBLIC, anon, authenticated;

COMMIT;
