BEGIN;

DROP POLICY IF EXISTS resources_read_managers
  ON public.resources;

DROP POLICY IF EXISTS resources_read_authenticated
  ON public.resources;

DROP POLICY IF EXISTS resources_read_active_authenticated
  ON public.resources;

DROP POLICY IF EXISTS resources_read_trash_managers
  ON public.resources;

CREATE POLICY resources_read_authenticated
  ON public.resources
  FOR SELECT
  TO authenticated
  USING (deleted_at IS NULL);

GRANT SELECT ON TABLE public.resources TO authenticated;

COMMIT;
