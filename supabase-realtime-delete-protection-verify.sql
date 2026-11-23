-- Read-only consolidated verifier for AgendaJuventud ORIGINAL.
-- Catalog PASS does not prove that existing Realtime connections have closed.
-- This file contains one SELECT and does not modify database state.
WITH
publication AS (
  SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
  FROM pg_catalog.pg_publication
  WHERE pubname = 'supabase_realtime'
),
expected_tables(schemaname, tablename) AS (
  VALUES
    ('public', 'announcement_change_signals'),
    ('public', 'event_sync_changes'),
    ('public', 'notification_change_signals'),
    ('public', 'resource_change_signals')
),
actual_tables AS (
  SELECT DISTINCT schemaname, tablename
  FROM pg_catalog.pg_publication_tables
  WHERE pubname = 'supabase_realtime'
),
membership_summary AS (
  SELECT
    (
      SELECT pg_catalog.string_agg(
        expected.schemaname || '.' || expected.tablename,
        ', ' ORDER BY expected.schemaname, expected.tablename
      )
      FROM expected_tables AS expected
      WHERE NOT EXISTS (
        SELECT 1
        FROM actual_tables AS actual
        WHERE actual.schemaname = expected.schemaname
          AND actual.tablename = expected.tablename
      )
    ) AS missing_tables,
    (
      SELECT pg_catalog.string_agg(
        actual.schemaname || '.' || actual.tablename,
        ', ' ORDER BY actual.schemaname, actual.tablename
      )
      FROM actual_tables AS actual
      WHERE NOT EXISTS (
        SELECT 1
        FROM expected_tables AS expected
        WHERE expected.schemaname = actual.schemaname
          AND expected.tablename = actual.tablename
      )
    ) AS additional_tables
),
catalog_checks(check_name, status, details) AS (
  SELECT
    'Database target',
    CASE WHEN current_database() = 'postgres' THEN 'PASS' ELSE 'FAIL' END,
    'current_database=' || current_database()

  UNION ALL

  SELECT
    'SQL execution role',
    CASE WHEN current_user = 'postgres' THEN 'PASS' ELSE 'FAIL' END,
    'current_user=' || current_user

  UNION ALL

  SELECT
    'Realtime publication exists',
    CASE WHEN publication.pubname IS NULL THEN 'MISSING' ELSE 'PASS' END,
    COALESCE('publication=' || publication.pubname, 'supabase_realtime is missing')
  FROM (VALUES (1)) AS seed(dummy)
  LEFT JOIN publication ON true

  UNION ALL

  SELECT
    'Realtime puballtables is false',
    CASE
      WHEN publication.pubname IS NULL THEN 'MISSING'
      WHEN publication.puballtables IS FALSE THEN 'PASS'
      ELSE 'FAIL'
    END,
    COALESCE('puballtables=' || publication.puballtables::text, 'publication is missing')
  FROM (VALUES (1)) AS seed(dummy)
  LEFT JOIN publication ON true

  UNION ALL

  SELECT
    setting.check_name,
    CASE
      WHEN publication.pubname IS NULL THEN 'MISSING'
      WHEN setting.actual_value IS NOT DISTINCT FROM setting.expected_value THEN 'PASS'
      ELSE 'FAIL'
    END,
    COALESCE(
      'actual=' || setting.actual_value::text
        || '; expected=' || setting.expected_value::text,
      'publication is missing'
    )
  FROM (VALUES (1)) AS seed(dummy)
  LEFT JOIN publication ON true
  CROSS JOIN LATERAL (
    VALUES
      ('Realtime INSERT remains enabled', publication.pubinsert, true),
      ('Realtime UPDATE remains enabled', publication.pubupdate, true),
      ('Realtime DELETE is disabled', publication.pubdelete, false),
      ('Realtime TRUNCATE remains enabled', publication.pubtruncate, true)
  ) AS setting(check_name, actual_value, expected_value)

  UNION ALL

  SELECT
    'Realtime membership: ' || expected.schemaname || '.' || expected.tablename,
    CASE
      WHEN publication.pubname IS NULL THEN 'MISSING'
      WHEN actual.tablename IS NULL THEN 'MISSING'
      ELSE 'PASS'
    END,
    'publication=supabase_realtime'
  FROM expected_tables AS expected
  CROSS JOIN (VALUES (1)) AS seed(dummy)
  LEFT JOIN publication ON true
  LEFT JOIN actual_tables AS actual
    ON actual.schemaname = expected.schemaname
   AND actual.tablename = expected.tablename

  UNION ALL

  SELECT
    'Realtime membership has no additional tables',
    CASE
      WHEN publication.pubname IS NULL THEN 'MISSING'
      WHEN membership.additional_tables IS NULL THEN 'PASS'
      ELSE 'FAIL'
    END,
    'additional=' || COALESCE(membership.additional_tables, 'none')
  FROM (VALUES (1)) AS seed(dummy)
  LEFT JOIN publication ON true
  CROSS JOIN membership_summary AS membership

  UNION ALL

  SELECT
    'Realtime membership is exactly the four confirmed tables',
    CASE
      WHEN publication.pubname IS NULL THEN 'MISSING'
      WHEN membership.missing_tables IS NULL
       AND membership.additional_tables IS NULL THEN 'PASS'
      ELSE 'FAIL'
    END,
    'missing=' || COALESCE(membership.missing_tables, 'none')
      || '; additional=' || COALESCE(membership.additional_tables, 'none')
  FROM (VALUES (1)) AS seed(dummy)
  LEFT JOIN publication ON true
  CROSS JOIN membership_summary AS membership
),
service_checks(check_name, status, details) AS (
  VALUES
    (
      'Service test: existing Realtime connections',
      'MISSING',
      'Confirm suspended sessions no longer receive DELETE after the service observes the publication change or reconnects.'
    ),
    (
      'Service test: INSERT and UPDATE delivery',
      'MISSING',
      'Confirm resource, announcement, calendar, and notification INSERT/UPDATE listeners still refresh as expected.'
    ),
    (
      'Service test: external DELETE consumers',
      'MISSING',
      'Review and validate consumers outside this repository.'
    )
),
all_checks(check_name, status, details) AS (
  SELECT check_name, status, details FROM catalog_checks
  UNION ALL
  SELECT check_name, status, details FROM service_checks
)
SELECT status, check_name, details
FROM all_checks
ORDER BY
  CASE status WHEN 'FAIL' THEN 0 WHEN 'MISSING' THEN 1 ELSE 2 END,
  check_name;
