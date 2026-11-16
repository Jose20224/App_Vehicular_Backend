-- B5S: sincronización offline-first. La secuencia global ya fue creada en B0.
-- Esta fase añade proyección del perfil, solicitudes de asistencia y tablas técnicas
-- independientes por canal/dispositivo. No concede acceso a la secuencia al runtime.
BEGIN;

ALTER TABLE public.users
  ADD COLUMN sync_version BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.assign_user_profile_sync_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := clock_timestamp();
    NEW.sync_version := nextval('public.sync_version_seq'::regclass);
    RETURN NEW;
  END IF;

  -- Inicio de sesión, verificación de teléfono y actualizaciones internas de
  -- autenticación no producen un cambio de perfil offline. Solo los campos de
  -- la proyección, el estado de cuenta o su eliminación generan versión.
  IF ROW(NEW.display_name, NEW.email_ciphertext, NEW.email_nonce, NEW.email_tag,
         NEW.email_encrypted_dek, NEW.email_key_version, NEW.email_hmac,
         NEW.email_hmac_key_version, NEW.status, NEW.deleted_at)
     IS DISTINCT FROM
     ROW(OLD.display_name, OLD.email_ciphertext, OLD.email_nonce, OLD.email_tag,
         OLD.email_encrypted_dek, OLD.email_key_version, OLD.email_hmac,
         OLD.email_hmac_key_version, OLD.status, OLD.deleted_at) THEN
    NEW.updated_at := clock_timestamp();
    NEW.sync_version := nextval('public.sync_version_seq'::regclass);
  ELSE
    -- La actividad de autenticación no debe alterar updated_at del perfil ni
    -- interferir con el LWW aplicado a la proyección offline.
    NEW.updated_at := OLD.updated_at;
    NEW.sync_version := OLD.sync_version;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.assign_user_profile_sync_metadata() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_user_profile_sync_metadata() TO app_runtime;
CREATE TRIGGER users_profile_sync_metadata
BEFORE INSERT OR UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.assign_user_profile_sync_metadata();

CREATE TABLE public.assistance_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  vehicle_id UUID NULL,
  service_type_id UUID NOT NULL REFERENCES public.service_types(id) ON DELETE RESTRICT,
  -- Se conserva como referencia hasta que exista el módulo/tabla de proveedores.
  -- No es un campo escribible desde el cliente móvil.
  assistance_provider_id UUID NULL,
  issue_description VARCHAR(1000) NOT NULL,
  address_reference_text VARCHAR(300) NOT NULL,
  location geography(Point,4326) NULL,
  department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  municipality_id UUID NULL,
  contact_phone_ciphertext BYTEA NULL,
  contact_phone_nonce BYTEA NULL,
  contact_phone_tag BYTEA NULL,
  contact_phone_encrypted_dek BYTEA NULL,
  contact_phone_key_version VARCHAR(100) NULL,
  contact_phone_aad_version INTEGER NULL,
  contact_phone_hmac BYTEA NULL,
  contact_phone_hmac_key_version VARCHAR(100) NULL,
  preferred_contact VARCHAR(16) NOT NULL DEFAULT 'whatsapp',
  status VARCHAR(24) NOT NULL DEFAULT 'requested',
  requested_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  accepted_at TIMESTAMPTZ(6) NULL,
  completed_at TIMESTAMPTZ(6) NULL,
  cancelled_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_assistance_requests_vehicle_owner FOREIGN KEY (vehicle_id, user_id)
    REFERENCES public.vehicles(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_assistance_requests_municipality_department FOREIGN KEY (municipality_id, department_id)
    REFERENCES public.municipalities(id, department_id) ON DELETE RESTRICT,
  CONSTRAINT chk_assistance_requests_municipality_parent CHECK (municipality_id IS NULL OR department_id IS NOT NULL),
  CONSTRAINT chk_assistance_requests_description CHECK (length(btrim(issue_description)) > 0),
  CONSTRAINT chk_assistance_requests_address_reference CHECK (length(btrim(address_reference_text)) > 0),
  CONSTRAINT chk_assistance_requests_preferred_contact CHECK (preferred_contact IN ('whatsapp','call','in_app')),
  CONSTRAINT chk_assistance_requests_status CHECK (status IN ('requested','notified','accepted','in_progress','completed','cancelled','expired')),
  CONSTRAINT chk_assistance_requests_contact_phone_metadata CHECK (
    (contact_phone_ciphertext IS NULL AND contact_phone_nonce IS NULL AND contact_phone_tag IS NULL
      AND contact_phone_encrypted_dek IS NULL AND contact_phone_key_version IS NULL
      AND contact_phone_aad_version IS NULL AND contact_phone_hmac IS NULL AND contact_phone_hmac_key_version IS NULL)
    OR
    (contact_phone_ciphertext IS NOT NULL AND contact_phone_nonce IS NOT NULL AND contact_phone_tag IS NOT NULL
      AND contact_phone_encrypted_dek IS NOT NULL AND contact_phone_key_version IS NOT NULL
      AND contact_phone_aad_version IS NOT NULL AND contact_phone_aad_version IN (1,2)
      AND contact_phone_hmac IS NOT NULL AND contact_phone_hmac_key_version IS NOT NULL)
  ),
  CONSTRAINT chk_assistance_requests_uuid_v7 CHECK (
    substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')
  ),
  CONSTRAINT uq_assistance_requests_id_user UNIQUE (id, user_id)
);
CREATE INDEX idx_assistance_requests_user_sync_version
  ON public.assistance_requests(user_id, sync_version);
CREATE INDEX idx_assistance_requests_user_created
  ON public.assistance_requests(user_id, created_at DESC, id DESC);
CREATE INDEX idx_assistance_requests_status_created
  ON public.assistance_requests(status, created_at DESC);
-- Una solicitud activa por usuario/vehículo. NULL vehicle_id comparte un único
-- espacio por cuenta mediante UUID centinela (no permitido como ID de vehículo).
CREATE UNIQUE INDEX uq_assistance_requests_user_active_vehicle
  ON public.assistance_requests (
    user_id,
    COALESCE(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE deleted_at IS NULL AND status IN ('requested','notified','accepted','in_progress');
CREATE INDEX idx_assistance_requests_provider_status
  ON public.assistance_requests(assistance_provider_id, status);
CREATE INDEX idx_assistance_requests_location
  ON public.assistance_requests USING GIST(location) WHERE location IS NOT NULL;
CREATE TRIGGER assistance_requests_sync_metadata
BEFORE INSERT OR UPDATE ON public.assistance_requests
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();

CREATE TABLE public.sync_channel_states (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  device_id UUID NOT NULL,
  channel VARCHAR(40) NOT NULL,
  acknowledged_cursor BIGINT NOT NULL DEFAULT 0 CHECK (acknowledged_cursor >= 0),
  last_pulled_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_sync_channel_states_device_owner FOREIGN KEY (user_id, device_id)
    REFERENCES public.sync_devices(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_sync_channel_states_channel CHECK (channel IN (
    'all','profile','vehicles','documents','policies','notification_preferences',
    'emergency_contacts','assistance_requests','reminders'
  )),
  CONSTRAINT pk_sync_channel_states PRIMARY KEY (device_id, channel)
);
CREATE INDEX idx_sync_channel_states_owner_channel_cursor
  ON public.sync_channel_states(user_id, channel, acknowledged_cursor);

CREATE TABLE public.sync_bootstraps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  device_id UUID NOT NULL,
  snapshot_sync_version BIGINT NOT NULL CHECK (snapshot_sync_version >= 0),
  expires_at TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_sync_bootstraps_device_owner FOREIGN KEY (user_id, device_id)
    REFERENCES public.sync_devices(user_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_sync_bootstraps_owner_device_expiry
  ON public.sync_bootstraps(user_id, device_id, expires_at);

CREATE TABLE public.sync_retention_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  minimum_valid_cursor BIGINT NOT NULL DEFAULT 0 CHECK (minimum_valid_cursor >= 0),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.sync_retention_state (id, minimum_valid_cursor) VALUES (1, 0);

CREATE TABLE public.processed_mutations (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  mutation_id UUID NOT NULL,
  device_id UUID NOT NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  result_ciphertext BYTEA NOT NULL,
  result_nonce BYTEA NOT NULL,
  result_tag BYTEA NOT NULL,
  result_encrypted_dek BYTEA NOT NULL,
  result_key_version VARCHAR(100) NOT NULL,
  processed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_processed_mutations_device_owner FOREIGN KEY (user_id, device_id)
    REFERENCES public.sync_devices(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT pk_processed_mutations PRIMARY KEY (user_id, mutation_id)
);
CREATE INDEX idx_processed_mutations_user_processed
  ON public.processed_mutations(user_id, processed_at);
CREATE INDEX idx_processed_mutations_processed_at
  ON public.processed_mutations(processed_at);
CREATE INDEX idx_processed_mutations_owner_entity
  ON public.processed_mutations(user_id, entity, entity_id);

COMMENT ON COLUMN public.users.sync_version IS
  'Versión de la proyección de perfil. ID de User permanece generado por servidor; teléfono y datos de autenticación no son editables offline.';
COMMENT ON TABLE public.sync_channel_states IS
  'Cursor reconocido por dispositivo y canal. Cada canal avanza de forma independiente; all se conserva como modo agregado compatible.';
COMMENT ON TABLE public.sync_bootstraps IS
  'Snapshots de bootstrap paginado por usuario/dispositivo; expiran en 24 horas.';
COMMENT ON TABLE public.processed_mutations IS
  'Resultados idempotentes cifrados. Retención mínima operativa definida en D-063: 180 días; no se purga automáticamente en esta fase.';
COMMENT ON TABLE public.assistance_requests IS
  'Solicitudes del conductor sincronizables offline; referencias textuales son obligatorias, coordenadas opcionales y proveedor asignado solo por servidor.';

GRANT SELECT, INSERT, UPDATE ON public.assistance_requests TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.sync_channel_states TO app_runtime;
GRANT SELECT, INSERT, DELETE ON public.sync_bootstraps TO app_runtime;
GRANT SELECT, INSERT ON public.processed_mutations TO app_runtime;
GRANT SELECT ON public.sync_retention_state TO app_runtime;

COMMIT;
