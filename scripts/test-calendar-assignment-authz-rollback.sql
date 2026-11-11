-- Controlled authorization check for Supabase SQL Editor.
-- Replace both UUID placeholders with real public.profiles.id values.
-- Run the entire script in one execution. Do not remove the final ROLLBACK.
-- The SQL Editor role must be able to read public.profiles, inspect the event
-- tables, and SET LOCAL ROLE authenticated.

BEGIN;

-- Supply real IDs; these values are verified before the test RPC is called.
SELECT
  set_config(
    'app.authz_test_actor_id',
    'REPLACE_WITH_REAL_EMPLOYEE_UUID',
    true
  ),
  set_config(
    'app.authz_test_participant_id',
    'REPLACE_WITH_REAL_OTHER_PROFILE_UUID',
    true
  );

-- Read-only preflight: validate both profiles and the employee's exact permission.
DO $preflight$
DECLARE
  v_actor_id uuid;
  v_participant_id uuid;
  v_actor_role text;
  v_participant_role text;
  v_can_assign boolean;
  v_identifier_collision boolean;
  v_error text;
  v_event_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.authz_test_event_id', v_event_id::text, true);
  PERFORM set_config('app.authz_test_operation_id', v_operation_id::text, true);

  BEGIN
    v_actor_id := current_setting('app.authz_test_actor_id')::uuid;
    v_participant_id := current_setting('app.authz_test_participant_id')::uuid;

    IF v_actor_id = v_participant_id THEN
      RAISE EXCEPTION 'Employee and participant UUIDs must be different';
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.events WHERE id = v_event_id
      UNION ALL
      SELECT 1 FROM public.event_operation_receipts
      WHERE operation_id = v_operation_id OR event_id = v_event_id
      UNION ALL
      SELECT 1 FROM public.event_sync_conflicts
      WHERE operation_id = v_operation_id OR event_id = v_event_id
    )
    INTO v_identifier_collision;

    IF v_identifier_collision THEN
      RAISE EXCEPTION 'Generated test UUID unexpectedly collides with existing calendar data';
    END IF;

    SELECT profile.role::text, profile.can_assign_events
    INTO v_actor_role, v_can_assign
    FROM public.profiles AS profile
    WHERE profile.id = v_actor_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Employee profile UUID was not found';
    END IF;

    SELECT profile.role::text
    INTO v_participant_role
    FROM public.profiles AS profile
    WHERE profile.id = v_participant_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Participant profile UUID was not found';
    END IF;
    IF v_participant_role NOT IN ('administrador', 'empleado') THEN
      RAISE EXCEPTION 'Participant profile does not have an assignable user role';
    END IF;

    IF v_actor_role <> 'empleado' OR v_can_assign IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Actor must be role empleado with can_assign_events = false';
    END IF;

    PERFORM set_config('app.authz_test_preflight', 'ok', true);
    PERFORM set_config(
      'app.authz_test_preflight_detail',
      'Employee profile and distinct participant profile verified',
      true
    );
  EXCEPTION
    WHEN OTHERS THEN
      v_error := SQLSTATE || ': ' || SQLERRM;
      PERFORM set_config('app.authz_test_preflight', 'failed', true);
      PERFORM set_config('app.authz_test_preflight_detail', v_error, true);
  END;
END;
$preflight$;

SELECT
  current_user AS sql_editor_role_before_simulation,
  current_setting('app.authz_test_preflight', true) AS preflight_status,
  current_setting('app.authz_test_preflight_detail', true) AS preflight_detail,
  current_setting('app.authz_test_event_id', true) AS generated_event_id,
  current_setting('app.authz_test_operation_id', true) AS generated_operation_id;

-- Simulate both the PostgreSQL role and PostgREST JWT claims transaction-locally.
SET LOCAL ROLE authenticated;

SELECT
  set_config(
    'request.jwt.claim.sub',
    current_setting('app.authz_test_actor_id'),
    true
  ),
  set_config('request.jwt.claim.role', 'authenticated', true),
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', current_setting('app.authz_test_actor_id'),
      'role', 'authenticated',
      'aud', 'authenticated'
    )::text,
    true
  );

-- Catch test failures so the script can continue to its final ROLLBACK.
DO $authorization_test$
DECLARE
  v_actor_id uuid;
  v_participant_id uuid;
  v_event_id uuid := current_setting('app.authz_test_event_id')::uuid;
  v_operation_id uuid := current_setting('app.authz_test_operation_id')::uuid;
  v_actor_role text;
  v_can_assign boolean;
  v_response jsonb;
  v_error text;
BEGIN
  BEGIN
    IF current_setting('app.authz_test_preflight', true) IS DISTINCT FROM 'ok' THEN
      RAISE EXCEPTION 'Preflight failed: %',
        current_setting('app.authz_test_preflight_detail', true);
    END IF;

    v_actor_id := current_setting('app.authz_test_actor_id')::uuid;
    v_participant_id := current_setting('app.authz_test_participant_id')::uuid;

    IF current_user <> 'authenticated' THEN
      RAISE EXCEPTION 'Current PostgreSQL role is %, expected authenticated', current_user;
    END IF;
    IF auth.uid() IS DISTINCT FROM v_actor_id THEN
      RAISE EXCEPTION 'auth.uid() does not match the configured employee UUID';
    END IF;

    SELECT profile.role::text, profile.can_assign_events
    INTO v_actor_role, v_can_assign
    FROM public.profiles AS profile
    WHERE profile.id = auth.uid();

    IF NOT FOUND
       OR v_actor_role <> 'empleado'
       OR v_can_assign IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Authenticated profile is not the expected unauthorized employee';
    END IF;

    v_response := public.save_event(
      p_operation_id := v_operation_id,
      p_event_id := v_event_id,
      p_expected_version := 0,
      p_title := 'Temporal authorization rollback check',
      p_description := 'Transaction-only permission test; expected to be rolled back.',
      p_category := 'Authorization check',
      p_event_date := current_date + 45,
      p_start_time := TIME '10:00',
      p_end_time := TIME '10:30',
      p_participant_ids := ARRAY[v_participant_id]::uuid[],
      p_reminder_enabled := false,
      p_reminder_value := NULL,
      p_reminder_unit := NULL,
      p_resolves_operation_id := NULL
    );

    PERFORM set_config(
      'app.authz_test_response_status',
      COALESCE(v_response ->> 'status', ''),
      true
    );
    PERFORM set_config(
      'app.authz_test_response_code',
      COALESCE(v_response ->> 'code', ''),
      true
    );
    PERFORM set_config('app.authz_test_error', '', true);
    PERFORM set_config('app.authz_test_response', v_response::text, true);
  EXCEPTION
    WHEN OTHERS THEN
      v_error := SQLSTATE || ': ' || SQLERRM;
      PERFORM set_config('app.authz_test_response_status', '', true);
      PERFORM set_config('app.authz_test_response_code', '', true);
      PERFORM set_config('app.authz_test_error', v_error, true);
      PERFORM set_config('app.authz_test_response', '', true);
  END;
END;
$authorization_test$;

-- Restore the SQL Editor role, clear simulated claims, then inspect transactional rows.
RESET ROLE;

SELECT
  set_config('request.jwt.claim.sub', '', true),
  set_config('request.jwt.claim.role', '', true),
  set_config('request.jwt.claims', '', true);

DO $inspect_transaction_rows$
DECLARE
  v_event_id uuid := current_setting('app.authz_test_event_id')::uuid;
  v_operation_id uuid := current_setting('app.authz_test_operation_id')::uuid;
  v_event_count integer;
  v_participant_count integer;
  v_reservation_count integer;
  v_receipt_count integer;
  v_error text;
BEGIN
  BEGIN
    SELECT count(*)::integer INTO v_event_count
    FROM public.events AS event
    WHERE event.id = v_event_id;

    SELECT count(*)::integer INTO v_participant_count
    FROM public.event_participants AS participant
    WHERE participant.event_id = v_event_id;

    SELECT count(*)::integer INTO v_reservation_count
    FROM public.event_reservations AS reservation
    WHERE reservation.event_id = v_event_id;

    SELECT count(*)::integer INTO v_receipt_count
    FROM public.event_operation_receipts AS receipt
    WHERE receipt.operation_id = v_operation_id;

    PERFORM set_config('app.authz_test_event_count', v_event_count::text, true);
    PERFORM set_config('app.authz_test_participant_count', v_participant_count::text, true);
    PERFORM set_config('app.authz_test_reservation_count', v_reservation_count::text, true);
    PERFORM set_config('app.authz_test_receipt_count', v_receipt_count::text, true);
    PERFORM set_config('app.authz_test_inspection_error', '', true);
  EXCEPTION
    WHEN OTHERS THEN
      v_error := SQLSTATE || ': ' || SQLERRM;
      PERFORM set_config('app.authz_test_event_count', '', true);
      PERFORM set_config('app.authz_test_participant_count', '', true);
      PERFORM set_config('app.authz_test_reservation_count', '', true);
      PERFORM set_config('app.authz_test_receipt_count', '', true);
      PERFORM set_config('app.authz_test_inspection_error', v_error, true);
  END;
END;
$inspect_transaction_rows$;

SELECT
  current_setting('app.authz_test_preflight', true) AS preflight_status,
  current_setting('app.authz_test_response_status', true) AS response_status,
  current_setting('app.authz_test_response_code', true) AS response_code,
  current_setting('app.authz_test_response', true) AS full_save_event_response,
  current_setting('app.authz_test_error', true) AS execution_error,
  NULLIF(current_setting('app.authz_test_event_count', true), '')::integer AS event_rows_before_rollback,
  NULLIF(current_setting('app.authz_test_participant_count', true), '')::integer AS participant_rows_before_rollback,
  NULLIF(current_setting('app.authz_test_reservation_count', true), '')::integer AS reservation_rows_before_rollback,
  NULLIF(current_setting('app.authz_test_receipt_count', true), '')::integer AS operation_receipts_before_rollback,
  current_setting('app.authz_test_inspection_error', true) AS inspection_error,
  COALESCE((
    current_setting('app.authz_test_preflight', true) = 'ok'
    AND current_setting('app.authz_test_response_status', true) = 'rejected'
    AND current_setting('app.authz_test_response_code', true) = 'not_authorized'
    AND COALESCE(current_setting('app.authz_test_error', true), '') = ''
    AND current_setting('app.authz_test_event_count', true) = '0'
    AND current_setting('app.authz_test_participant_count', true) = '0'
    AND current_setting('app.authz_test_reservation_count', true) = '0'
    AND COALESCE(current_setting('app.authz_test_inspection_error', true), '') = ''
  ), false) AS authorization_test_passed_before_rollback;

-- Mandatory: removes the operation receipt and any test rows created in this transaction.
ROLLBACK;
