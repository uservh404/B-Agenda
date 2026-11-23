-- Roll back only the publication DELETE flag for AgendaJuventud ORIGINAL.
-- Other publish flags, puballtables, and table membership are preserved.
-- If the publication scope changed since installation, review the notices:
-- this rollback still restores DELETE for the current scope after acknowledgement.
BEGIN;

DO $rollback$
DECLARE
  v_publication pg_catalog.pg_publication%ROWTYPE;
  v_publish_options text[] := ARRAY[]::text[];
  v_missing_tables text;
  v_additional_tables text;
  v_delete_event_risk_acknowledged boolean := false;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Run only in ORIGINAL database postgres as postgres.';
  END IF;

  SELECT publication.*
    INTO v_publication
    FROM pg_catalog.pg_publication AS publication
   WHERE publication.pubname = 'supabase_realtime';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publication supabase_realtime is missing.';
  END IF;

  IF NOT v_delete_event_risk_acknowledged THEN
    RAISE EXCEPTION
      'Review current publication scope and flags: rollback enables DELETE for every current member. Then explicitly enable v_delete_event_risk_acknowledged.';
  END IF;

  SELECT pg_catalog.string_agg(expected.tablename, ', ' ORDER BY expected.tablename)
    INTO v_missing_tables
    FROM (VALUES
      ('public', 'announcement_change_signals'),
      ('public', 'event_sync_changes'),
      ('public', 'notification_change_signals'),
      ('public', 'resource_change_signals')
    ) AS expected(schemaname, tablename)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_publication_tables AS published
      WHERE published.pubname = 'supabase_realtime'
        AND published.schemaname = expected.schemaname
        AND published.tablename = expected.tablename
   );

  SELECT pg_catalog.string_agg(
           pg_catalog.format('%I.%I', published.schemaname, published.tablename),
           ', ' ORDER BY published.schemaname, published.tablename
         )
    INTO v_additional_tables
    FROM pg_catalog.pg_publication_tables AS published
   WHERE published.pubname = 'supabase_realtime'
     AND NOT EXISTS (
       SELECT 1
         FROM (VALUES
           ('public', 'announcement_change_signals'),
           ('public', 'event_sync_changes'),
           ('public', 'notification_change_signals'),
           ('public', 'resource_change_signals')
         ) AS expected(schemaname, tablename)
        WHERE expected.schemaname = published.schemaname
          AND expected.tablename = published.tablename
     );

  IF v_publication.puballtables
     OR v_missing_tables IS NOT NULL
     OR v_additional_tables IS NOT NULL THEN
    RAISE NOTICE
      'Publication scope differs from the confirmed baseline: puballtables=%, missing=[%], additional=[%]. Review this broader or altered scope before accepting rollback.',
      v_publication.puballtables,
      COALESCE(v_missing_tables, 'none'),
      COALESCE(v_additional_tables, 'none');
  END IF;

  IF NOT v_publication.pubdelete THEN
    IF v_publication.pubinsert THEN
      v_publish_options := pg_catalog.array_append(v_publish_options, 'insert');
    END IF;
    IF v_publication.pubupdate THEN
      v_publish_options := pg_catalog.array_append(v_publish_options, 'update');
    END IF;
    v_publish_options := pg_catalog.array_append(v_publish_options, 'delete');
    IF v_publication.pubtruncate THEN
      v_publish_options := pg_catalog.array_append(v_publish_options, 'truncate');
    END IF;

    EXECUTE pg_catalog.format(
      'ALTER PUBLICATION %I SET (publish = %L)',
      v_publication.pubname,
      pg_catalog.array_to_string(v_publish_options, ', ')
    );
  ELSE
    RAISE NOTICE 'DELETE publication is already enabled; no publication settings were changed.';
  END IF;
END;
$rollback$;

COMMIT;
