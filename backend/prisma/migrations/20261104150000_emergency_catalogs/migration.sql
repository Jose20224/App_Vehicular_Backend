-- B5: catálogos nacionales, números públicos verificados y contactos privados.
CREATE TABLE public.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  administrative_type VARCHAR(24) NOT NULL CHECK (administrative_type IN ('department', 'autonomous_region')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_departments_name CHECK (length(btrim(name)) > 0)
);
CREATE INDEX idx_departments_active_order ON public.departments(is_active, sort_order, name);

CREATE TABLE public.municipalities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_municipalities_id_department UNIQUE (id, department_id),
  CONSTRAINT chk_municipalities_name CHECK (length(btrim(name)) > 0)
);
CREATE INDEX idx_municipalities_department_order ON public.municipalities(department_id, is_active, sort_order, name);

CREATE TABLE public.service_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(300),
  is_emergency BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_service_types_name CHECK (length(btrim(name)) > 0)
);
CREATE INDEX idx_service_types_active_order ON public.service_types(is_active, sort_order, name);

CREATE TABLE public.specialties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(300),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_specialties_name CHECK (length(btrim(name)) > 0)
);
CREATE INDEX idx_specialties_active_order ON public.specialties(is_active, sort_order, name);

CREATE TABLE public.emergency_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(120) NOT NULL,
  category VARCHAR(40) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  department_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT,
  municipality_id UUID,
  source_name VARCHAR(180),
  source_url VARCHAR(500),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ(6),
  verified_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  notes VARCHAR(500),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_emergency_numbers_municipality_department
    FOREIGN KEY (municipality_id, department_id) REFERENCES public.municipalities(id, department_id) ON DELETE RESTRICT,
  CONSTRAINT chk_emergency_numbers_label CHECK (length(btrim(label)) > 0),
  CONSTRAINT chk_emergency_numbers_category CHECK (length(btrim(category)) > 0),
  CONSTRAINT chk_emergency_numbers_phone CHECK (phone_number ~ '^(\+[1-9][0-9]{7,14}|[0-9]{3,10})$'),
  CONSTRAINT chk_emergency_numbers_verification CHECK (
    (verified = FALSE AND verified_at IS NULL AND verified_by_user_id IS NULL)
    OR (verified = TRUE AND verified_at IS NOT NULL AND source_name IS NOT NULL AND length(btrim(source_name)) > 0)
  ),
  CONSTRAINT chk_emergency_numbers_municipality_requires_department CHECK (municipality_id IS NULL OR department_id IS NOT NULL)
);
CREATE INDEX idx_emergency_numbers_public ON public.emergency_numbers(is_active, verified, category);
CREATE INDEX idx_emergency_numbers_location ON public.emergency_numbers(department_id, municipality_id);
CREATE INDEX idx_emergency_numbers_updated ON public.emergency_numbers(updated_at DESC);

CREATE TABLE public.emergency_contacts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  relationship_label VARCHAR(40),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  phone_ciphertext BYTEA,
  phone_nonce BYTEA,
  phone_tag BYTEA,
  phone_encrypted_dek BYTEA,
  phone_key_version VARCHAR(100),
  phone_aad_version INTEGER DEFAULT 2,
  phone_hmac BYTEA,
  phone_hmac_key_version VARCHAR(100),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6),
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT uq_emergency_contacts_id_user UNIQUE (id, user_id),
  CONSTRAINT chk_emergency_contacts_uuid_v7 CHECK (substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')),
  CONSTRAINT chk_emergency_contacts_name CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_emergency_contacts_aad_version CHECK (phone_aad_version IS NULL OR phone_aad_version IN (1,2)),
  CONSTRAINT chk_emergency_contacts_phone_metadata CHECK (
    (deleted_at IS NOT NULL AND phone_ciphertext IS NULL AND phone_nonce IS NULL AND phone_tag IS NULL AND phone_encrypted_dek IS NULL AND phone_key_version IS NULL AND phone_hmac IS NULL AND phone_hmac_key_version IS NULL)
    OR (phone_ciphertext IS NOT NULL AND phone_nonce IS NOT NULL AND octet_length(phone_nonce) = 12 AND phone_tag IS NOT NULL AND octet_length(phone_tag) = 16 AND phone_encrypted_dek IS NOT NULL AND phone_key_version IS NOT NULL AND phone_hmac IS NOT NULL AND phone_hmac_key_version IS NOT NULL AND phone_aad_version IN (1,2))
  )
);
CREATE INDEX idx_emergency_contacts_user_id ON public.emergency_contacts(user_id);
CREATE INDEX idx_emergency_contacts_user_sync_version ON public.emergency_contacts(user_id, sync_version);
CREATE INDEX idx_emergency_contacts_user_active ON public.emergency_contacts(user_id, created_at) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_emergency_contacts_primary_user ON public.emergency_contacts(user_id) WHERE is_primary = TRUE AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.enforce_emergency_contact_limit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE active_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'El propietario de un contacto de emergencia no puede cambiar.'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_emergency_contacts_owner_immutable';
  END IF;
  IF NEW.deleted_at IS NULL AND (TG_OP = 'INSERT' OR OLD.deleted_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
    SELECT count(*) INTO active_count FROM public.emergency_contacts
      WHERE user_id = NEW.user_id AND deleted_at IS NULL AND id <> NEW.id;
    IF active_count >= 5 THEN
      RAISE EXCEPTION 'Un usuario no puede tener más de cinco contactos de emergencia.'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_emergency_contacts_max_five';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_emergency_contact_limit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_emergency_contact_limit() TO app_runtime;
CREATE TRIGGER a_emergency_contacts_limit BEFORE INSERT OR UPDATE ON public.emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_emergency_contact_limit();
CREATE TRIGGER z_emergency_contacts_sync_metadata BEFORE INSERT OR UPDATE ON public.emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();

-- Cambiar el número o su ámbito invalida la verificación anterior incluso fuera del servicio NestJS.
CREATE OR REPLACE FUNCTION public.invalidate_emergency_number_verification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.phone_number, NEW.category, NEW.department_id, NEW.municipality_id)
       IS DISTINCT FROM ROW(OLD.phone_number, OLD.category, OLD.department_id, OLD.municipality_id)
     AND NOT (
       NEW.verified = TRUE
       AND NEW.verified_at IS NOT NULL
       AND NEW.verified_by_user_id IS NOT NULL
       AND NEW.source_name IS NOT NULL
       AND length(btrim(NEW.source_name)) > 0
     ) THEN
    NEW.verified := FALSE;
    NEW.verified_at := NULL;
    NEW.verified_by_user_id := NULL;
    NEW.source_name := NULL;
    NEW.source_url := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_emergency_number_verification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invalidate_emergency_number_verification() TO app_runtime;
CREATE TRIGGER a_emergency_numbers_invalidate_verification
  BEFORE UPDATE ON public.emergency_numbers
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_emergency_number_verification();

-- El mismo trigger de bump utilizado por B2/B3 invalida ETags aun cuando se edite un registro.
INSERT INTO public.catalog_versions(catalog_name, version) VALUES
  ('emergency-numbers', 0), ('service-types', 0), ('specialties', 0),
  ('departments', 0), ('municipalities', 0)
ON CONFLICT (catalog_name) DO NOTHING;
CREATE TRIGGER emergency_numbers_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON public.emergency_numbers
  FOR EACH ROW EXECUTE FUNCTION public.bump_vehicle_catalog_version('emergency-numbers');
CREATE TRIGGER service_types_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON public.service_types
  FOR EACH ROW EXECUTE FUNCTION public.bump_vehicle_catalog_version('service-types');
CREATE TRIGGER specialties_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON public.specialties
  FOR EACH ROW EXECUTE FUNCTION public.bump_vehicle_catalog_version('specialties');
CREATE TRIGGER departments_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.bump_vehicle_catalog_version('departments');
CREATE TRIGGER municipalities_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON public.municipalities
  FOR EACH ROW EXECUTE FUNCTION public.bump_vehicle_catalog_version('municipalities');

GRANT SELECT ON public.departments, public.municipalities, public.service_types, public.specialties, public.catalog_versions TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.emergency_numbers TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.emergency_contacts TO app_runtime;
COMMENT ON TABLE public.emergency_numbers IS 'Teléfonos de emergencia editables por admin; solo verified=true se publica y nunca se inventan números.';
COMMENT ON TABLE public.emergency_contacts IS 'Contactos privados cifrados AES-256-GCM AAD v2; máximo cinco contactos activos por usuario.';
COMMENT ON COLUMN public.municipalities.code IS 'Código interno estable de catálogo; no representa código oficial INIDE.';
