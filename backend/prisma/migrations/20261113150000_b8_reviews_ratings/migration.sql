-- B8: reseñas y calificaciones con moderación administrativa y reputación protegida.
-- La publicidad y los propietarios no tienen permisos de moderación ni de edición de reseñas.
BEGIN;

CREATE TYPE public.review_status AS ENUM ('pending', 'published', 'rejected', 'removed');
CREATE TYPE public.review_report_status AS ENUM ('open', 'resolved', 'dismissed');

ALTER TABLE public.workshops
  ADD CONSTRAINT chk_workshops_rating_average CHECK (rating_average BETWEEN 0 AND 5),
  ADD CONSTRAINT chk_workshops_rating_count CHECK (rating_count >= 0);

CREATE TABLE public.reviews (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  workshop_id UUID NOT NULL REFERENCES public.workshops(id) ON DELETE RESTRICT,
  vehicle_id UUID NULL,
  rating SMALLINT NOT NULL,
  comment VARCHAR(500) NULL,
  status public.review_status NOT NULL DEFAULT 'pending',
  content_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_reason VARCHAR(300) NULL,
  moderated_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  moderated_at TIMESTAMPTZ(6) NULL,
  published_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  CONSTRAINT fk_reviews_vehicle FOREIGN KEY (vehicle_id)
    REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT chk_reviews_comment CHECK (comment IS NULL OR length(btrim(comment)) BETWEEN 1 AND 500),
  CONSTRAINT chk_reviews_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT chk_reviews_moderation_metadata CHECK (
    (status = 'pending' AND moderated_at IS NULL AND moderated_by_user_id IS NULL)
    OR (status <> 'pending' AND moderated_at IS NOT NULL AND moderated_by_user_id IS NOT NULL)
  ),
  CONSTRAINT chk_reviews_publication_timestamp CHECK (
    (status IN ('published','removed') AND published_at IS NOT NULL)
    OR (status IN ('pending','rejected') AND published_at IS NULL)
  ),
  CONSTRAINT chk_reviews_removed_soft_delete CHECK (
    (status = 'removed' AND deleted_at IS NOT NULL)
    OR (status <> 'removed' AND deleted_at IS NULL)
  )
);

CREATE INDEX idx_reviews_workshop_publication
  ON public.reviews(workshop_id, status, published_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_reviews_user_workshop_created
  ON public.reviews(user_id, workshop_id, created_at DESC);
CREATE INDEX idx_reviews_moderation_queue
  ON public.reviews(status, content_flagged DESC, created_at ASC)
  WHERE status = 'pending';
CREATE INDEX idx_reviews_vehicle ON public.reviews(vehicle_id) WHERE vehicle_id IS NOT NULL;

-- Refuerza también en PostgreSQL el límite temporal y serializa inserciones concurrentes.
CREATE OR REPLACE FUNCTION public.enforce_review_six_month_cooldown()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_workshop_id UUID;
BEGIN
  SELECT w.id INTO locked_workshop_id
  FROM public.workshops w
  WHERE w.id = NEW.workshop_id AND w.status = 'active' AND w.deleted_at IS NULL
  FOR UPDATE;
  IF locked_workshop_id IS NULL THEN
    RAISE EXCEPTION 'review_requires_active_workshop'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.reviews r
    WHERE r.user_id = NEW.user_id
      AND r.workshop_id = NEW.workshop_id
      AND r.created_at >= (clock_timestamp() - INTERVAL '6 months')
  ) THEN
    RAISE EXCEPTION 'review_cooldown_active'
      USING ERRCODE = '23505', CONSTRAINT = 'uq_reviews_user_workshop_six_months';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_reviews_six_month_cooldown
  BEFORE INSERT ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.enforce_review_six_month_cooldown();

CREATE TABLE public.review_replies (
  id UUID PRIMARY KEY,
  review_id UUID NOT NULL UNIQUE REFERENCES public.reviews(id) ON DELETE RESTRICT,
  workshop_id UUID NOT NULL,
  user_id UUID NOT NULL,
  reply_text VARCHAR(1200) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_review_replies_workshop_owner FOREIGN KEY (workshop_id, user_id)
    REFERENCES public.workshops(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_review_replies_text CHECK (length(btrim(reply_text)) BETWEEN 1 AND 1200),
  CONSTRAINT chk_review_replies_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  )
);
CREATE INDEX idx_review_replies_workshop_created
  ON public.review_replies(workshop_id, created_at DESC);

CREATE TABLE public.review_reports (
  id UUID PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES public.reviews(id) ON DELETE RESTRICT,
  reporter_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reporter_role VARCHAR(16) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status public.review_report_status NOT NULL DEFAULT 'open',
  reviewed_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_review_reports_role CHECK (reporter_role IN ('user','workshop_owner')),
  CONSTRAINT chk_review_reports_reason CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  CONSTRAINT chk_review_reports_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT chk_review_reports_resolution CHECK (
    (status = 'open' AND reviewed_at IS NULL AND reviewed_by_user_id IS NULL)
    OR (status <> 'open' AND reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL)
  )
);
CREATE INDEX idx_review_reports_status_created
  ON public.review_reports(status, created_at ASC);
CREATE INDEX idx_review_reports_review_created
  ON public.review_reports(review_id, created_at DESC);
CREATE UNIQUE INDEX uq_review_reports_active_reporter
  ON public.review_reports(review_id, reporter_user_id)
  WHERE status = 'open';

-- La modificación del contenido de una reseña y el borrado físico quedan prohibidos.
-- Las transiciones de moderación requieren un actor activo con rol admin en el contexto
-- de la transacción; las rutas de propietario/publicidad no pueden cumplir esa condición.
CREATE OR REPLACE FUNCTION public.guard_review_mutations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_id UUID;
  moderation_changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reviews_are_soft_deleted_and_never_physically_deleted'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.workshop_id IS DISTINCT FROM OLD.workshop_id
     OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
     OR NEW.rating IS DISTINCT FROM OLD.rating
     OR NEW.comment IS DISTINCT FROM OLD.comment
     OR NEW.content_flagged IS DISTINCT FROM OLD.content_flagged
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'review_content_is_immutable'
      USING ERRCODE = '42501';
  END IF;

  moderation_changed := NEW.status IS DISTINCT FROM OLD.status
    OR NEW.moderation_reason IS DISTINCT FROM OLD.moderation_reason
    OR NEW.moderated_by_user_id IS DISTINCT FROM OLD.moderated_by_user_id
    OR NEW.moderated_at IS DISTINCT FROM OLD.moderated_at
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at;

  IF moderation_changed THEN
    actor_id := NULLIF(current_setting('app.actor_user_id', TRUE), '')::uuid;
    IF actor_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = actor_id AND u.role::text = 'admin' AND u.status::text = 'active'
        AND u.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'only_active_admin_can_moderate_reviews'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.guard_review_vehicle_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vehicles v
    WHERE v.id = NEW.vehicle_id AND v.user_id = NEW.user_id AND v.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'review_vehicle_must_belong_to_author'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_reviews_vehicle_owner
  BEFORE INSERT ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_review_vehicle_owner();

CREATE TRIGGER trg_reviews_guard_update
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_review_mutations();
CREATE TRIGGER trg_reviews_guard_delete
  BEFORE DELETE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_review_mutations();

-- La respuesta solo se puede insertar para una reseña publicada del mismo taller.
-- El FK compuesto obliga además a que user_id sea el propietario real del taller.
CREATE OR REPLACE FUNCTION public.guard_review_reply_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews r
    WHERE r.id = NEW.review_id AND r.workshop_id = NEW.workshop_id
      AND r.status = 'published' AND r.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'reply_requires_published_review_of_same_workshop'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_review_replies_guard_insert
  BEFORE INSERT ON public.review_replies
  FOR EACH ROW EXECUTE FUNCTION public.guard_review_reply_insert();

-- La respuesta del negocio es de solo inserción en B8: no hay endpoint para editarla ni borrarla.
CREATE OR REPLACE FUNCTION public.prevent_review_reply_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'review_replies_are_immutable_in_b8'
    USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER trg_review_replies_immutable
  BEFORE UPDATE OR DELETE ON public.review_replies
  FOR EACH ROW EXECUTE FUNCTION public.prevent_review_reply_mutation();

-- rating_average y rating_count no pueden ser cambiados desde endpoints de taller o publicidad.
-- Únicamente el trigger de recálculo de reviews activa este contexto transaccional.
CREATE OR REPLACE FUNCTION public.guard_workshop_rating_summary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.rating_average IS DISTINCT FROM OLD.rating_average
      OR NEW.rating_count IS DISTINCT FROM OLD.rating_count)
     AND current_setting('app.review_rating_recalc', TRUE) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'workshop_rating_summary_is_managed_by_reviews'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_workshops_guard_rating_summary
  BEFORE UPDATE OF rating_average, rating_count ON public.workshops
  FOR EACH ROW EXECUTE FUNCTION public.guard_workshop_rating_summary();

CREATE OR REPLACE FUNCTION public.refresh_workshop_rating_from_reviews()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_workshop_id UUID;
BEGIN
  target_workshop_id := NEW.workshop_id;
  PERFORM set_config('app.review_rating_recalc', 'on', TRUE);
  UPDATE public.workshops w
  SET rating_average = stats.average_rating,
      rating_count = stats.review_count
  FROM (
    SELECT
      COALESCE(ROUND(AVG(r.rating)::numeric, 2), 0)::numeric(3,2) AS average_rating,
      COUNT(*)::integer AS review_count
    FROM public.reviews r
    WHERE r.workshop_id = target_workshop_id
      AND r.status = 'published'
      AND r.deleted_at IS NULL
  ) AS stats
  WHERE w.id = target_workshop_id;
  PERFORM set_config('app.review_rating_recalc', 'off', TRUE);
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_reviews_rating_after_insert
  AFTER INSERT ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.refresh_workshop_rating_from_reviews();
CREATE TRIGGER trg_reviews_rating_after_moderation
  AFTER UPDATE OF status, deleted_at ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.refresh_workshop_rating_from_reviews();

COMMENT ON TABLE public.reviews IS
  'B8: reseñas inmutables del autor; publicación/rechazo/retiro exclusivos de moderación admin. Rating agregado por trigger.';
COMMENT ON TABLE public.review_replies IS
  'B8: respuesta única e inmutable del propietario verificado del taller a una reseña publicada.';
COMMENT ON TABLE public.review_reports IS
  'B8: reportes de reseñas realizados por usuarios y propietarios de talleres; gestión exclusiva de admin.';
COMMENT ON COLUMN public.workshops.rating_average IS
  'Promedio de reseñas publicadas; no editable por el dueño ni publicidad.';
COMMENT ON COLUMN public.workshops.rating_count IS
  'Cantidad de reseñas publicadas; no editable por el dueño ni publicidad.';

COMMIT;
