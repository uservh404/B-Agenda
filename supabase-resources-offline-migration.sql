BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.resources') IS NULL
    OR pg_catalog.to_regprocedure('public.can_manage_resources()') IS NULL
    OR pg_catalog.to_regprocedure('public.soft_delete_resource_v1(uuid)') IS NULL
  THEN
    RAISE EXCEPTION
      'Apply the existing Resources and 60-day retention migrations before this offline migration.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.resources'::regclass
       AND attname = 'deleted_at'
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'The Resources 60-day retention migration must be applied before this offline migration.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.resources'::regclass
       AND attname = 'deleted_by'
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'The Resources deleted_by column is required before this offline migration.';
  END IF;
END;
$preflight$;

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Keep compact tombstones so a delayed offline create cannot replay after resource purge.
CREATE TABLE IF NOT EXISTS public.resource_operation_receipts (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('create', 'update', 'delete')),
  expected_version bigint NOT NULL,
  request_fingerprint bytea NOT NULL,
  response_status text NOT NULL,
  response_code text,
  response_version bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_operation_receipts_fingerprint_length_check
    CHECK (pg_catalog.octet_length(request_fingerprint) = 32),
  CONSTRAINT resource_operation_receipts_status_check
    CHECK (response_status IN ('confirmed', 'conflict', 'rejected'))
);

ALTER TABLE public.resource_operation_receipts
  ADD COLUMN IF NOT EXISTS request_fingerprint bytea,
  ADD COLUMN IF NOT EXISTS response_status text,
  ADD COLUMN IF NOT EXISTS response_code text,
  ADD COLUMN IF NOT EXISTS response_version bigint;

CREATE OR REPLACE FUNCTION public.resource_operation_fingerprint(p_payload jsonb)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_crypto_schema name;
  v_fingerprint bytea;
BEGIN
  SELECT namespace.nspname
    INTO v_crypto_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'pgcrypto';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The pgcrypto extension is required for Resource operation idempotency.';
  END IF;

  EXECUTE pg_catalog.format('SELECT %I.digest($1, $2)', v_crypto_schema)
    INTO v_fingerprint
    USING pg_catalog.convert_to(coalesce(p_payload::text, 'null'), 'UTF8'), 'sha256';

  RETURN v_fingerprint;
END;
$function$;

ALTER FUNCTION public.resource_operation_fingerprint(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resource_operation_fingerprint(jsonb)
  FROM PUBLIC, anon, authenticated;

DO $upgrade_receipts$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.resource_operation_receipts'::regclass
       AND attname = 'request_payload'
       AND NOT attisdropped
  ) THEN
    EXECUTE $sql$
      UPDATE public.resource_operation_receipts AS receipt
         SET request_fingerprint = public.resource_operation_fingerprint(receipt.request_payload)
       WHERE receipt.request_fingerprint IS NULL
    $sql$;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.resource_operation_receipts'::regclass
       AND attname = 'response_payload'
       AND NOT attisdropped
  ) THEN
    EXECUTE $sql$
      UPDATE public.resource_operation_receipts AS receipt
         SET response_status = receipt.response_payload ->> 'status',
             response_code = receipt.response_payload ->> 'code',
             response_version = CASE
               WHEN pg_catalog.jsonb_typeof(receipt.response_payload -> 'version') = 'number'
                 THEN (receipt.response_payload ->> 'version')::bigint
               ELSE NULL
             END
       WHERE receipt.response_status IS NULL
    $sql$;
  END IF;
END;
$upgrade_receipts$;

ALTER TABLE public.resource_operation_receipts
  ALTER COLUMN request_fingerprint SET NOT NULL,
  ALTER COLUMN response_status SET NOT NULL;

DO $receipt_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.resource_operation_receipts'::regclass
       AND conname = 'resource_operation_receipts_fingerprint_length_check'
  ) THEN
    ALTER TABLE public.resource_operation_receipts
      ADD CONSTRAINT resource_operation_receipts_fingerprint_length_check
      CHECK (pg_catalog.octet_length(request_fingerprint) = 32);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.resource_operation_receipts'::regclass
       AND conname = 'resource_operation_receipts_status_check'
  ) THEN
    ALTER TABLE public.resource_operation_receipts
      ADD CONSTRAINT resource_operation_receipts_status_check
      CHECK (response_status IN ('confirmed', 'conflict', 'rejected'));
  END IF;
END;
$receipt_constraints$;

ALTER TABLE public.resource_operation_receipts
  DROP COLUMN IF EXISTS request_payload,
  DROP COLUMN IF EXISTS response_payload;

ALTER TABLE public.resource_operation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.resource_operation_receipts
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.resources_track_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.resources_track_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resources_track_version()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS resources_track_version_before_update
  ON public.resources;
CREATE TRIGGER resources_track_version_before_update
  BEFORE UPDATE ON public.resources
  FOR EACH ROW
  EXECUTE FUNCTION public.resources_track_version();

CREATE OR REPLACE FUNCTION public.apply_resource_operation_v1(
  p_operation_id uuid,
  p_kind text,
  p_resource_id uuid,
  p_expected_version bigint,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_receipt public.resource_operation_receipts%ROWTYPE;
  v_resource public.resources%ROWTYPE;
  v_name text;
  v_category text;
  v_quantity integer;
  v_stored_in text;
  v_notes text[];
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'not_authorized';
  END IF;

  IF p_operation_id IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_operation_id');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  SELECT *
    INTO v_receipt
    FROM public.resource_operation_receipts
   WHERE operation_id = p_operation_id;

  IF FOUND THEN
    IF v_receipt.actor_id = v_actor
      AND v_receipt.resource_id = p_resource_id
      AND v_receipt.operation_kind = p_kind
      AND v_receipt.expected_version = p_expected_version
      AND v_receipt.request_fingerprint = public.resource_operation_fingerprint(p_payload)
    THEN
      RETURN jsonb_build_object(
        'status', v_receipt.response_status,
        'code', v_receipt.response_code,
        'resource_id', v_receipt.resource_id,
        'version', v_receipt.response_version,
        'resource', NULL
      );
    END IF;

    RETURN jsonb_build_object('status', 'rejected', 'code', 'operation_id_reused');
  END IF;

  IF NOT public.can_manage_resources() THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'not_authorized');
  END IF;

  IF p_resource_id IS NULL
    OR p_expected_version IS NULL
    OR p_kind IS NULL
    OR p_kind NOT IN ('create', 'update', 'delete')
  THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_operation');
  END IF;

  IF p_kind = 'create' AND p_expected_version <> 0 THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_expected_version');
  END IF;

  IF p_kind IN ('update', 'delete') AND p_expected_version < 1 THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_expected_version');
  END IF;

  IF p_kind = 'delete' THEN
    IF p_payload IS DISTINCT FROM '{}'::jsonb THEN
      RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_resource_payload');
    END IF;

    SELECT *
      INTO v_resource
      FROM public.resources
     WHERE id = p_resource_id
       AND deleted_at IS NULL
       FOR UPDATE;

    IF NOT FOUND THEN
      v_response := jsonb_build_object(
        'status', 'conflict',
        'code', 'resource_not_active',
        'resource_id', p_resource_id
      );
    ELSIF v_resource.version <> p_expected_version THEN
      v_response := jsonb_build_object(
        'status', 'conflict',
        'code', 'version_conflict',
        'resource_id', p_resource_id,
        'version', v_resource.version
      );
    ELSE
      PERFORM public.soft_delete_resource_v1(p_resource_id);
      SELECT *
        INTO v_resource
        FROM public.resources
       WHERE id = p_resource_id;

      v_response := jsonb_build_object(
        'status', 'confirmed',
        'resource_id', p_resource_id,
        'version', v_resource.version,
        'resource', NULL
      );
    END IF;
  ELSE
    IF p_payload IS NULL
      OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
      OR NOT (p_payload ?& ARRAY['name', 'category', 'quantity', 'stored_in', 'notes'])
      OR (p_payload - ARRAY['name', 'category', 'quantity', 'stored_in', 'notes']::text[]) <> '{}'::jsonb
      OR pg_catalog.jsonb_typeof(p_payload -> 'name') <> 'string'
      OR pg_catalog.jsonb_typeof(p_payload -> 'category') <> 'string'
      OR pg_catalog.jsonb_typeof(p_payload -> 'stored_in') <> 'string'
      OR pg_catalog.jsonb_typeof(p_payload -> 'quantity') <> 'number'
      OR pg_catalog.jsonb_typeof(p_payload -> 'notes') <> 'array'
    THEN
      RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_resource_payload');
    END IF;

    v_name := p_payload ->> 'name';
    v_category := p_payload ->> 'category';
    v_stored_in := p_payload ->> 'stored_in';

    IF pg_catalog.btrim(v_name) = ''
      OR pg_catalog.btrim(v_category) = ''
      OR (p_payload ->> 'quantity') !~ '^(0|[1-9][0-9]*)$'
      OR (p_payload ->> 'quantity')::numeric > 2147483647
      OR EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_array_elements(p_payload -> 'notes') AS note(value)
         WHERE pg_catalog.jsonb_typeof(note.value) <> 'string'
      )
    THEN
      RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_resource_payload');
    END IF;

    v_quantity := (p_payload ->> 'quantity')::integer;
    SELECT ARRAY(
      SELECT pg_catalog.jsonb_array_elements_text(p_payload -> 'notes')
    )
      INTO v_notes;

    IF p_kind = 'create' THEN
      INSERT INTO public.resources (
        id,
        name,
        category,
        quantity,
        stored_in,
        notes
      )
      VALUES (
        p_resource_id,
        v_name,
        v_category,
        v_quantity,
        v_stored_in,
        v_notes
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING * INTO v_resource;

      IF NOT FOUND THEN
        v_response := jsonb_build_object(
          'status', 'conflict',
          'code', 'resource_id_exists',
          'resource_id', p_resource_id
        );
      ELSE
        v_response := jsonb_build_object(
          'status', 'confirmed',
          'resource_id', v_resource.id,
          'version', v_resource.version,
          'resource', jsonb_build_object(
            'id', v_resource.id,
            'name', v_resource.name,
            'category', v_resource.category,
            'quantity', v_resource.quantity,
            'stored_in', v_resource.stored_in,
            'notes', v_resource.notes,
            'version', v_resource.version,
            'updated_at', v_resource.updated_at
          )
        );
      END IF;
    ELSE
      SELECT *
        INTO v_resource
        FROM public.resources
       WHERE id = p_resource_id
         AND deleted_at IS NULL
         FOR UPDATE;

      IF NOT FOUND THEN
        v_response := jsonb_build_object(
          'status', 'conflict',
          'code', 'resource_not_active',
          'resource_id', p_resource_id
        );
      ELSIF v_resource.version <> p_expected_version THEN
        v_response := jsonb_build_object(
          'status', 'conflict',
          'code', 'version_conflict',
          'resource_id', p_resource_id,
          'version', v_resource.version
        );
      ELSE
        UPDATE public.resources
           SET name = v_name,
               category = v_category,
               quantity = v_quantity,
               stored_in = v_stored_in,
               notes = v_notes
         WHERE id = p_resource_id
        RETURNING * INTO v_resource;

        v_response := jsonb_build_object(
          'status', 'confirmed',
          'resource_id', v_resource.id,
          'version', v_resource.version,
          'resource', jsonb_build_object(
            'id', v_resource.id,
            'name', v_resource.name,
            'category', v_resource.category,
            'quantity', v_resource.quantity,
            'stored_in', v_resource.stored_in,
            'notes', v_resource.notes,
            'version', v_resource.version,
            'updated_at', v_resource.updated_at
          )
        );
      END IF;
    END IF;
  END IF;

  INSERT INTO public.resource_operation_receipts (
    operation_id,
    actor_id,
    resource_id,
    operation_kind,
    expected_version,
    request_fingerprint,
    response_status,
    response_code,
    response_version
  )
  VALUES (
    p_operation_id,
    v_actor,
    p_resource_id,
    p_kind,
    p_expected_version,
    public.resource_operation_fingerprint(p_payload),
    v_response ->> 'status',
    v_response ->> 'code',
    NULLIF(v_response ->> 'version', '')::bigint
  );

  RETURN v_response;
END;
$function$;

ALTER FUNCTION public.apply_resource_operation_v1(uuid, text, uuid, bigint, jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_resource_operation_v1(uuid, text, uuid, bigint, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_resource_operation_v1(uuid, text, uuid, bigint, jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.soft_delete_resource_v1(uuid)
  FROM PUBLIC, anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.resources
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT (name, category, quantity, stored_in, notes),
  UPDATE (name, category, quantity, stored_in, notes)
  ON TABLE public.resources
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.resources TO authenticated;

COMMIT;
