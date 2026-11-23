-- Apply only to AgendaJuventud ORIGINAL after reviewing every Realtime consumer.
-- Requires the confirmed baseline: four explicit public tables and all publish
-- flags enabled. The publication-wide DELETE flag affects every member table.
BEGIN;

DO $patch$
DECLARE
  v_publication pg_catalog.pg_publication%ROWTYPE;
  v_missing_tables text;
  v_additional_tables text;
  v_external_delete_consumers_reviewed boolean := false;
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

  IF NOT v_external_delete_consumers_reviewed THEN
    RAISE EXCEPTION
      'Review consumers of DELETE for every current publication member, then explicitly enable v_external_delete_consumers_reviewed.';
  END IF;

  IF v_publication.puballtables THEN
    RAISE EXCEPTION
      'Expected supabase_realtime.puballtables=false; refusing to change a FOR ALL TABLES publication.';
  END IF;

  IF v_publication.pubinsert IS NOT TRUE
     OR v_publication.pubupdate IS NOT TRUE
     OR v_publication.pubdelete IS NOT TRUE
     OR v_publication.pubtruncate IS NOT TRUE THEN
    RAISE EXCEPTION
      'Expected original publication flags insert/update/delete/truncate=true; found insert=%, update=%, delete=%, truncate=%.',
      v_publication.pubinsert,
      v_publication.pubupdate,
      v_publication.pubdelete,
      v_publication.pubtruncate;
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

  IF v_missing_tables IS NOT NULL OR v_additional_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'Expected exactly the four confirmed publication tables; missing=[%], additional=[%].',
      COALESCE(v_missing_tables, 'none'),
      COALESCE(v_additional_tables, 'none');
  END IF;

  EXECUTE
    'ALTER PUBLICATION supabase_realtime SET (publish = ''insert, update, truncate'')';
END;
$patch$;

COMMIT;
