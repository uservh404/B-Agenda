BEGIN;

-- 1. Extension and event tables

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE public.events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('personal', 'shared')),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  event_date date NOT NULL,
  start_time time without time zone NOT NULL,
  end_time time without time zone NOT NULL,
  time_zone text NOT NULL DEFAULT 'America/Mexico_City'
    CHECK (time_zone = 'America/Mexico_City'),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reminder_enabled boolean NOT NULL DEFAULT false,
  reminder_value integer,
  reminder_unit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CONSTRAINT events_valid_interval CHECK (end_at > start_at),
  CONSTRAINT events_reminder_valid CHECK (
    (
      reminder_enabled
      AND reminder_value IS NOT NULL
      AND reminder_value > 0
      AND reminder_unit IS NOT NULL
      AND reminder_unit IN ('minutes', 'hours', 'days', 'weeks')
    )
    OR
    (
      NOT reminder_enabled
      AND reminder_value IS NULL
      AND reminder_unit IS NULL
    )
  ),
  CONSTRAINT events_status_cancelled_at CHECK (
    (status = 'confirmed' AND cancelled_at IS NULL)
    OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
  )
);

CREATE INDEX events_owner_updated_idx
  ON public.events (owner_id, updated_at);

CREATE INDEX events_date_idx
  ON public.events (event_date);

CREATE TABLE public.event_participants (
  event_id uuid NOT NULL
    REFERENCES public.events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  assigned_by uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX event_participants_user_idx
  ON public.event_participants (user_id, event_id);

CREATE TABLE public.event_reservations (
  event_id uuid NOT NULL
    REFERENCES public.events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  during tstzrange NOT NULL,
  CONSTRAINT event_reservations_nonempty CHECK (NOT isempty(during)),
  CONSTRAINT event_reservations_bounds CHECK (
    lower_inc(during) AND NOT upper_inc(during)
  ),
  UNIQUE (event_id, user_id),
  CONSTRAINT event_reservations_no_overlap
    EXCLUDE USING gist (
      user_id WITH =,
      during WITH &&
    )
);

CREATE TABLE public.event_operation_receipts (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  event_id uuid,
  operation_kind text NOT NULL
    CHECK (operation_kind IN ('save', 'cancel')),
  request_payload jsonb NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.event_sync_state (
  user_id uuid PRIMARY KEY
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  last_cursor bigint NOT NULL DEFAULT 0 CHECK (last_cursor >= 0)
);

CREATE TABLE public.event_sync_changes (
  user_id uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  cursor bigint NOT NULL CHECK (cursor > 0),
  event_id uuid NOT NULL,
  event_version bigint NOT NULL CHECK (event_version > 0),
  change_type text NOT NULL CHECK (change_type IN ('upsert', 'remove')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, cursor)
);

CREATE TABLE public.event_sync_conflicts (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  operation_kind text NOT NULL
    CHECK (operation_kind IN ('save', 'cancel')),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  conflict_code text NOT NULL
    CHECK (conflict_code IN (
      'version_conflict',
      'schedule_unavailable',
      'event_id_unavailable',
      'event_not_active'
    )),
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'discarded')),
  resolution_operation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  discarded_at timestamptz,
  CONSTRAINT event_sync_conflicts_resolution_state CHECK (
    (
      status = 'pending'
      AND resolution_operation_id IS NULL
      AND resolved_at IS NULL
      AND discarded_at IS NULL
    )
    OR
    (
      status = 'applied'
      AND resolution_operation_id IS NOT NULL
      AND resolved_at IS NOT NULL
      AND discarded_at IS NULL
    )
    OR
    (
      status = 'discarded'
      AND resolution_operation_id IS NULL
      AND resolved_at IS NULL
      AND discarded_at IS NOT NULL
    )
  )
);

CREATE INDEX event_sync_conflicts_actor_status_idx
  ON public.event_sync_conflicts (actor_id, status, created_at);

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_sync_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_sync_conflicts ENABLE ROW LEVEL SECURITY;


-- 2. Security and synchronization helpers

CREATE OR REPLACE FUNCTION public.can_read_event(p_event_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.events AS e
    WHERE e.id = p_event_id
      AND (
        e.owner_id = auth.uid()
        OR (
          e.scope = 'shared'
          AND EXISTS (
            SELECT 1
            FROM public.event_participants AS ep
            WHERE ep.event_id = e.id
              AND ep.user_id = auth.uid()
          )
        )
      )
  );
$$;

ALTER FUNCTION public.can_read_event(uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.append_event_sync_changes(
  p_event_id uuid,
  p_event_version bigint,
  p_upsert_user_ids uuid[],
  p_remove_user_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_recipient record;
  v_cursor bigint;
BEGIN
  IF p_event_id IS NULL OR p_event_version IS NULL OR p_event_version < 1 THEN
    RAISE EXCEPTION 'Invalid synchronization change';
  END IF;

  FOR v_recipient IN
    SELECT
      recipients.user_id,
      CASE
        WHEN bool_or(recipients.change_type = 'upsert') THEN 'upsert'
        ELSE 'remove'
      END AS change_type
    FROM (
      SELECT input.user_id, 'upsert'::text AS change_type
      FROM unnest(COALESCE(p_upsert_user_ids, ARRAY[]::uuid[]))
        AS input(user_id)
      UNION ALL
      SELECT input.user_id, 'remove'::text AS change_type
      FROM unnest(COALESCE(p_remove_user_ids, ARRAY[]::uuid[]))
        AS input(user_id)
    ) AS recipients
    WHERE recipients.user_id IS NOT NULL
    GROUP BY recipients.user_id
    ORDER BY recipients.user_id
  LOOP
    INSERT INTO public.event_sync_state (user_id, last_cursor)
    VALUES (v_recipient.user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.event_sync_state
    SET last_cursor = last_cursor + 1
    WHERE user_id = v_recipient.user_id
    RETURNING last_cursor INTO v_cursor;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not allocate synchronization cursor';
    END IF;

    INSERT INTO public.event_sync_changes (
      user_id, cursor, event_id, event_version, change_type
    ) VALUES (
      v_recipient.user_id,
      v_cursor,
      p_event_id,
      p_event_version,
      v_recipient.change_type
    );
  END LOOP;
END;
$$;

ALTER FUNCTION public.append_event_sync_changes(
  uuid, bigint, uuid[], uuid[]
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.record_event_sync_conflict(
  p_operation_id uuid,
  p_actor_id uuid,
  p_event_id uuid,
  p_operation_kind text,
  p_expected_version bigint,
  p_conflict_code text,
  p_request_payload jsonb,
  p_response jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.event_sync_conflicts (
    operation_id,
    actor_id,
    event_id,
    operation_kind,
    expected_version,
    conflict_code,
    request_payload
  ) VALUES (
    p_operation_id,
    p_actor_id,
    p_event_id,
    p_operation_kind,
    p_expected_version,
    p_conflict_code,
    p_request_payload
  );

  UPDATE public.event_operation_receipts
  SET response = p_response
  WHERE operation_id = p_operation_id
    AND actor_id = p_actor_id
    AND event_id IS NOT DISTINCT FROM p_event_id
    AND operation_kind = p_operation_kind
    AND request_payload = p_request_payload;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operation receipt could not be updated';
  END IF;
END;
$$;

ALTER FUNCTION public.record_event_sync_conflict(
  uuid, uuid, uuid, text, bigint, text, jsonb, jsonb
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.reject_event_operation(
  p_operation_id uuid,
  p_actor_id uuid,
  p_event_id uuid,
  p_operation_kind text,
  p_request_payload jsonb,
  p_rejection_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_response jsonb := pg_catalog.jsonb_build_object(
    'status', 'rejected',
    'code', p_rejection_code
  );
BEGIN
  UPDATE public.event_operation_receipts
  SET response = v_response
  WHERE operation_id = p_operation_id
    AND actor_id = p_actor_id
    AND event_id IS NOT DISTINCT FROM p_event_id
    AND operation_kind = p_operation_kind
    AND request_payload = p_request_payload;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operation receipt could not be updated';
  END IF;

  RETURN v_response;
END;
$$;

ALTER FUNCTION public.reject_event_operation(
  uuid, uuid, uuid, text, jsonb, text
) OWNER TO postgres;


-- 3. Read policies

CREATE POLICY events_read_authorized
  ON public.events
  FOR SELECT
  TO authenticated
  USING (public.can_read_event(id));

CREATE POLICY participants_read_authorized
  ON public.event_participants
  FOR SELECT
  TO authenticated
  USING (public.can_read_event(event_id));

CREATE POLICY sync_state_read_own
  ON public.event_sync_state
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY sync_changes_read_own
  ON public.event_sync_changes
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY sync_conflicts_read_own
  ON public.event_sync_conflicts
  FOR SELECT
  TO authenticated
  USING (actor_id = auth.uid());


-- 4. Create, edit, and explicitly reconcile event operations

CREATE OR REPLACE FUNCTION public.save_event(
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
  p_resolves_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_can_assign boolean;
  v_is_new boolean;
  v_current_version bigint;
  v_current_status text;
  v_old_participants uuid[] := ARRAY[]::uuid[];
  v_new_participants uuid[] := ARRAY[]::uuid[];
  v_removed_participants uuid[] := ARRAY[]::uuid[];
  v_profile_count bigint;
  v_participants_changed boolean := false;
  v_event_version bigint;
  v_start_local timestamp without time zone;
  v_end_local timestamp without time zone;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_response jsonb;
  v_request_payload jsonb;
  v_receipt public.event_operation_receipts%ROWTYPE;
  v_conflict public.event_sync_conflicts%ROWTYPE;
  v_rows bigint;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Operation ID is required';
  END IF;

  v_request_payload := pg_catalog.jsonb_build_object(
    'operation_kind', 'save',
    'event_id', p_event_id,
    'expected_version', p_expected_version,
    'title', p_title,
    'description', p_description,
    'category', p_category,
    'event_date', p_event_date,
    'start_time', p_start_time,
    'end_time', p_end_time,
    'participant_ids', p_participant_ids,
    'reminder_enabled', p_reminder_enabled,
    'reminder_value', p_reminder_value,
    'reminder_unit', p_reminder_unit,
    'resolves_operation_id', p_resolves_operation_id
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  SELECT r.*
  INTO v_receipt
  FROM public.event_operation_receipts AS r
  WHERE r.operation_id = p_operation_id;

  IF FOUND THEN
    IF v_receipt.actor_id = v_actor
       AND v_receipt.event_id IS NOT DISTINCT FROM p_event_id
       AND v_receipt.operation_kind = 'save'
       AND v_receipt.request_payload = v_request_payload THEN
      RETURN v_receipt.response;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'code', 'operation_id_reused'
    );
  END IF;

  INSERT INTO public.event_operation_receipts (
    operation_id,
    actor_id,
    event_id,
    operation_kind,
    request_payload,
    response
  ) VALUES (
    p_operation_id,
    v_actor,
    p_event_id,
    'save',
    v_request_payload,
    pg_catalog.jsonb_build_object('status', 'processing')
  );

  IF p_event_id IS NULL THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_event_id'
    );
  END IF;

  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_version'
    );
  END IF;

  IF p_title IS NULL OR pg_catalog.length(pg_catalog.btrim(p_title)) = 0 THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_title'
    );
  END IF;

  IF p_event_date IS NULL OR NOT pg_catalog.isfinite(p_event_date) THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_date'
    );
  END IF;

  IF p_start_time IS NULL OR p_end_time IS NULL
     OR p_start_time = TIME '24:00:00'
     OR p_end_time = TIME '24:00:00'
     OR p_start_time = p_end_time THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_time'
    );
  END IF;

  IF p_reminder_enabled IS NULL THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_reminder'
    );
  END IF;

  IF p_reminder_enabled THEN
    IF p_reminder_value IS NULL
       OR p_reminder_value <= 0
       OR p_reminder_unit IS NULL
       OR p_reminder_unit NOT IN ('minutes', 'hours', 'days', 'weeks') THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'save',
        v_request_payload, 'invalid_reminder'
      );
    END IF;
  ELSIF p_reminder_value IS NOT NULL OR p_reminder_unit IS NOT NULL THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_reminder'
    );
  END IF;

  SELECT COALESCE(p.can_assign_events, false)
  INTO v_can_assign
  FROM public.profiles AS p
  WHERE p.id = v_actor
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'profile_unavailable'
    );
  END IF;

  v_is_new := p_expected_version = 0;

  IF p_resolves_operation_id IS NOT NULL THEN
    IF p_resolves_operation_id = p_operation_id THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'save',
        v_request_payload, 'invalid_reconciliation'
      );
    END IF;

    SELECT c.*
    INTO v_conflict
    FROM public.event_sync_conflicts AS c
    WHERE c.operation_id = p_resolves_operation_id
      AND c.actor_id = v_actor
      AND c.event_id = p_event_id
      AND c.operation_kind = 'save'
      AND c.status = 'pending'
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'save',
        v_request_payload, 'conflict_not_pending'
      );
    END IF;

    IF v_is_new AND v_conflict.expected_version <> 0 THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'save',
        v_request_payload, 'invalid_reconciliation'
      );
    END IF;
  END IF;

  IF v_is_new THEN
    IF p_participant_ids IS NULL THEN
      v_new_participants := ARRAY[]::uuid[];
    ELSE
      IF EXISTS (
        SELECT 1
        FROM unnest(p_participant_ids) AS input(user_id)
        WHERE input.user_id IS NULL OR input.user_id = v_actor
      ) THEN
        RETURN public.reject_event_operation(
          p_operation_id, v_actor, p_event_id, 'save',
          v_request_payload, 'invalid_participants'
        );
      END IF;

      SELECT COALESCE(
        array_agg(DISTINCT input.user_id ORDER BY input.user_id),
        ARRAY[]::uuid[]
      )
      INTO v_new_participants
      FROM unnest(p_participant_ids) AS input(user_id);
    END IF;

    v_participants_changed := cardinality(v_new_participants) > 0;
  ELSE
    SELECT e.version, e.status
    INTO v_current_version, v_current_status
    FROM public.events AS e
    WHERE e.id = p_event_id
      AND e.owner_id = v_actor
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'save',
        v_request_payload, 'event_not_editable'
      );
    END IF;

    SELECT COALESCE(
      array_agg(ep.user_id ORDER BY ep.user_id),
      ARRAY[]::uuid[]
    )
    INTO v_old_participants
    FROM public.event_participants AS ep
    WHERE ep.event_id = p_event_id;

    IF p_participant_ids IS NULL THEN
      v_new_participants := v_old_participants;
    ELSE
      IF EXISTS (
        SELECT 1
        FROM unnest(p_participant_ids) AS input(user_id)
        WHERE input.user_id IS NULL OR input.user_id = v_actor
      ) THEN
        RETURN public.reject_event_operation(
          p_operation_id, v_actor, p_event_id, 'save',
          v_request_payload, 'invalid_participants'
        );
      END IF;

      SELECT COALESCE(
        array_agg(DISTINCT input.user_id ORDER BY input.user_id),
        ARRAY[]::uuid[]
      )
      INTO v_new_participants
      FROM unnest(p_participant_ids) AS input(user_id);
    END IF;

    v_participants_changed :=
      v_new_participants IS DISTINCT FROM v_old_participants;
  END IF;

  IF v_participants_changed AND NOT v_can_assign THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'not_authorized'
    );
  END IF;

  SELECT count(*)
  INTO v_profile_count
  FROM public.profiles AS p
  WHERE p.id = ANY(v_new_participants);

  IF v_profile_count <> cardinality(v_new_participants) THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_participants'
    );
  END IF;

  v_request_payload := pg_catalog.jsonb_build_object(
    'operation_kind', 'save',
    'event_id', p_event_id,
    'expected_version', p_expected_version,
    'title', p_title,
    'description', p_description,
    'category', p_category,
    'event_date', p_event_date,
    'start_time', p_start_time,
    'end_time', p_end_time,
    'participant_ids', p_participant_ids,
    'reminder_enabled', p_reminder_enabled,
    'reminder_value', p_reminder_value,
    'reminder_unit', p_reminder_unit,
    'resolves_operation_id', p_resolves_operation_id
  );

  IF NOT v_is_new THEN
    IF v_current_status <> 'confirmed' THEN
      v_response := pg_catalog.jsonb_build_object(
        'status', 'conflict',
        'code', 'event_not_active',
        'event_id', p_event_id
      );

      PERFORM public.record_event_sync_conflict(
        p_operation_id, v_actor, p_event_id, 'save',
        p_expected_version, 'event_not_active',
        v_request_payload, v_response
      );

      RETURN v_response;
    END IF;

    IF v_current_version <> p_expected_version THEN
      v_response := pg_catalog.jsonb_build_object(
        'status', 'conflict',
        'code', 'version_conflict',
        'event_id', p_event_id
      );

      PERFORM public.record_event_sync_conflict(
        p_operation_id, v_actor, p_event_id, 'save',
        p_expected_version, 'version_conflict',
        v_request_payload, v_response
      );

      RETURN v_response;
    END IF;
  END IF;

  BEGIN
    v_start_local := p_event_date + p_start_time;
    v_end_local :=
      (
        p_event_date
        + CASE WHEN p_end_time < p_start_time THEN 1 ELSE 0 END
      ) + p_end_time;

    v_start_at := v_start_local AT TIME ZONE 'America/Mexico_City';
    v_end_at := v_end_local AT TIME ZONE 'America/Mexico_City';

    IF (v_start_at AT TIME ZONE 'America/Mexico_City')
         IS DISTINCT FROM v_start_local
       OR (v_end_at AT TIME ZONE 'America/Mexico_City')
         IS DISTINCT FROM v_end_local THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'save',
        v_request_payload, 'invalid_local_time'
      );
    END IF;
  EXCEPTION
    WHEN datetime_field_overflow THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'save',
        v_request_payload, 'invalid_date_or_time'
      );
  END;

  IF v_end_at <= v_start_at THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'save',
      v_request_payload, 'invalid_interval'
    );
  END IF;

  v_event_version := CASE
    WHEN v_is_new THEN 1
    ELSE v_current_version + 1
  END;

  SELECT COALESCE(
    array_agg(input.user_id ORDER BY input.user_id),
    ARRAY[]::uuid[]
  )
  INTO v_removed_participants
  FROM unnest(v_old_participants) AS input(user_id)
  WHERE NOT (input.user_id = ANY(v_new_participants));

  BEGIN
    IF v_is_new THEN
      INSERT INTO public.events (
        id, owner_id, scope, title, description, category,
        event_date, start_time, end_time, time_zone,
        start_at, end_at, status, version,
        reminder_enabled, reminder_value, reminder_unit
      ) VALUES (
        p_event_id,
        v_actor,
        CASE WHEN cardinality(v_new_participants) > 0
             THEN 'shared' ELSE 'personal' END,
        pg_catalog.btrim(p_title),
        COALESCE(p_description, ''),
        COALESCE(p_category, ''),
        p_event_date,
        p_start_time,
        p_end_time,
        'America/Mexico_City',
        v_start_at,
        v_end_at,
        'confirmed',
        v_event_version,
        p_reminder_enabled,
        CASE WHEN p_reminder_enabled THEN p_reminder_value ELSE NULL END,
        CASE WHEN p_reminder_enabled THEN p_reminder_unit ELSE NULL END
      )
      ON CONFLICT (id) DO NOTHING;

      GET DIAGNOSTICS v_rows = ROW_COUNT;

      IF v_rows = 0 THEN
        v_response := pg_catalog.jsonb_build_object(
          'status', 'conflict',
          'code', 'event_id_unavailable',
          'event_id', p_event_id
        );
      END IF;
    ELSE
      UPDATE public.events
      SET scope = CASE WHEN cardinality(v_new_participants) > 0
                       THEN 'shared' ELSE 'personal' END,
          title = pg_catalog.btrim(p_title),
          description = COALESCE(p_description, ''),
          category = COALESCE(p_category, ''),
          event_date = p_event_date,
          start_time = p_start_time,
          end_time = p_end_time,
          time_zone = 'America/Mexico_City',
          start_at = v_start_at,
          end_at = v_end_at,
          version = v_event_version,
          updated_at = pg_catalog.now(),
          reminder_enabled = p_reminder_enabled,
          reminder_value = CASE WHEN p_reminder_enabled THEN p_reminder_value ELSE NULL END,
          reminder_unit = CASE WHEN p_reminder_enabled THEN p_reminder_unit ELSE NULL END
      WHERE id = p_event_id
        AND owner_id = v_actor;
    END IF;

    IF v_response IS NULL THEN
      DELETE FROM public.event_participants AS ep
      WHERE ep.event_id = p_event_id
        AND NOT (ep.user_id = ANY(v_new_participants));

      INSERT INTO public.event_participants (
        event_id, user_id, assigned_by
      )
      SELECT p_event_id, input.participant_id, v_actor
      FROM unnest(v_new_participants) AS input(participant_id)
      ON CONFLICT (event_id, user_id) DO NOTHING;

      DELETE FROM public.event_reservations AS er
      WHERE er.event_id = p_event_id;

      INSERT INTO public.event_reservations (event_id, user_id, during)
      SELECT p_event_id, v_actor, tstzrange(v_start_at, v_end_at, '[)')
      UNION ALL
      SELECT p_event_id, input.participant_id, tstzrange(v_start_at, v_end_at, '[)')
      FROM unnest(v_new_participants) AS input(participant_id);

      PERFORM public.append_event_sync_changes(
        p_event_id,
        v_event_version,
        ARRAY[v_actor]::uuid[] || v_new_participants,
        v_removed_participants
      );
    END IF;
  EXCEPTION
    WHEN exclusion_violation THEN
      v_response := pg_catalog.jsonb_build_object(
        'status', 'conflict',
        'code', 'schedule_unavailable',
        'event_id', p_event_id
      );
  END;

  IF v_response IS NOT NULL THEN
    PERFORM public.record_event_sync_conflict(
      p_operation_id,
      v_actor,
      p_event_id,
      'save',
      p_expected_version,
      v_response->>'code',
      v_request_payload,
      v_response
    );

    RETURN v_response;
  END IF;

  IF p_resolves_operation_id IS NOT NULL THEN
    UPDATE public.event_sync_conflicts
    SET status = 'applied',
        resolution_operation_id = p_operation_id,
        resolved_at = pg_catalog.now()
    WHERE operation_id = p_resolves_operation_id
      AND actor_id = v_actor
      AND event_id = p_event_id
      AND operation_kind = 'save'
      AND status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'The pending save conflict could not be reconciled';
    END IF;
  END IF;

  v_response := pg_catalog.jsonb_build_object(
    'status', 'confirmed',
    'event_id', p_event_id,
    'version', v_event_version
  );

  UPDATE public.event_operation_receipts
  SET response = v_response
  WHERE operation_id = p_operation_id
    AND actor_id = v_actor
    AND event_id = p_event_id
    AND operation_kind = 'save'
    AND request_payload = v_request_payload;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Operation receipt could not be finalized';
  END IF;

  RETURN v_response;
END;
$$;

ALTER FUNCTION public.save_event(
  uuid, uuid, bigint, text, text, text, date,
  time without time zone, time without time zone, uuid[],
  boolean, integer, text, uuid
) OWNER TO postgres;


-- 5. Cancel an event without implicitly resolving pending operations

CREATE OR REPLACE FUNCTION public.cancel_event(
  p_operation_id uuid,
  p_event_id uuid,
  p_expected_version bigint,
  p_resolves_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_version bigint;
  v_status text;
  v_new_version bigint;
  v_response jsonb;
  v_receipt public.event_operation_receipts%ROWTYPE;
  v_conflict public.event_sync_conflicts%ROWTYPE;
  v_request_payload jsonb;
  v_rows bigint;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Operation ID is required';
  END IF;

  v_request_payload := pg_catalog.jsonb_build_object(
    'operation_kind', 'cancel',
    'event_id', p_event_id,
    'expected_version', p_expected_version,
    'resolves_operation_id', p_resolves_operation_id
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );

  SELECT r.*
  INTO v_receipt
  FROM public.event_operation_receipts AS r
  WHERE r.operation_id = p_operation_id;

  IF FOUND THEN
    IF v_receipt.actor_id = v_actor
       AND v_receipt.event_id IS NOT DISTINCT FROM p_event_id
       AND v_receipt.operation_kind = 'cancel'
       AND v_receipt.request_payload = v_request_payload THEN
      RETURN v_receipt.response;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'code', 'operation_id_reused'
    );
  END IF;

  INSERT INTO public.event_operation_receipts (
    operation_id,
    actor_id,
    event_id,
    operation_kind,
    request_payload,
    response
  ) VALUES (
    p_operation_id,
    v_actor,
    p_event_id,
    'cancel',
    v_request_payload,
    pg_catalog.jsonb_build_object('status', 'processing')
  );

  IF p_event_id IS NULL THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'cancel',
      v_request_payload, 'invalid_event_id'
    );
  END IF;

  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'cancel',
      v_request_payload, 'invalid_version'
    );
  END IF;

  SELECT e.version, e.status
  INTO v_version, v_status
  FROM public.events AS e
  WHERE e.id = p_event_id
    AND e.owner_id = v_actor
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN public.reject_event_operation(
      p_operation_id, v_actor, p_event_id, 'cancel',
      v_request_payload, 'event_not_editable'
    );
  END IF;

  IF p_resolves_operation_id IS NOT NULL THEN
    IF p_resolves_operation_id = p_operation_id THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'cancel',
        v_request_payload, 'invalid_reconciliation'
      );
    END IF;

    SELECT c.*
    INTO v_conflict
    FROM public.event_sync_conflicts AS c
    WHERE c.operation_id = p_resolves_operation_id
      AND c.actor_id = v_actor
      AND c.event_id = p_event_id
      AND c.operation_kind = 'cancel'
      AND c.status = 'pending'
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN public.reject_event_operation(
        p_operation_id, v_actor, p_event_id, 'cancel',
        v_request_payload, 'conflict_not_pending'
      );
    END IF;
  END IF;

  IF v_status <> 'confirmed' THEN
    v_response := pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'code', 'event_not_active',
      'event_id', p_event_id
    );

    PERFORM public.record_event_sync_conflict(
      p_operation_id, v_actor, p_event_id, 'cancel',
      p_expected_version, 'event_not_active',
      v_request_payload, v_response
    );

    RETURN v_response;
  END IF;

  IF v_version <> p_expected_version THEN
    v_response := pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'code', 'version_conflict',
      'event_id', p_event_id
    );

    PERFORM public.record_event_sync_conflict(
      p_operation_id, v_actor, p_event_id, 'cancel',
      p_expected_version, 'version_conflict',
      v_request_payload, v_response
    );

    RETURN v_response;
  END IF;

  v_new_version := v_version + 1;

  UPDATE public.events
  SET status = 'cancelled',
      cancelled_at = pg_catalog.now(),
      updated_at = pg_catalog.now(),
      version = v_new_version
  WHERE id = p_event_id;

  DELETE FROM public.event_reservations AS er
  WHERE er.event_id = p_event_id;

  PERFORM public.append_event_sync_changes(
    p_event_id,
    v_new_version,
    ARRAY[v_actor]::uuid[] || ARRAY(
      SELECT ep.user_id
      FROM public.event_participants AS ep
      WHERE ep.event_id = p_event_id
    ),
    ARRAY[]::uuid[]
  );

  IF p_resolves_operation_id IS NOT NULL THEN
    UPDATE public.event_sync_conflicts
    SET status = 'applied',
        resolution_operation_id = p_operation_id,
        resolved_at = pg_catalog.now()
    WHERE operation_id = p_resolves_operation_id
      AND actor_id = v_actor
      AND event_id = p_event_id
      AND operation_kind = 'cancel'
      AND status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'The pending cancel conflict could not be reconciled';
    END IF;
  END IF;

  v_response := pg_catalog.jsonb_build_object(
    'status', 'confirmed',
    'event_id', p_event_id,
    'version', v_new_version
  );

  UPDATE public.event_operation_receipts
  SET response = v_response
  WHERE operation_id = p_operation_id
    AND actor_id = v_actor
    AND event_id = p_event_id
    AND operation_kind = 'cancel'
    AND request_payload = v_request_payload;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Operation receipt could not be finalized';
  END IF;

  RETURN v_response;
END;
$$;

ALTER FUNCTION public.cancel_event(uuid, uuid, bigint, uuid)
  OWNER TO postgres;


-- 6. Explicitly discard one pending conflict

CREATE OR REPLACE FUNCTION public.discard_event_sync_conflict(
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_conflict public.event_sync_conflicts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Operation ID is required';
  END IF;

  SELECT c.*
  INTO v_conflict
  FROM public.event_sync_conflicts AS c
  WHERE c.operation_id = p_operation_id
    AND c.actor_id = v_actor
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_conflict.status = 'discarded' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'discarded',
      'operation_id', p_operation_id
    );
  END IF;

  IF v_conflict.status = 'applied' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_applied',
      'operation_id', p_operation_id
    );
  END IF;

  UPDATE public.event_sync_conflicts
  SET status = 'discarded',
      discarded_at = pg_catalog.now()
  WHERE operation_id = p_operation_id
    AND actor_id = v_actor
    AND status = 'pending';

  RETURN pg_catalog.jsonb_build_object(
    'status', 'discarded',
    'operation_id', p_operation_id
  );
END;
$$;

ALTER FUNCTION public.discard_event_sync_conflict(uuid) OWNER TO postgres;


-- 7. Function and table privileges

REVOKE ALL ON FUNCTION public.can_read_event(uuid)
  FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.append_event_sync_changes(
  uuid, bigint, uuid[], uuid[]
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.record_event_sync_conflict(
  uuid, uuid, uuid, text, bigint, text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.reject_event_operation(
  uuid, uuid, uuid, text, jsonb, text
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.save_event(
  uuid, uuid, bigint, text, text, text, date,
  time without time zone, time without time zone, uuid[],
  boolean, integer, text, uuid
) FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.cancel_event(uuid, uuid, bigint, uuid)
  FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.discard_event_sync_conflict(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.can_read_event(uuid)
  TO authenticated;

GRANT EXECUTE ON FUNCTION public.save_event(
  uuid, uuid, bigint, text, text, text, date,
  time without time zone, time without time zone, uuid[],
  boolean, integer, text, uuid
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.cancel_event(uuid, uuid, bigint, uuid)
  TO authenticated;

GRANT EXECUTE ON FUNCTION public.discard_event_sync_conflict(uuid)
  TO authenticated;

REVOKE ALL ON TABLE public.events,
              public.event_participants,
              public.event_reservations,
              public.event_operation_receipts,
              public.event_sync_state,
              public.event_sync_changes,
              public.event_sync_conflicts
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.events,
                public.event_participants,
                public.event_sync_state,
                public.event_sync_changes,
                public.event_sync_conflicts
TO authenticated;

COMMIT;
