-- B6: directorio de talleres, ofertas de servicio y métricas de contacto.
-- La fase de proveedores completará el perfil operativo de assistance_providers.
BEGIN;

CREATE TYPE public.workshop_status AS ENUM ('draft', 'pending_verification', 'active', 'suspended');
CREATE TYPE public.workshop_photo_status AS ENUM ('pending', 'published', 'rejected', 'hidden');
CREATE TYPE public.service_offering_status AS ENUM ('draft', 'published', 'suspended');
CREATE TYPE public.workshop_contact_event_type AS ENUM ('call', 'whatsapp', 'route_click');

CREATE TABLE public.assistance_providers (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name VARCHAR(140) NOT NULL,
  provider_type VARCHAR(32) NOT NULL,
  service_type_id UUID NOT NULL REFERENCES public.service_types(id) ON DELETE RESTRICT,
  description VARCHAR(1000) NULL,
  address_reference_text VARCHAR(300) NULL,
  department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  municipality_id UUID NULL,
  base_location geography(Point,4326) NULL,
  status public.workshop_status NOT NULL DEFAULT 'draft',
  verified_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_assistance_providers_municipality_department
    FOREIGN KEY (municipality_id, department_id)
    REFERENCES public.municipalities(id, department_id) ON DELETE RESTRICT,
  CONSTRAINT chk_assistance_providers_name CHECK (length(btrim(name)) BETWEEN 2 AND 140),
  CONSTRAINT chk_assistance_providers_type CHECK (length(btrim(provider_type)) BETWEEN 2 AND 32),
  CONSTRAINT chk_assistance_providers_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT uq_assistance_providers_id_user UNIQUE (id, user_id)
);
CREATE INDEX idx_assistance_providers_user_sync_version ON public.assistance_providers(user_id, sync_version);
CREATE INDEX idx_assistance_providers_type_status ON public.assistance_providers(service_type_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_assistance_providers_base_location_gist ON public.assistance_providers USING GIST(base_location) WHERE base_location IS NOT NULL;

CREATE TABLE public.workshops (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name VARCHAR(140) NOT NULL,
  slug VARCHAR(180) NOT NULL UNIQUE,
  description VARCHAR(1200) NULL,
  phone_ciphertext BYTEA NULL,
  phone_nonce BYTEA NULL,
  phone_tag BYTEA NULL,
  phone_encrypted_dek BYTEA NULL,
  phone_key_version VARCHAR(100) NULL,
  phone_aad_version SMALLINT NULL,
  whatsapp_ciphertext BYTEA NULL,
  whatsapp_nonce BYTEA NULL,
  whatsapp_tag BYTEA NULL,
  whatsapp_encrypted_dek BYTEA NULL,
  whatsapp_key_version VARCHAR(100) NULL,
  whatsapp_aad_version SMALLINT NULL,
  email_ciphertext BYTEA NULL,
  email_nonce BYTEA NULL,
  email_tag BYTEA NULL,
  email_encrypted_dek BYTEA NULL,
  email_key_version VARCHAR(100) NULL,
  email_aad_version SMALLINT NULL,
  address VARCHAR(300) NULL,
  address_reference_text VARCHAR(300) NULL,
  department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  municipality_id UUID NULL,
  location geography(Point,4326) NULL,
  weekly_schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  rating_average NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  status public.workshop_status NOT NULL DEFAULT 'draft',
  verified_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  search_document TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(address, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(address_reference_text, '')), 'D')
  ) STORED,
  CONSTRAINT fk_workshops_municipality_department
    FOREIGN KEY (municipality_id, department_id)
    REFERENCES public.municipalities(id, department_id) ON DELETE RESTRICT,
  CONSTRAINT chk_workshops_name CHECK (length(btrim(name)) BETWEEN 2 AND 140),
  CONSTRAINT chk_workshops_slug CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT chk_workshops_rating CHECK (rating_average BETWEEN 0 AND 5 AND rating_count >= 0),
  CONSTRAINT chk_workshops_schedule_object CHECK (jsonb_typeof(weekly_schedule) = 'object'),
  CONSTRAINT chk_workshops_contact_phone_metadata CHECK (
    (phone_ciphertext IS NULL AND phone_nonce IS NULL AND phone_tag IS NULL AND phone_encrypted_dek IS NULL AND phone_key_version IS NULL AND phone_aad_version IS NULL)
    OR (phone_ciphertext IS NOT NULL AND phone_nonce IS NOT NULL AND phone_tag IS NOT NULL AND phone_encrypted_dek IS NOT NULL AND phone_key_version IS NOT NULL AND phone_aad_version IN (1,2))
  ),
  CONSTRAINT chk_workshops_whatsapp_metadata CHECK (
    (whatsapp_ciphertext IS NULL AND whatsapp_nonce IS NULL AND whatsapp_tag IS NULL AND whatsapp_encrypted_dek IS NULL AND whatsapp_key_version IS NULL AND whatsapp_aad_version IS NULL)
    OR (whatsapp_ciphertext IS NOT NULL AND whatsapp_nonce IS NOT NULL AND whatsapp_tag IS NOT NULL AND whatsapp_encrypted_dek IS NOT NULL AND whatsapp_key_version IS NOT NULL AND whatsapp_aad_version IN (1,2))
  ),
  CONSTRAINT chk_workshops_email_metadata CHECK (
    (email_ciphertext IS NULL AND email_nonce IS NULL AND email_tag IS NULL AND email_encrypted_dek IS NULL AND email_key_version IS NULL AND email_aad_version IS NULL)
    OR (email_ciphertext IS NOT NULL AND email_nonce IS NOT NULL AND email_tag IS NOT NULL AND email_encrypted_dek IS NOT NULL AND email_key_version IS NOT NULL AND email_aad_version IN (1,2))
  ),
  -- Regla de aceptación reforzada en BD: una ficha sin referencia local no se activa.
  CONSTRAINT chk_workshops_active_profile_complete CHECK (
    status <> 'active' OR (
      nullif(btrim(address_reference_text), '') IS NOT NULL
      AND nullif(btrim(address), '') IS NOT NULL
      AND location IS NOT NULL
      AND department_id IS NOT NULL
      AND municipality_id IS NOT NULL
    )
  ),
  CONSTRAINT chk_workshops_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT uq_workshops_id_user UNIQUE (id, user_id)
);
CREATE INDEX idx_workshops_user_sync_version ON public.workshops(user_id, sync_version);
CREATE INDEX idx_workshops_municipality_visibility ON public.workshops(municipality_id, status, deleted_at);
CREATE INDEX idx_workshops_status_rating ON public.workshops(status, rating_average DESC, rating_count DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_workshops_location_gist ON public.workshops USING GIST(location) WHERE location IS NOT NULL;
CREATE INDEX idx_workshops_search_document_gin ON public.workshops USING GIN(search_document);

CREATE TABLE public.workshop_specialties (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  workshop_id UUID NOT NULL,
  specialty_id UUID NOT NULL REFERENCES public.specialties(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_workshop_specialties_workshop_owner FOREIGN KEY (workshop_id, user_id)
    REFERENCES public.workshops(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_workshop_specialties_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT uq_workshop_specialties_id_user UNIQUE (id, user_id)
);
CREATE INDEX idx_workshop_specialties_user_sync_version ON public.workshop_specialties(user_id, sync_version);
CREATE UNIQUE INDEX uq_workshop_specialties_active_pair ON public.workshop_specialties(workshop_id, specialty_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_workshop_specialties_specialty_workshop ON public.workshop_specialties(specialty_id, workshop_id) WHERE deleted_at IS NULL;

CREATE TABLE public.workshop_photos (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  workshop_id UUID NOT NULL,
  object_key VARCHAR(700) NOT NULL UNIQUE,
  alt_text VARCHAR(160) NULL,
  mime_type VARCHAR(80) NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 BYTEA NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  status public.workshop_photo_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_workshop_photos_workshop_owner FOREIGN KEY (workshop_id, user_id)
    REFERENCES public.workshops(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_workshop_photos_mime CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  CONSTRAINT chk_workshop_photos_size CHECK (size_bytes BETWEEN 1024 AND 10485760),
  CONSTRAINT chk_workshop_photos_checksum CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  CONSTRAINT chk_workshop_photos_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT uq_workshop_photos_id_user UNIQUE (id, user_id)
);
CREATE INDEX idx_workshop_photos_user_sync_version ON public.workshop_photos(user_id, sync_version);
CREATE INDEX idx_workshop_photos_workshop_visibility ON public.workshop_photos(workshop_id, status, sort_order) WHERE deleted_at IS NULL;

CREATE TABLE public.service_offerings (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  workshop_id UUID NULL,
  assistance_provider_id UUID NULL,
  service_type_id UUID NOT NULL REFERENCES public.service_types(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(600) NULL,
  price_min NUMERIC(12,2) NOT NULL,
  price_max NUMERIC(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  unit VARCHAR(80) NOT NULL,
  notes VARCHAR(600) NULL,
  last_updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  publication_status public.service_offering_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_service_offerings_workshop_owner FOREIGN KEY (workshop_id, user_id)
    REFERENCES public.workshops(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_service_offerings_provider_owner FOREIGN KEY (assistance_provider_id, user_id)
    REFERENCES public.assistance_providers(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_service_offerings_exactly_one_owner CHECK ((workshop_id IS NOT NULL) <> (assistance_provider_id IS NOT NULL)),
  CONSTRAINT chk_service_offerings_price_range CHECK (price_min > 0 AND price_max >= price_min),
  CONSTRAINT chk_service_offerings_currency CHECK (currency = 'USD'),
  CONSTRAINT chk_service_offerings_name CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  CONSTRAINT chk_service_offerings_unit CHECK (length(btrim(unit)) BETWEEN 1 AND 80),
  CONSTRAINT chk_service_offerings_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT uq_service_offerings_id_user UNIQUE (id, user_id)
);
CREATE INDEX idx_service_offerings_user_sync_version ON public.service_offerings(user_id, sync_version);
CREATE INDEX idx_service_offerings_workshop_status ON public.service_offerings(workshop_id, publication_status, is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_service_offerings_provider_status ON public.service_offerings(assistance_provider_id, publication_status, is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_service_offerings_type_status ON public.service_offerings(service_type_id, publication_status, is_active) WHERE deleted_at IS NULL;

-- Eventos agregables para métricas. No se guarda usuario, IP, teléfono, dispositivo ni coordenadas del visitante.
CREATE TABLE public.workshop_contact_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id UUID NOT NULL REFERENCES public.workshops(id) ON DELETE RESTRICT,
  event_type public.workshop_contact_event_type NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_workshop_contact_events_metrics ON public.workshop_contact_events(workshop_id, event_type, created_at DESC);

CREATE OR REPLACE FUNCTION public.workshop_is_open_now(p_schedule JSONB, p_at TIMESTAMPTZ DEFAULT clock_timestamp())
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_days TEXT[] := ARRAY['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  v_local TIMESTAMP := p_at AT TIME ZONE 'America/Managua';
  v_day INTEGER := extract(isodow FROM v_local)::INTEGER;
  v_today TEXT := v_days[v_day];
  v_previous TEXT := v_days[CASE WHEN v_day = 1 THEN 7 ELSE v_day - 1 END];
  v_clock TIME := v_local::time;
  v_period JSONB;
  v_open TIME;
  v_close TIME;
BEGIN
  IF jsonb_typeof(p_schedule) <> 'object' THEN RETURN FALSE; END IF;
  FOR v_period IN SELECT value FROM jsonb_array_elements(COALESCE(p_schedule -> v_today, '[]'::jsonb)) AS periods(value)
  LOOP
    v_open := (v_period ->> 'open')::time;
    v_close := (v_period ->> 'close')::time;
    IF v_open = v_close THEN RETURN TRUE; END IF;
    IF v_open < v_close AND v_clock >= v_open AND v_clock < v_close THEN RETURN TRUE; END IF;
    IF v_open > v_close AND v_clock >= v_open THEN RETURN TRUE; END IF;
  END LOOP;
  -- Un horario que cruza medianoche pertenece también al día anterior.
  FOR v_period IN SELECT value FROM jsonb_array_elements(COALESCE(p_schedule -> v_previous, '[]'::jsonb)) AS periods(value)
  LOOP
    v_open := (v_period ->> 'open')::time;
    v_close := (v_period ->> 'close')::time;
    IF v_open > v_close AND v_clock < v_close THEN RETURN TRUE; END IF;
  END LOOP;
  RETURN FALSE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_workshop_owner_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_role public.user_role;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id = NEW.user_id;
  IF v_role NOT IN ('workshop_owner'::public.user_role, 'admin'::public.user_role) THEN
    RAISE EXCEPTION 'WORKSHOP_OWNER_ROLE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_provider_owner_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_role public.user_role;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id = NEW.user_id;
  IF v_role NOT IN ('provider_owner'::public.user_role, 'admin'::public.user_role) THEN
    RAISE EXCEPTION 'PROVIDER_OWNER_ROLE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_service_offering_last_updated()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.last_updated_at := clock_timestamp();
  ELSIF (NEW.price_min, NEW.price_max, NEW.currency, NEW.unit, NEW.notes)
      IS DISTINCT FROM (OLD.price_min, OLD.price_max, OLD.currency, OLD.unit, OLD.notes) THEN
    NEW.last_updated_at := clock_timestamp();
  ELSE
    -- Ediciones de nombre/descripción no rejuvenecen artificialmente un precio antiguo.
    NEW.last_updated_at := OLD.last_updated_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assistance_providers_owner_role
BEFORE INSERT OR UPDATE OF user_id ON public.assistance_providers
FOR EACH ROW EXECUTE FUNCTION public.enforce_provider_owner_role();
CREATE TRIGGER workshops_owner_role
BEFORE INSERT OR UPDATE OF user_id ON public.workshops
FOR EACH ROW EXECUTE FUNCTION public.enforce_workshop_owner_role();

CREATE TRIGGER assistance_providers_sync_metadata
BEFORE INSERT OR UPDATE ON public.assistance_providers
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();
CREATE TRIGGER workshops_sync_metadata
BEFORE INSERT OR UPDATE ON public.workshops
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();
CREATE TRIGGER workshop_specialties_sync_metadata
BEFORE INSERT OR UPDATE ON public.workshop_specialties
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();
CREATE TRIGGER workshop_photos_sync_metadata
BEFORE INSERT OR UPDATE ON public.workshop_photos
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();
CREATE TRIGGER service_offerings_touch_last_updated
BEFORE UPDATE ON public.service_offerings
FOR EACH ROW EXECUTE FUNCTION public.touch_service_offering_last_updated();
CREATE TRIGGER service_offerings_sync_metadata
BEFORE INSERT OR UPDATE ON public.service_offerings
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();

COMMENT ON TABLE public.workshops IS 'Directorio público de talleres. Solo status=active y no borrados se exponen; ubicación geography 4326 indexada con GiST.';
COMMENT ON COLUMN public.workshops.weekly_schedule IS 'JSON semanal America/Managua: claves monday..sunday con arrays {open: HH:MM, close: HH:MM}; intervalos pueden cruzar medianoche.';
COMMENT ON TABLE public.assistance_providers IS 'Ancla relacional mínima para FK compuesta de ServiceOffering; perfil funcional se completa en fase de proveedores.';
COMMENT ON TABLE public.service_offerings IS 'Precios estimados USD. CHECK de base de datos exige exactamente un dueño workshop XOR assistance_provider.';
COMMENT ON TABLE public.workshop_contact_events IS 'Métricas de interacción sin identificadores personales del visitante.';

GRANT EXECUTE ON FUNCTION public.workshop_is_open_now(JSONB, TIMESTAMPTZ) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.enforce_workshop_owner_role() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.enforce_provider_owner_role() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.touch_service_offering_last_updated() TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.workshops, public.assistance_providers,
  public.workshop_specialties, public.workshop_photos, public.service_offerings TO app_runtime;
GRANT SELECT, INSERT ON public.workshop_contact_events TO app_runtime;

COMMIT;
