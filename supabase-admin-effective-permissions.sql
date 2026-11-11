BEGIN;

DO $permission_patch$
DECLARE
  v_function_definition text;
  v_previous_check constant text :=
    'SELECT COALESCE(p.can_assign_events, false)';
  v_effective_check constant text :=
    'SELECT COALESCE(p.role::text = ''administrador'', false) '
    || 'OR COALESCE(p.can_assign_events, false)';
  v_occurrences integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.save_event(uuid, uuid, bigint, text, text, text, date, time without time zone, time without time zone, uuid[], boolean, integer, text, uuid)'::regprocedure
  )
  INTO v_function_definition;

  v_occurrences :=
    (
      pg_catalog.length(v_function_definition)
      - pg_catalog.length(
          pg_catalog.replace(v_function_definition, v_previous_check, '')
        )
    ) / pg_catalog.length(v_previous_check);

  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one can_assign_events check in public.save_event; found %',
      v_occurrences;
  END IF;

  v_function_definition := pg_catalog.replace(
    v_function_definition,
    v_previous_check,
    v_effective_check
  );

  EXECUTE v_function_definition;
END;
$permission_patch$;

COMMIT;
