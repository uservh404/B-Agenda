BEGIN;

DO $preflight$
DECLARE
  v_save_event_oid oid;
  v_save_event_is_definer boolean;
  v_save_event_return_type text;
  v_has_invalid_mode_state boolean;
  v_has_invalid_receipt_token boolean;
BEGIN
  IF pg_catalog.to_regclass('public.events') IS NULL THEN
    RAISE EXCEPTION 'Required table public.events does not exist.';
  END IF;

  IF pg_catalog.to_regclass('public.event_operation_receipts') IS NULL THEN
    RAISE EXCEPTION 'Required table public.event_operation_receipts does not exist.';
  END IF;

  IF EXISTS (
    SELECT required.column_name
    FROM pg_catalog.unnest(
      ARRAY['id', 'reminder_enabled', 'reminder_value', 'reminder_unit']::text[]
    ) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.events'::regclass
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION
      'public.events is missing columns required by the reminder patch; no changes were applied.';
  END IF;

  IF EXISTS (
    SELECT required.column_name
    FROM pg_catalog.unnest(
      ARRAY['operation_id', 'actor_id', 'event_id', 'operation_kind']::text[]
    ) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.event_operation_receipts'::regclass
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION
      'public.event_operation_receipts is missing columns required by the reminder patch; no changes were applied.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid = 'public.event_operation_receipts'::regclass
      AND constraint_info.contype IN ('p', 'u')
      AND constraint_info.conkey = ARRAY[(
        SELECT attribute.attnum::smallint
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.event_operation_receipts'::regclass
          AND attribute.attname = 'operation_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'event_operation_receipts must have a unique constraint on operation_id; no changes were applied.';
  END IF;

  v_save_event_oid := pg_catalog.to_regprocedure(
    'public.save_event(uuid,uuid,bigint,text,text,text,date,time without time zone,time without time zone,uuid[],boolean,integer,text,uuid)'
  );
  IF v_save_event_oid IS NULL THEN
    RAISE EXCEPTION 'Expected public.save_event signature was not found; no changes were applied.';
  END IF;

  SELECT p.prosecdef, pg_catalog.format_type(p.prorettype, NULL)
    INTO v_save_event_is_definer, v_save_event_return_type
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = v_save_event_oid;

  IF v_save_event_is_definer IS DISTINCT FROM true
     OR v_save_event_return_type IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION
      'public.save_event must remain SECURITY DEFINER and return jsonb; review the production definition before applying this patch.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'save_event_with_reminder_mode'
      AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure(
        'public.save_event_with_reminder_mode(uuid,uuid,bigint,text,text,text,date,time without time zone,time without time zone,uuid[],boolean,integer,text,uuid,text)'
      )
  ) THEN
    RAISE EXCEPTION
      'A different public.save_event_with_reminder_mode overload exists; review it before applying this patch.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.events'::regclass
      AND attribute.attname = 'reminder_mode'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) <> 'text'
  ) THEN
    RAISE EXCEPTION
      'public.events.reminder_mode exists with an incompatible type; no changes were applied.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.events'::regclass
      AND attribute.attname = 'reminder_mode'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attnotnull
  ) THEN
    RAISE EXCEPTION
      'public.events.reminder_mode must allow NULL to preserve legacy event behavior.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.events'::regclass
      AND attribute.attname = 'reminder_mode'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    EXECUTE $check$
      SELECT EXISTS (
        SELECT 1
        FROM public.events AS event
        WHERE event.reminder_mode IS NOT NULL
          AND NOT (
            (
              event.reminder_mode IN ('off', 'start')
              AND event.reminder_enabled IS FALSE
              AND event.reminder_value IS NULL
              AND event.reminder_unit IS NULL
            )
            OR (
              event.reminder_mode = 'anticipation'
              AND event.reminder_enabled IS TRUE
              AND event.reminder_value IS NOT NULL
              AND event.reminder_value > 0
              AND event.reminder_unit IS NOT NULL
              AND event.reminder_unit IN ('minutes', 'hours', 'days', 'weeks')
            )
          )
      )
    $check$ INTO v_has_invalid_mode_state;

    IF v_has_invalid_mode_state THEN
      RAISE EXCEPTION
        'Existing reminder_mode values contradict reminder_enabled/value/unit; resolve those rows before applying this patch.';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.event_operation_receipts'::regclass
      AND attribute.attname = 'reminder_mode_token'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    EXECUTE $check$
      SELECT EXISTS (
        SELECT 1
        FROM public.event_operation_receipts AS receipt
        WHERE receipt.reminder_mode_token IS NOT NULL
          AND receipt.reminder_mode_token NOT IN (
            'unbound', 'legacy', 'off', 'start', 'anticipation'
          )
      )
    $check$ INTO v_has_invalid_receipt_token;

    IF v_has_invalid_receipt_token THEN
      RAISE EXCEPTION
        'event_operation_receipts contains unknown reminder mode tokens; resolve them before applying this patch.';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.event_operation_receipts'::regclass
      AND attribute.attname = 'reminder_mode_token'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) <> 'text'
  ) THEN
    RAISE EXCEPTION
      'event_operation_receipts.reminder_mode_token exists with an incompatible type; no changes were applied.';
  END IF;
END;
$preflight$;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS reminder_mode text;

ALTER TABLE public.event_operation_receipts
  ADD COLUMN IF NOT EXISTS reminder_mode_token text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_reminder_mode_valid;

ALTER TABLE public.event_operation_receipts
  DROP CONSTRAINT IF EXISTS event_operation_receipts_reminder_mode_valid;

ALTER TABLE public.event_operation_receipts
  ALTER COLUMN reminder_mode_token SET DEFAULT 'unbound';

ALTER TABLE public.events
  ADD CONSTRAINT events_reminder_mode_valid
  CHECK (
    reminder_mode IS NULL
    OR (
      reminder_mode IN ('off', 'start')
      AND reminder_enabled IS FALSE
      AND reminder_value IS NULL
      AND reminder_unit IS NULL
    )
    OR (
      reminder_mode = 'anticipation'
      AND reminder_enabled IS TRUE
      AND reminder_value IS NOT NULL
      AND reminder_value > 0
      AND reminder_unit IS NOT NULL
      AND reminder_unit IN ('minutes', 'hours', 'days', 'weeks')
    )
  );

ALTER TABLE public.event_operation_receipts
  ADD CONSTRAINT event_operation_receipts_reminder_mode_valid
  CHECK (
    reminder_mode_token IS NULL
    OR reminder_mode_token IN ('unbound', 'legacy', 'off', 'start', 'anticipation')
  );

CREATE OR REPLACE FUNCTION public.apply_event_reminder_mode_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $trigger$
DECLARE
  v_context_event_id text :=
    NULLIF(pg_catalog.current_setting('agenda.reminder_mode_event_id', true), '');
  v_context_operation_id uuid :=
    NULLIF(pg_catalog.current_setting('agenda.reminder_mode_operation_id', true), '')::uuid;
  v_context_mode text :=
    NULLIF(pg_catalog.current_setting('agenda.reminder_mode_value', true), '');
BEGIN
  IF v_context_event_id = NEW.id::text
     AND v_context_operation_id IS NOT NULL
     AND v_context_mode IN ('legacy', 'off', 'start', 'anticipation')
     AND EXISTS (
       SELECT 1
       FROM public.event_operation_receipts AS receipt
       WHERE receipt.operation_id = v_context_operation_id
         AND receipt.actor_id = auth.uid()
         AND receipt.event_id = NEW.id
         AND receipt.operation_kind = 'save'
         AND receipt.reminder_mode_token = v_context_mode
     ) THEN
    NEW.reminder_mode := NULLIF(v_context_mode, 'legacy');
  ELSIF TG_OP = 'INSERT' THEN
    NEW.reminder_mode := NULL;
  ELSIF OLD.reminder_enabled IS DISTINCT FROM NEW.reminder_enabled
     OR OLD.reminder_value IS DISTINCT FROM NEW.reminder_value
     OR OLD.reminder_unit IS DISTINCT FROM NEW.reminder_unit THEN
    NEW.reminder_mode := NULL;
  ELSE
    NEW.reminder_mode := OLD.reminder_mode;
  END IF;

  RETURN NEW;
END;
$trigger$;

ALTER FUNCTION public.apply_event_reminder_mode_context() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_event_reminder_mode_context()
  FROM PUBLIC, anon, authenticated;

DO $trigger_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.events'::regclass
      AND trigger_info.tgname = 'events_reminder_mode_patch_apply'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgfoid <> 'public.apply_event_reminder_mode_context()'::regprocedure
  ) THEN
    RAISE EXCEPTION
      'Trigger name events_reminder_mode_patch_apply is already used by another function.';
  END IF;
END;
$trigger_preflight$;

DROP TRIGGER IF EXISTS events_reminder_mode_patch_apply ON public.events;
CREATE TRIGGER events_reminder_mode_patch_apply
  BEFORE INSERT OR UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_event_reminder_mode_context();

CREATE OR REPLACE FUNCTION public.bind_event_reminder_mode_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $receipt_trigger$
DECLARE
  v_context_event_id text :=
    NULLIF(pg_catalog.current_setting('agenda.reminder_mode_event_id', true), '');
  v_context_operation_id uuid :=
    NULLIF(pg_catalog.current_setting('agenda.reminder_mode_operation_id', true), '')::uuid;
  v_context_mode text :=
    NULLIF(pg_catalog.current_setting('agenda.reminder_mode_value', true), '');
BEGIN
  IF NEW.operation_kind <> 'save' THEN
    RETURN NEW;
  END IF;

  IF v_context_operation_id = NEW.operation_id
     AND NEW.actor_id = auth.uid()
     AND NEW.event_id IS NOT DISTINCT FROM NULLIF(v_context_event_id, '')::uuid
     AND v_context_mode IN ('legacy', 'off', 'start', 'anticipation') THEN
    NEW.reminder_mode_token := v_context_mode;
  ELSE
    NEW.reminder_mode_token := 'legacy';
  END IF;

  RETURN NEW;
END;
$receipt_trigger$;

ALTER FUNCTION public.bind_event_reminder_mode_receipt() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bind_event_reminder_mode_receipt()
  FROM PUBLIC, anon, authenticated;

DO $receipt_trigger_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_info
    WHERE trigger_info.tgrelid = 'public.event_operation_receipts'::regclass
      AND trigger_info.tgname = 'event_operation_receipts_reminder_mode_bind'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgfoid <> 'public.bind_event_reminder_mode_receipt()'::regprocedure
  ) THEN
    RAISE EXCEPTION
      'Trigger name event_operation_receipts_reminder_mode_bind is already used by another function.';
  END IF;
END;
$receipt_trigger_preflight$;

DROP TRIGGER IF EXISTS event_operation_receipts_reminder_mode_bind
  ON public.event_operation_receipts;
CREATE TRIGGER event_operation_receipts_reminder_mode_bind
  BEFORE INSERT ON public.event_operation_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.bind_event_reminder_mode_receipt();

CREATE OR REPLACE FUNCTION public.save_event_with_reminder_mode(
  p_operation_id uuid,
  p_event_id uuid,
  p_expected_version bigint,
  p_title text,
  p_description text,
  p_category text,
  p_event_date date,
  p_start_time time without time zone,
  p_end_time time without time zone,
  p_participant_ids uuid[],
  p_reminder_enabled boolean,
  p_reminder_value integer,
  p_reminder_unit text,
  p_resolves_operation_id uuid DEFAULT NULL,
  p_reminder_mode text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_response jsonb;
  v_prior_receipt_exists boolean := false;
  v_receipt_exists boolean := false;
  v_prior_receipt_mode text;
  v_receipt_mode text;
  v_saved_mode text;
  v_requested_mode text := COALESCE(p_reminder_mode, 'legacy');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Operation ID is required';
  END IF;

  IF p_reminder_mode IS NOT NULL
     AND p_reminder_mode NOT IN ('off', 'start', 'anticipation') THEN
    RAISE EXCEPTION 'Invalid reminder mode'
      USING ERRCODE = '22023';
  END IF;

  IF p_reminder_mode IN ('off', 'start')
     AND (
       p_reminder_enabled IS DISTINCT FROM false
       OR p_reminder_value IS NOT NULL
       OR p_reminder_unit IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Off and start modes cannot include anticipation values'
      USING ERRCODE = '22023';
  END IF;

  IF p_reminder_mode = 'anticipation'
     AND p_reminder_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Anticipation mode requires an enabled reminder'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  SELECT receipt.reminder_mode_token
    INTO v_prior_receipt_mode
    FROM public.event_operation_receipts AS receipt
   WHERE receipt.operation_id = p_operation_id
     AND receipt.actor_id = v_actor
   FOR UPDATE;
  v_prior_receipt_exists := FOUND;

  PERFORM pg_catalog.set_config(
    'agenda.reminder_mode_event_id',
    COALESCE(p_event_id::text, ''),
    true
  );
  PERFORM pg_catalog.set_config(
    'agenda.reminder_mode_operation_id',
    COALESCE(p_operation_id::text, ''),
    true
  );
  PERFORM pg_catalog.set_config(
    'agenda.reminder_mode_value',
    v_requested_mode,
    true
  );

  v_response := public.save_event(
    p_operation_id,
    p_event_id,
    p_expected_version,
    p_title,
    p_description,
    p_category,
    p_event_date,
    p_start_time,
    p_end_time,
    p_participant_ids,
    p_reminder_enabled,
    p_reminder_value,
    p_reminder_unit,
    p_resolves_operation_id
  );

  PERFORM pg_catalog.set_config('agenda.reminder_mode_event_id', '', true);
  PERFORM pg_catalog.set_config('agenda.reminder_mode_operation_id', '', true);
  PERFORM pg_catalog.set_config('agenda.reminder_mode_value', '', true);

  IF COALESCE(v_response->>'status', '') NOT IN ('confirmed', 'conflict', 'rejected') THEN
    RAISE EXCEPTION 'public.save_event returned an unsupported response status';
  END IF;

  IF v_response->>'status' = 'confirmed'
     AND v_response->>'event_id' IS DISTINCT FROM p_event_id::text THEN
    RAISE EXCEPTION 'save_event confirmed a different event ID';
  END IF;

  SELECT receipt.reminder_mode_token
    INTO v_receipt_mode
    FROM public.event_operation_receipts AS receipt
   WHERE receipt.operation_id = p_operation_id
     AND receipt.actor_id = v_actor
   FOR UPDATE;
  v_receipt_exists := FOUND;

  IF v_prior_receipt_exists THEN
    IF NOT v_receipt_exists
       OR v_receipt_mode IS DISTINCT FROM v_prior_receipt_mode THEN
      RAISE EXCEPTION 'An existing operation receipt changed unexpectedly';
    END IF;

    IF COALESCE(v_prior_receipt_mode, 'unbound') = 'unbound' THEN
      IF p_reminder_mode IS NULL THEN
        RETURN v_response;
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'code', 'operation_id_reused'
      );
    END IF;

    IF v_prior_receipt_mode IS DISTINCT FROM v_requested_mode THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'code', 'operation_id_reused'
      );
    END IF;

    RETURN v_response;
  END IF;

  IF NOT v_receipt_exists THEN
    IF EXISTS (
      SELECT 1
      FROM public.event_operation_receipts AS receipt
      WHERE receipt.operation_id = p_operation_id
    ) THEN
      RETURN v_response;
    END IF;
    RAISE EXCEPTION 'save_event did not create an operation receipt';
  END IF;

  IF v_receipt_mode IS DISTINCT FROM v_requested_mode THEN
    RAISE EXCEPTION
      'The new operation receipt did not record the requested reminder mode';
  END IF;

  IF v_response->>'status' = 'confirmed' THEN
    SELECT event.reminder_mode
      INTO v_saved_mode
      FROM public.events AS event
     WHERE event.id = p_event_id
     FOR SHARE;

    IF NOT FOUND OR v_saved_mode IS DISTINCT FROM p_reminder_mode THEN
      RAISE EXCEPTION
        'The confirmed save did not persist the requested reminder mode; the operation was rolled back';
    END IF;
  END IF;

  RETURN v_response;
END;
$function$;

ALTER FUNCTION public.save_event_with_reminder_mode(
  uuid, uuid, bigint, text, text, text, date,
  time without time zone, time without time zone, uuid[],
  boolean, integer, text, uuid, text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.save_event_with_reminder_mode(
  uuid, uuid, bigint, text, text, text, date,
  time without time zone, time without time zone, uuid[],
  boolean, integer, text, uuid, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_event_with_reminder_mode(
  uuid, uuid, bigint, text, text, text, date,
  time without time zone, time without time zone, uuid[],
  boolean, integer, text, uuid, text
) TO authenticated;

COMMIT;
