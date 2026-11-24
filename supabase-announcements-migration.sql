BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $preflight$
DECLARE
  v_announcements_oid oid := pg_catalog.to_regclass('public.announcements');
  v_relation_kind "char";
  v_column record;
BEGIN
  IF current_user <> 'postgres'
     OR pg_catalog.to_regclass('public.profiles') IS NULL
     OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regnamespace('cron') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron'
     ) THEN
    RAISE EXCEPTION
      'Requires profiles, authenticated Supabase Auth, and enabled pg_cron.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.profiles'::regclass
      AND attname = 'can_publish_announcements'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'Apply the existing profile-permissions migration before Announcements.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.profiles'::regclass
       AND attname = 'id'
       AND atttypid = pg_catalog.to_regtype('uuid')::oid
       AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.profiles'::regclass
       AND attname = 'full_name'
       AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'auth.users'::regclass
       AND attname = 'id'
       AND atttypid = pg_catalog.to_regtype('uuid')::oid
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'The profile name or Auth user ID columns are missing or incompatible; inspect the account schema before applying this migration.';
  END IF;

  IF v_announcements_oid IS NOT NULL THEN
    SELECT relation.relkind INTO v_relation_kind
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = v_announcements_oid;
    IF v_relation_kind <> 'r' THEN
      RAISE EXCEPTION
        'public.announcements exists but is not an ordinary table; inspect it before applying this migration.';
    END IF;

    IF EXISTS (
      SELECT required.attname
        FROM (VALUES ('id'), ('title'), ('content'), ('category'), ('author_id'), ('created_at'))
          AS required(attname)
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = v_announcements_oid
            AND attribute.attname = required.attname
            AND NOT attribute.attisdropped
       )
    ) THEN
      RAISE EXCEPTION
        'The existing public.announcements table is missing required columns; inspect it before applying this migration.';
    END IF;

    FOR v_column IN
      SELECT required.attname,
             required.expected_type,
             required.must_be_not_null,
             attribute.atttypid,
             attribute.attnotnull
        FROM (VALUES
          ('id', pg_catalog.to_regtype('uuid')::oid, true),
          ('title', pg_catalog.to_regtype('text')::oid, true),
          ('content', pg_catalog.to_regtype('text')::oid, true),
          ('category', pg_catalog.to_regtype('text')::oid, true),
          ('created_at', pg_catalog.to_regtype('timestamptz')::oid, true),
          ('version', pg_catalog.to_regtype('int8')::oid, true),
          ('updated_at', pg_catalog.to_regtype('timestamptz')::oid, true),
          ('deleted_at', pg_catalog.to_regtype('timestamptz')::oid, false),
          ('deleted_by', pg_catalog.to_regtype('uuid')::oid, false)
        ) AS required(attname, expected_type, must_be_not_null)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = v_announcements_oid
         AND attribute.attname = required.attname
         AND NOT attribute.attisdropped
    LOOP
      IF v_column.atttypid <> v_column.expected_type
         OR v_column.attnotnull IS DISTINCT FROM v_column.must_be_not_null THEN
        RAISE EXCEPTION
          'The existing public.announcements column % has an incompatible type or nullability; inspect it before applying this migration.',
          v_column.attname;
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = v_announcements_oid
         AND attribute.attname = 'author_id'
         AND NOT attribute.attisdropped
         AND attribute.atttypid <> pg_catalog.to_regtype('uuid')::oid
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = v_announcements_oid
         AND attribute.attname = 'author_name'
         AND NOT attribute.attisdropped
         AND attribute.atttypid <> pg_catalog.to_regtype('text')::oid
    ) THEN
      RAISE EXCEPTION
        'The existing announcement author columns have incompatible types; inspect them before applying this migration.';
    END IF;
  END IF;
END;
$preflight$;

CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  category text NOT NULL DEFAULT 'General',
  author_id uuid,
  author_name text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  deleted_at timestamptz,
  deleted_by uuid
);

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid,
  ADD COLUMN IF NOT EXISTS author_name text;

DO $schema$
DECLARE
  v_id_attnum smallint;
  v_author_attnum smallint;
  v_deleted_by_attnum smallint;
  v_profile_id_attnum smallint;
  v_auth_user_id_attnum smallint;
  v_policy record;
  v_constraint record;
BEGIN
  SELECT attnum INTO v_id_attnum
    FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.announcements'::regclass
     AND attname = 'id' AND NOT attisdropped;
  SELECT attnum INTO v_author_attnum
    FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.announcements'::regclass
     AND attname = 'author_id' AND NOT attisdropped;
  SELECT attnum INTO v_deleted_by_attnum
    FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.announcements'::regclass
     AND attname = 'deleted_by' AND NOT attisdropped;
  SELECT attnum INTO v_profile_id_attnum
    FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.profiles'::regclass
     AND attname = 'id' AND NOT attisdropped;
  SELECT attnum INTO v_auth_user_id_attnum
    FROM pg_catalog.pg_attribute
   WHERE attrelid = 'auth.users'::regclass
     AND attname = 'id' AND NOT attisdropped;

  IF EXISTS (
    SELECT 1 FROM public.announcements
     WHERE title IS NULL OR pg_catalog.length(pg_catalog.btrim(title)) = 0
        OR content IS NULL OR pg_catalog.length(pg_catalog.btrim(content)) = 0
        OR version IS NULL OR version < 1
        OR updated_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Existing announcements contain invalid titles, content, versions, or update timestamps; resolve them before applying this migration.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.announcements AS announcement
     WHERE announcement.author_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM auth.users AS auth_user
          WHERE auth_user.id = announcement.author_id
     )
  ) THEN
    RAISE EXCEPTION
      'Existing announcements contain author_id values without a matching Auth user.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.announcements AS announcement
     WHERE NULLIF(NULLIF(pg_catalog.btrim(announcement.author_name), ''), 'Usuario') IS NULL
       AND (
         announcement.author_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.profiles AS profile
            WHERE profile.id = announcement.author_id
              AND NULLIF(pg_catalog.btrim(profile.full_name::text), '') IS NOT NULL
         )
       )
  ) THEN
    RAISE EXCEPTION
      'Some announcements have no author snapshot and no matching profile from which to preserve attribution.';
  END IF;

  UPDATE public.announcements AS announcement
     SET author_name = NULLIF(pg_catalog.btrim(profile.full_name::text), '')
    FROM public.profiles AS profile
   WHERE profile.id = announcement.author_id
     AND NULLIF(NULLIF(pg_catalog.btrim(announcement.author_name), ''), 'Usuario') IS NULL;

  IF EXISTS (
    SELECT 1 FROM public.announcements AS announcement
     WHERE announcement.deleted_by IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM auth.users AS auth_user
          WHERE auth_user.id = announcement.deleted_by
       )
  ) THEN
    RAISE EXCEPTION
      'Existing announcements contain deleted_by values without a matching Auth user.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.announcements
     GROUP BY id
    HAVING id IS NULL OR pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Existing announcements contain null or duplicate IDs; resolve them before applying this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.announcements'::regclass
       AND constraint_row.contype = 'p'
       AND constraint_row.conkey <> ARRAY[v_id_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'The existing announcements primary key is not exactly the id column.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.announcements'::regclass
       AND constraint_row.contype = 'p'
       AND constraint_row.conkey = ARRAY[v_id_attnum]::smallint[]
  ) THEN
    ALTER TABLE public.announcements
      ADD CONSTRAINT announcements_id_primary_key PRIMARY KEY (id);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.announcements'::regclass
       AND constraint_row.contype = 'f'
       AND constraint_row.conkey @> ARRAY[v_author_attnum]::smallint[]
       AND NOT (
         constraint_row.conkey = ARRAY[v_author_attnum]::smallint[]
         AND (
           (constraint_row.confrelid = 'public.profiles'::regclass
             AND constraint_row.confkey = ARRAY[v_profile_id_attnum]::smallint[])
           OR
           (constraint_row.confrelid = 'auth.users'::regclass
             AND constraint_row.confkey = ARRAY[v_auth_user_id_attnum]::smallint[])
         )
       )
  ) THEN
    RAISE EXCEPTION
      'The existing author_id foreign key references an incompatible relation or column.';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.announcements'::regclass
       AND constraint_row.contype = 'f'
       AND constraint_row.conkey @> ARRAY[v_deleted_by_attnum]::smallint[]
       AND NOT (
         constraint_row.conkey = ARRAY[v_deleted_by_attnum]::smallint[]
         AND constraint_row.confrelid = 'auth.users'::regclass
         AND constraint_row.confkey = ARRAY[v_auth_user_id_attnum]::smallint[]
         AND constraint_row.confdeltype = 'n'
       )
  ) THEN
    RAISE EXCEPTION
      'The existing deleted_by foreign key is incompatible with auth.users(id) ON DELETE SET NULL.';
  END IF;

  ALTER TABLE public.announcements
    ALTER COLUMN version SET DEFAULT 1,
    ALTER COLUMN version SET NOT NULL,
    ALTER COLUMN created_at SET DEFAULT pg_catalog.now(),
    ALTER COLUMN updated_at SET DEFAULT pg_catalog.now(),
    ALTER COLUMN updated_at SET NOT NULL,
    ALTER COLUMN category SET DEFAULT 'General',
    ALTER COLUMN author_id DROP NOT NULL,
    ALTER COLUMN author_name SET NOT NULL;

  ALTER TABLE public.announcements
    DROP CONSTRAINT IF EXISTS announcements_title_nonempty,
    DROP CONSTRAINT IF EXISTS announcements_content_nonempty,
    DROP CONSTRAINT IF EXISTS announcements_version_positive,
    ADD CONSTRAINT announcements_title_nonempty
      CHECK (pg_catalog.length(pg_catalog.btrim(title)) > 0),
    ADD CONSTRAINT announcements_content_nonempty
      CHECK (pg_catalog.length(pg_catalog.btrim(content)) > 0),
    ADD CONSTRAINT announcements_version_positive CHECK (version > 0);

  FOR v_constraint IN
    SELECT conname
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.announcements'::regclass
       AND contype = 'f'
       AND conkey @> ARRAY[v_author_attnum]::smallint[]
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.announcements DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
  ALTER TABLE public.announcements
    ADD CONSTRAINT announcements_author_user_fk
    FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.announcements'::regclass
       AND constraint_row.contype = 'f'
       AND constraint_row.conkey = ARRAY[v_deleted_by_attnum]::smallint[]
       AND constraint_row.confrelid = 'auth.users'::regclass
       AND constraint_row.confkey = ARRAY[v_auth_user_id_attnum]::smallint[]
       AND constraint_row.confdeltype = 'n'
  ) THEN
    ALTER TABLE public.announcements
      ADD CONSTRAINT announcements_deleted_by_user_fk
      FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  ELSE
    FOR v_constraint IN
      SELECT conname
        FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.announcements'::regclass
         AND contype = 'f'
         AND conkey = ARRAY[v_deleted_by_attnum]::smallint[]
         AND confrelid = 'auth.users'::regclass
         AND confkey = ARRAY[v_auth_user_id_attnum]::smallint[]
         AND confdeltype = 'n'
         AND NOT convalidated
    LOOP
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.announcements VALIDATE CONSTRAINT %I',
        v_constraint.conname
      );
    END LOOP;
  END IF;

  FOR v_policy IN
    SELECT policy_row.polname
      FROM pg_catalog.pg_policy AS policy_row
     WHERE policy_row.polrelid = 'public.announcements'::regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.announcements',
      v_policy.polname
    );
  END LOOP;
END;
$schema$;

CREATE INDEX IF NOT EXISTS announcements_active_created_idx
  ON public.announcements (created_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS announcements_deleted_at_idx
  ON public.announcements (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.announcement_change_signals (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

INSERT INTO public.announcement_change_signals (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.announcement_operation_receipts (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  announcement_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('create', 'update', 'delete')),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  request_fingerprint bytea NOT NULL CHECK (pg_catalog.octet_length(request_fingerprint) = 32),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_change_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_operation_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.announcements
  FROM PUBLIC, anon, authenticated;
DO $column_privileges$
DECLARE
  v_column record;
BEGIN
  FOR v_column IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.announcements'::regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE public.announcements FROM PUBLIC, anon, authenticated',
      v_column.attname
    );
  END LOOP;
END;
$column_privileges$;
REVOKE ALL ON TABLE public.announcement_change_signals,
  public.announcement_operation_receipts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.announcement_change_signals TO authenticated;

CREATE OR REPLACE FUNCTION public.can_publish_announcements()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles AS profile
     WHERE profile.id = (SELECT auth.uid())
       AND (
         profile.role::text = 'administrador'
         OR (
           profile.role::text = 'empleado'
           AND COALESCE(profile.can_publish_announcements, false)
         )
       )
  );
$function$;

ALTER FUNCTION public.can_publish_announcements() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_publish_announcements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_publish_announcements() TO authenticated;

CREATE OR REPLACE FUNCTION public.announcements_track_version()
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

ALTER FUNCTION public.announcements_track_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.announcements_track_version()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS announcements_track_version_before_update
  ON public.announcements;
CREATE TRIGGER announcements_track_version_before_update
  BEFORE UPDATE ON public.announcements
  FOR EACH ROW
  EXECUTE FUNCTION public.announcements_track_version();

CREATE OR REPLACE FUNCTION public.notify_announcement_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE public.announcement_change_signals
     SET revision = revision + 1,
         changed_at = pg_catalog.clock_timestamp()
   WHERE id = 1;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.notify_announcement_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_announcement_change()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS announcements_change_signal ON public.announcements;
CREATE TRIGGER announcements_change_signal
  AFTER INSERT OR UPDATE OR DELETE ON public.announcements
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.notify_announcement_change();

CREATE OR REPLACE FUNCTION public.announcement_operation_fingerprint(p_payload jsonb)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_crypto_schema name;
  v_fingerprint bytea;
BEGIN
  SELECT namespace.nspname INTO v_crypto_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'pgcrypto';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The pgcrypto extension is required for announcement operation idempotency.';
  END IF;
  EXECUTE pg_catalog.format('SELECT %I.digest($1, $2)', v_crypto_schema)
    INTO v_fingerprint
    USING pg_catalog.convert_to(COALESCE(p_payload::text, 'null'), 'UTF8'), 'sha256';
  RETURN v_fingerprint;
END;
$function$;

ALTER FUNCTION public.announcement_operation_fingerprint(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.announcement_operation_fingerprint(jsonb)
  FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS announcement_change_signals_read_authenticated
  ON public.announcement_change_signals;
CREATE POLICY announcement_change_signals_read_authenticated
  ON public.announcement_change_signals
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS announcement_operation_receipts_private
  ON public.announcement_operation_receipts;
CREATE POLICY announcement_operation_receipts_private
  ON public.announcement_operation_receipts
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.list_announcements_v1()
RETURNS TABLE (
  id uuid,
  title text,
  content text,
  category text,
  author_id uuid,
  author_name text,
  version bigint,
  created_at timestamptz,
  updated_at timestamptz
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
  SELECT announcement.id,
         announcement.title,
         announcement.content,
         announcement.category,
         announcement.author_id,
         announcement.author_name,
         announcement.version,
         announcement.created_at,
         announcement.updated_at
    FROM public.announcements AS announcement
   WHERE announcement.deleted_at IS NULL
   ORDER BY announcement.created_at DESC, announcement.id;
END;
$function$;

ALTER FUNCTION public.list_announcements_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_announcements_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_announcements_v1() TO authenticated;

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

CREATE OR REPLACE FUNCTION public.purge_expired_announcements()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.announcements
   WHERE deleted_at IS NOT NULL
     AND deleted_at <= pg_catalog.clock_timestamp() - interval '60 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

ALTER FUNCTION public.purge_expired_announcements() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.purge_expired_announcements()
  FROM PUBLIC, anon, authenticated;

DO $publication$
DECLARE
  v_all_tables boolean;
BEGIN
  SELECT puballtables INTO v_all_tables
    FROM pg_catalog.pg_publication
   WHERE pubname = 'supabase_realtime';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supabase publication supabase_realtime does not exist.';
  END IF;
  IF NOT v_all_tables AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'announcement_change_signals'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.announcement_change_signals';
  END IF;
END;
$publication$;

DO $cron$
BEGIN
  PERFORM cron.schedule(
    'announcements-purge-60-days',
    '15 0 * * *',
    'SELECT public.purge_expired_announcements();'
  );
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'announcements-purge-60-days'
       AND schedule = '15 0 * * *'
       AND command = 'SELECT public.purge_expired_announcements();'
       AND active
  ) THEN
    RAISE EXCEPTION 'The Announcements 60-day cleanup job was not registered.';
  END IF;
END;
$cron$;

COMMIT;
