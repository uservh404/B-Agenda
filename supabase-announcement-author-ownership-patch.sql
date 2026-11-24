DO $announcement_owner_preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.apply_announcement_operation_v1(uuid,text,uuid,bigint,jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION
      'Install the announcements migration before applying the author ownership patch.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.announcements'::regclass
       AND attname = 'author_id'
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'The announcements author_id column is required for the ownership patch.';
  END IF;
END;
$announcement_owner_preflight$;

CREATE OR REPLACE FUNCTION public.apply_announcement_operation_v1(
  p_operation_id uuid,
  p_kind text,
  p_announcement_id uuid,
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
  v_receipt public.announcement_operation_receipts%ROWTYPE;
  v_announcement public.announcements%ROWTYPE;
  v_title text := pg_catalog.btrim(p_payload ->> 'title');
  v_content text := pg_catalog.btrim(p_payload ->> 'content');
  v_category text := COALESCE(NULLIF(pg_catalog.btrim(p_payload ->> 'category'), ''), 'General');
  v_author_name text;
  v_fingerprint bytea;
  v_response jsonb;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorized';
  END IF;
  IF p_operation_id IS NULL OR p_announcement_id IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('create', 'update', 'delete')
     OR p_expected_version IS NULL OR p_expected_version < 0
     OR jsonb_typeof(v_payload) <> 'object' THEN
    RETURN jsonb_build_object('status', 'rejected', 'code', 'invalid_announcement_payload');
  END IF;
  v_fingerprint := public.announcement_operation_fingerprint(jsonb_build_object(
    'kind', p_kind,
    'announcement_id', p_announcement_id,
    'expected_version', p_expected_version,
    'payload', v_payload
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );
  SELECT * INTO v_receipt
    FROM public.announcement_operation_receipts
   WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_receipt.actor_id = v_actor
       AND v_receipt.announcement_id = p_announcement_id
       AND v_receipt.operation_kind = p_kind
       AND v_receipt.expected_version = p_expected_version
       AND v_receipt.request_fingerprint = v_fingerprint THEN
      RETURN v_receipt.response;
    END IF;
    RETURN jsonb_build_object('status', 'rejected', 'code', 'operation_id_reused');
  END IF;

  INSERT INTO public.announcement_operation_receipts (
    operation_id, actor_id, announcement_id, operation_kind,
    expected_version, request_fingerprint, response
  ) VALUES (
    p_operation_id, v_actor, p_announcement_id, p_kind,
    p_expected_version, v_fingerprint, jsonb_build_object('status', 'processing')
  );

  IF NOT public.can_publish_announcements() THEN
    v_response := jsonb_build_object('status', 'rejected', 'code', 'not_authorized');
  ELSIF p_kind IN ('create', 'update')
     AND (COALESCE(v_title, '') = '' OR COALESCE(v_content, '') = '') THEN
    v_response := jsonb_build_object('status', 'rejected', 'code', 'invalid_announcement_payload');
  ELSIF p_kind = 'create' THEN
    IF p_expected_version <> 0 THEN
      v_response := jsonb_build_object('status', 'rejected', 'code', 'invalid_version');
    ELSIF EXISTS (
      SELECT 1 FROM public.announcements WHERE id = p_announcement_id
    ) THEN
      v_response := jsonb_build_object('status', 'rejected', 'code', 'announcement_id_exists');
    ELSE
      SELECT NULLIF(pg_catalog.btrim(profile.full_name::text), '')
        INTO v_author_name
        FROM public.profiles AS profile
       WHERE profile.id = v_actor;
      IF v_author_name IS NULL THEN
        v_response := jsonb_build_object('status', 'rejected', 'code', 'author_attribution_unavailable');
      ELSE
        INSERT INTO public.announcements (
          id, title, content, category, author_id, author_name
        ) VALUES (
          p_announcement_id, v_title, v_content, v_category, v_actor, v_author_name
        )
        RETURNING * INTO v_announcement;
        v_response := jsonb_build_object(
          'status', 'confirmed',
          'announcement_id', v_announcement.id,
          'version', v_announcement.version,
          'announcement', NULL
        );
      END IF;
    END IF;
  ELSE
    SELECT * INTO v_announcement
      FROM public.announcements
     WHERE id = p_announcement_id AND deleted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      v_response := jsonb_build_object('status', 'rejected', 'code', 'announcement_not_active');
    ELSIF v_announcement.author_id IS DISTINCT FROM v_actor THEN
      v_response := jsonb_build_object('status', 'rejected', 'code', 'not_authorized');
    ELSIF v_announcement.version <> p_expected_version THEN
      v_response := jsonb_build_object('status', 'conflict', 'code', 'version_conflict');
    ELSIF p_kind = 'delete' THEN
      UPDATE public.announcements
         SET deleted_at = pg_catalog.clock_timestamp(),
             deleted_by = v_actor
       WHERE id = p_announcement_id
      RETURNING * INTO v_announcement;
      v_response := jsonb_build_object(
        'status', 'confirmed',
        'announcement_id', v_announcement.id,
        'version', v_announcement.version,
        'announcement', NULL
      );
    ELSE
      UPDATE public.announcements
         SET title = v_title,
             content = v_content,
             category = v_category
       WHERE id = p_announcement_id
      RETURNING * INTO v_announcement;
      v_response := jsonb_build_object(
        'status', 'confirmed',
        'announcement_id', v_announcement.id,
        'version', v_announcement.version,
        'announcement', NULL
      );
    END IF;
  END IF;

  UPDATE public.announcement_operation_receipts
     SET response = v_response
   WHERE operation_id = p_operation_id;
  RETURN v_response;
END;
$function$;

ALTER FUNCTION public.apply_announcement_operation_v1(uuid, text, uuid, bigint, jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_announcement_operation_v1(uuid, text, uuid, bigint, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_announcement_operation_v1(uuid, text, uuid, bigint, jsonb)
  TO authenticated;
