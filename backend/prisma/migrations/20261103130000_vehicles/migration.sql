-- B2: vehículos sync-ready, catálogos públicos y metadatos de versión.
CREATE TYPE public.vehicle_type AS ENUM ('motorcycle', 'automobile', 'pickup', 'truck', 'bus', 'other');
CREATE TYPE public.vehicle_photo_status AS ENUM ('none', 'pending_upload', 'available');

CREATE TABLE public.vehicle_brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL,
  normalized_name VARCHAR(80) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vehicle_brands_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT vehicle_brands_normalized_nonempty CHECK (length(btrim(normalized_name)) > 0)
);
CREATE UNIQUE INDEX ux_vehicle_brands_normalized_name ON public.vehicle_brands(normalized_name);
CREATE INDEX idx_vehicle_brands_active_order ON public.vehicle_brands(is_active, sort_order, normalized_name);

CREATE TABLE public.vehicle_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES public.vehicle_brands(id) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  normalized_name VARCHAR(100) NOT NULL,
  vehicle_category VARCHAR(30) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vehicle_models_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT vehicle_models_normalized_nonempty CHECK (length(btrim(normalized_name)) > 0),
  CONSTRAINT vehicle_models_id_brand_unique UNIQUE (id, brand_id)
);
CREATE UNIQUE INDEX ux_vehicle_models_brand_normalized_name ON public.vehicle_models(brand_id, normalized_name);
CREATE INDEX idx_vehicle_models_brand_active ON public.vehicle_models(brand_id, is_active, normalized_name);

CREATE TABLE public.catalog_versions (
  catalog_name VARCHAR(80) PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.catalog_versions(catalog_name, version)
VALUES ('vehicle-brands', 0), ('vehicle-models', 0);

CREATE OR REPLACE FUNCTION public.bump_vehicle_catalog_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  catalog_key TEXT := TG_ARGV[0];
BEGIN
  INSERT INTO public.catalog_versions(catalog_name, version, updated_at)
  VALUES (catalog_key, 1, clock_timestamp())
  ON CONFLICT (catalog_name) DO UPDATE
    SET version = public.catalog_versions.version + 1,
        updated_at = clock_timestamp();
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.bump_vehicle_catalog_version() FROM PUBLIC;

CREATE TRIGGER vehicle_brands_bump_catalog_version
AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_brands
FOR EACH ROW EXECUTE FUNCTION public.bump_vehicle_catalog_version('vehicle-brands');
CREATE TRIGGER vehicle_models_bump_catalog_version
AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_models
FOR EACH ROW EXECUTE FUNCTION public.bump_vehicle_catalog_version('vehicle-models');

CREATE TABLE public.vehicles (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  plate_ciphertext BYTEA NOT NULL,
  plate_nonce BYTEA NOT NULL,
  plate_tag BYTEA NOT NULL,
  plate_encrypted_dek BYTEA NOT NULL,
  plate_key_version VARCHAR(100) NOT NULL,
  plate_hmac BYTEA NOT NULL,
  plate_hmac_key_version VARCHAR(100) NOT NULL,
  brand_id UUID NULL REFERENCES public.vehicle_brands(id) ON DELETE RESTRICT,
  brand_label VARCHAR(80) NOT NULL,
  model_id UUID NULL REFERENCES public.vehicle_models(id) ON DELETE RESTRICT,
  model_label VARCHAR(100) NOT NULL,
  model_year SMALLINT NOT NULL,
  color VARCHAR(40) NULL,
  vehicle_type public.vehicle_type NOT NULL,
  nickname VARCHAR(80) NULL,
  vin_ciphertext BYTEA NULL,
  vin_nonce BYTEA NULL,
  vin_tag BYTEA NULL,
  vin_encrypted_dek BYTEA NULL,
  vin_key_version VARCHAR(100) NULL,
  vin_hmac BYTEA NULL,
  vin_hmac_key_version VARCHAR(100) NULL,
  mileage_km INTEGER NULL,
  photo_status public.vehicle_photo_status NOT NULL DEFAULT 'none',
  photo_object_key VARCHAR(700) NULL,
  photo_pending_object_key VARCHAR(700) NULL,
  photo_pending_mime_type VARCHAR(100) NULL,
  photo_pending_size_bytes BIGINT NULL,
  photo_mime_type VARCHAR(100) NULL,
  photo_size_bytes BIGINT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT chk_vehicles_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7'
    AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT chk_vehicles_model_year_min CHECK (model_year >= 1950),
  CONSTRAINT chk_vehicles_brand_label_nonempty CHECK (length(btrim(brand_label)) > 0),
  CONSTRAINT chk_vehicles_model_label_nonempty CHECK (length(btrim(model_label)) > 0),
  CONSTRAINT chk_vehicles_mileage_nonnegative CHECK (mileage_km IS NULL OR mileage_km >= 0),
  CONSTRAINT chk_vehicles_plate_hmac_length CHECK (octet_length(plate_hmac) = 32),
  CONSTRAINT chk_vehicles_vin_hmac_length CHECK (vin_hmac IS NULL OR octet_length(vin_hmac) = 32),
  CONSTRAINT chk_vehicles_vin_metadata_consistent CHECK (
    (vin_ciphertext IS NULL AND vin_nonce IS NULL AND vin_tag IS NULL AND vin_encrypted_dek IS NULL
      AND vin_key_version IS NULL AND vin_hmac IS NULL AND vin_hmac_key_version IS NULL)
    OR
    (vin_ciphertext IS NOT NULL AND vin_nonce IS NOT NULL AND vin_tag IS NOT NULL AND vin_encrypted_dek IS NOT NULL
      AND vin_key_version IS NOT NULL AND vin_hmac IS NOT NULL AND vin_hmac_key_version IS NOT NULL)
  ),
  CONSTRAINT chk_vehicles_photo_pending_metadata CHECK (
    (photo_pending_object_key IS NULL AND photo_pending_mime_type IS NULL AND photo_pending_size_bytes IS NULL)
    OR
    (photo_pending_object_key IS NOT NULL AND photo_pending_mime_type IN ('image/jpeg', 'image/png', 'image/webp')
      AND photo_pending_size_bytes > 0)
  ),
  CONSTRAINT chk_vehicles_photo_keys_distinct CHECK (
    photo_object_key IS NULL OR photo_pending_object_key IS NULL OR photo_object_key <> photo_pending_object_key
  ),
  CONSTRAINT chk_vehicles_photo_current_metadata CHECK (
    (photo_object_key IS NULL AND photo_mime_type IS NULL AND photo_size_bytes IS NULL)
    OR
    (photo_object_key IS NOT NULL AND photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')
      AND photo_size_bytes > 0)
  ),
  CONSTRAINT chk_vehicles_photo_status CHECK (
    (photo_status = 'none' AND photo_object_key IS NULL AND photo_pending_object_key IS NULL)
    OR (photo_status = 'pending_upload' AND photo_pending_object_key IS NOT NULL)
    OR (photo_status = 'available' AND photo_object_key IS NOT NULL AND photo_pending_object_key IS NULL)
  ),
  CONSTRAINT ux_vehicles_id_user UNIQUE (id, user_id)
);
CREATE INDEX idx_vehicles_user_id ON public.vehicles(user_id);
CREATE INDEX idx_vehicles_user_sync_version ON public.vehicles(user_id, sync_version);
CREATE INDEX idx_vehicles_user_created ON public.vehicles(user_id, created_at DESC, id DESC);
CREATE INDEX idx_vehicles_brand_model ON public.vehicles(brand_id, model_id);
CREATE UNIQUE INDEX ux_vehicles_user_plate_hmac_active
  ON public.vehicles(user_id, plate_hmac)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_vehicles_photo_object_key
  ON public.vehicles(photo_object_key) WHERE photo_object_key IS NOT NULL;
CREATE UNIQUE INDEX ux_vehicles_photo_pending_object_key
  ON public.vehicles(photo_pending_object_key) WHERE photo_pending_object_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_vehicle_catalog_and_year()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  catalog_brand_id UUID;
  current_year INTEGER := EXTRACT(YEAR FROM (clock_timestamp() AT TIME ZONE 'America/Managua'))::INTEGER;
BEGIN
  IF NEW.model_year > current_year + 1 THEN
    RAISE EXCEPTION 'model_year no puede superar el año actual más uno.'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_vehicles_model_year_max';
  END IF;
  IF NEW.model_id IS NOT NULL THEN
    SELECT brand_id INTO catalog_brand_id
    FROM public.vehicle_models WHERE id = NEW.model_id;
    IF catalog_brand_id IS NULL OR NEW.brand_id IS NULL OR catalog_brand_id <> NEW.brand_id THEN
      RAISE EXCEPTION 'El modelo no pertenece a la marca indicada.'
        USING ERRCODE = '23503', CONSTRAINT = 'fk_vehicles_model_brand';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_vehicle_catalog_and_year() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_vehicle_catalog_and_year() TO app_runtime;
CREATE TRIGGER a_vehicles_validate_catalog_and_year
BEFORE INSERT OR UPDATE OF brand_id, model_id, model_year ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.validate_vehicle_catalog_and_year();

CREATE TRIGGER z_vehicles_sync_metadata
BEFORE INSERT OR UPDATE ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();

COMMENT ON TABLE public.vehicles IS 'Vehículos del propietario; placa y VIN cifrados por la aplicación. SYNC-READY, UUID v7 cliente y sync_version por trigger global.';
COMMENT ON COLUMN public.vehicles.plate_hmac IS 'Índice ciego HMAC de la placa normalizada; permite unicidad por propietario sin texto claro.';
COMMENT ON COLUMN public.vehicles.brand_label IS 'Snapshot de marca para conservar el dato aunque el catálogo se desactive.';
COMMENT ON COLUMN public.vehicles.model_label IS 'Snapshot de modelo para conservar el dato aunque el catálogo se desactive.';

GRANT SELECT, INSERT, UPDATE ON public.vehicles TO app_runtime;
GRANT SELECT ON public.vehicle_brands, public.vehicle_models, public.catalog_versions TO app_runtime;
