ALTER TABLE public.vehicles ADD COLUMN plate_aad_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.vehicles ADD COLUMN vin_aad_version INTEGER NULL;
UPDATE public.vehicles SET vin_aad_version = 1 WHERE vin_ciphertext IS NOT NULL;
ALTER TABLE public.vehicles ADD CONSTRAINT chk_vehicles_aad_versions CHECK (plate_aad_version IN (1,2) AND (vin_aad_version IS NULL OR vin_aad_version IN (1,2)));

-- B3: documentos de vehículos, pólizas e insurers.
CREATE TYPE public.vehicle_document_type AS ENUM ('poliza', 'circulacion', 'revision', 'licencia', 'otro');
CREATE TYPE public.document_file_status AS ENUM ('pendiente_subida', 'disponible');
CREATE TYPE public.insurance_policy_status AS ENUM ('active', 'archived');

CREATE TABLE public.insurers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  normalized_name VARCHAR(120) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_insurers_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_insurers_normalized_nonempty CHECK (length(btrim(normalized_name)) > 0)
);
CREATE UNIQUE INDEX ux_insurers_normalized_name ON public.insurers(normalized_name);
CREATE INDEX idx_insurers_active_order ON public.insurers(is_active, sort_order, normalized_name);
INSERT INTO public.catalog_versions(catalog_name, version) VALUES ('insurers', 0) ON CONFLICT (catalog_name) DO NOTHING;
CREATE TRIGGER insurers_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON public.insurers
FOR EACH ROW EXECUTE FUNCTION public.bump_vehicle_catalog_version('insurers');

CREATE TABLE public.insurance_policies (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  vehicle_id UUID NOT NULL,
  insurer_id UUID NULL REFERENCES public.insurers(id) ON DELETE RESTRICT,
  other_insurer_name VARCHAR(120) NULL,
  policy_number_ciphertext BYTEA NOT NULL,
  policy_number_nonce BYTEA NOT NULL,
  policy_number_tag BYTEA NOT NULL,
  policy_number_encrypted_dek BYTEA NOT NULL,
  policy_number_key_version VARCHAR(100) NOT NULL,
  policy_number_aad_version INTEGER NOT NULL DEFAULT 2,
  valid_from DATE NOT NULL,
  valid_until DATE NOT NULL,
  deductible NUMERIC(12,2) NULL,
  premium NUMERIC(12,2) NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  claims_phone_ciphertext BYTEA NULL,
  claims_phone_nonce BYTEA NULL,
  claims_phone_tag BYTEA NULL,
  claims_phone_encrypted_dek BYTEA NULL,
  claims_phone_key_version VARCHAR(100) NULL,
  claims_phone_aad_version INTEGER NULL,
  status public.insurance_policy_status NOT NULL DEFAULT 'active',
  previous_policy_id UUID NULL REFERENCES public.insurance_policies(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_insurance_policies_vehicle_owner FOREIGN KEY (vehicle_id, user_id)
    REFERENCES public.vehicles(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_insurance_policy_insurer_xor_other CHECK (
    (insurer_id IS NOT NULL AND other_insurer_name IS NULL)
    OR (insurer_id IS NULL AND other_insurer_name IS NOT NULL AND length(btrim(other_insurer_name)) > 0)
  ),
  CONSTRAINT chk_insurance_policy_validity CHECK (valid_until > valid_from),
  CONSTRAINT chk_insurance_policy_deductible CHECK (deductible IS NULL OR deductible >= 0),
  CONSTRAINT chk_insurance_policy_premium CHECK (premium IS NULL OR premium >= 0),
  CONSTRAINT chk_insurance_policy_currency CHECK (currency IN ('USD', 'NIO')),
  CONSTRAINT chk_insurance_policy_aad_version CHECK (policy_number_aad_version IN (1, 2)),
  CONSTRAINT chk_insurance_policy_phone_metadata CHECK (
    (claims_phone_ciphertext IS NULL AND claims_phone_nonce IS NULL AND claims_phone_tag IS NULL
      AND claims_phone_encrypted_dek IS NULL AND claims_phone_key_version IS NULL AND claims_phone_aad_version IS NULL)
    OR (claims_phone_ciphertext IS NOT NULL AND claims_phone_nonce IS NOT NULL AND claims_phone_tag IS NOT NULL
      AND claims_phone_encrypted_dek IS NOT NULL AND claims_phone_key_version IS NOT NULL AND claims_phone_aad_version IS NOT NULL AND claims_phone_aad_version IN (1,2))
  ),
  CONSTRAINT chk_insurance_policy_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT ux_insurance_policies_id_user UNIQUE (id, user_id)
);
CREATE INDEX idx_insurance_policies_user_id ON public.insurance_policies(user_id);
CREATE INDEX idx_insurance_policies_user_sync_version ON public.insurance_policies(user_id, sync_version);
CREATE INDEX idx_insurance_policies_owner_vehicle_status ON public.insurance_policies(user_id, vehicle_id, status, deleted_at);
CREATE INDEX idx_insurance_policies_vehicle_expiry ON public.insurance_policies(vehicle_id, valid_until);
CREATE UNIQUE INDEX ux_insurance_policies_one_current_per_vehicle
  ON public.insurance_policies(vehicle_id) WHERE status = 'active' AND deleted_at IS NULL;

CREATE TABLE public.vehicle_documents (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  vehicle_id UUID NOT NULL,
  document_type public.vehicle_document_type NOT NULL,
  title VARCHAR(120) NOT NULL,
  issuer_name VARCHAR(120) NULL,
  valid_from DATE NULL,
  valid_until DATE NULL,
  file_status public.document_file_status NOT NULL DEFAULT 'pendiente_subida',
  file_object_key VARCHAR(700) NULL,
  pending_object_key VARCHAR(700) NULL,
  pending_content_type VARCHAR(100) NULL,
  pending_size_bytes BIGINT NULL,
  pending_url_issued_at TIMESTAMPTZ(6) NULL,
  file_content_type VARCHAR(100) NULL,
  file_size_bytes BIGINT NULL,
  original_file_name VARCHAR(255) NULL,
  insurance_policy_id UUID NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_vehicle_documents_vehicle_owner FOREIGN KEY (vehicle_id, user_id)
    REFERENCES public.vehicles(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_vehicle_documents_policy FOREIGN KEY (insurance_policy_id)
    REFERENCES public.insurance_policies(id) ON DELETE RESTRICT,
  CONSTRAINT chk_vehicle_documents_title_nonempty CHECK (length(btrim(title)) > 0),
  CONSTRAINT chk_vehicle_documents_validity CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  CONSTRAINT chk_vehicle_documents_pending_file CHECK (
    (pending_object_key IS NULL AND pending_content_type IS NULL AND pending_size_bytes IS NULL AND pending_url_issued_at IS NULL)
    OR (pending_object_key IS NOT NULL AND pending_content_type IS NOT NULL
      AND pending_content_type IN ('application/pdf','image/jpeg','image/png','image/heic')
      AND pending_size_bytes IS NOT NULL AND pending_size_bytes BETWEEN 1 AND 10485760
      AND pending_url_issued_at IS NOT NULL)
  ),
  CONSTRAINT chk_vehicle_documents_available_file CHECK (
    (file_object_key IS NULL AND file_content_type IS NULL AND file_size_bytes IS NULL)
    OR (file_object_key IS NOT NULL AND file_content_type IS NOT NULL
      AND file_content_type IN ('application/pdf','image/jpeg','image/png','image/heic')
      AND file_size_bytes IS NOT NULL AND file_size_bytes BETWEEN 1 AND 10485760)
  ),
  CONSTRAINT chk_vehicle_documents_file_state CHECK (
    (file_status = 'pendiente_subida' AND file_object_key IS NULL)
    OR (file_status = 'disponible' AND file_object_key IS NOT NULL AND pending_object_key IS NULL)
  ),
  CONSTRAINT chk_vehicle_documents_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT ux_vehicle_documents_id_user UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX ux_vehicle_documents_policy ON public.vehicle_documents(insurance_policy_id);
CREATE UNIQUE INDEX ux_vehicle_documents_file_key ON public.vehicle_documents(file_object_key);
CREATE UNIQUE INDEX ux_vehicle_documents_pending_key ON public.vehicle_documents(pending_object_key);
CREATE INDEX idx_vehicle_documents_user_id ON public.vehicle_documents(user_id);
CREATE INDEX idx_vehicle_documents_user_sync_version ON public.vehicle_documents(user_id, sync_version);
CREATE INDEX idx_vehicle_documents_owner_vehicle ON public.vehicle_documents(user_id, vehicle_id, deleted_at);
CREATE INDEX idx_vehicle_documents_vehicle_expiry ON public.vehicle_documents(vehicle_id, valid_until);

CREATE OR REPLACE FUNCTION public.validate_insurance_policy_relationships()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE previous_owner UUID; previous_vehicle UUID;
BEGIN
  IF NEW.previous_policy_id IS NOT NULL THEN
    SELECT user_id, vehicle_id INTO previous_owner, previous_vehicle
      FROM public.insurance_policies WHERE id = NEW.previous_policy_id;
    IF previous_owner IS NULL OR previous_owner <> NEW.user_id OR previous_vehicle <> NEW.vehicle_id THEN
      RAISE EXCEPTION 'La póliza anterior debe pertenecer al mismo usuario y vehículo.'
        USING ERRCODE = '23503', CONSTRAINT = 'fk_insurance_policy_previous_owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_insurance_policy_relationships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_insurance_policy_relationships() TO app_runtime;
CREATE TRIGGER a_insurance_policy_relationships
BEFORE INSERT OR UPDATE ON public.insurance_policies
FOR EACH ROW EXECUTE FUNCTION public.validate_insurance_policy_relationships();

CREATE OR REPLACE FUNCTION public.validate_vehicle_document_policy_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE policy_owner UUID; policy_vehicle UUID;
BEGIN
  IF NEW.insurance_policy_id IS NOT NULL THEN
    SELECT user_id, vehicle_id INTO policy_owner, policy_vehicle
      FROM public.insurance_policies WHERE id = NEW.insurance_policy_id;
    IF policy_owner IS NULL OR policy_owner <> NEW.user_id OR policy_vehicle <> NEW.vehicle_id THEN
      RAISE EXCEPTION 'La póliza asociada debe pertenecer al mismo usuario y vehículo.'
        USING ERRCODE = '23503', CONSTRAINT = 'fk_vehicle_document_policy_owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_vehicle_document_policy_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_vehicle_document_policy_owner() TO app_runtime;
CREATE TRIGGER a_vehicle_document_policy_owner
BEFORE INSERT OR UPDATE ON public.vehicle_documents
FOR EACH ROW EXECUTE FUNCTION public.validate_vehicle_document_policy_owner();

CREATE TRIGGER vehicle_documents_sync_metadata
BEFORE INSERT OR UPDATE ON public.vehicle_documents
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();
CREATE TRIGGER insurance_policies_sync_metadata
BEFORE INSERT OR UPDATE ON public.insurance_policies
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();

COMMENT ON TABLE public.vehicle_documents IS 'Documentos de vehículos propiedad del usuario. SYNC-READY; archivos privados con URLs firmadas.';
COMMENT ON TABLE public.insurance_policies IS 'Historial de pólizas de seguro propiedad del usuario. SYNC-READY; número cifrado con AES-256-GCM y AAD por fila.';
COMMENT ON TABLE public.insurers IS 'Catálogo de aseguradoras de solo lectura para clientes.';
COMMENT ON COLUMN public.insurance_policies.policy_number_aad_version IS 'Versión de AAD; v2 vincula criptográficamente user_id y record_id.';

GRANT SELECT, INSERT, UPDATE ON public.vehicle_documents, public.insurance_policies TO app_runtime;
REVOKE ALL ON public.insurers FROM app_runtime;
GRANT SELECT ON public.insurers TO app_runtime;
