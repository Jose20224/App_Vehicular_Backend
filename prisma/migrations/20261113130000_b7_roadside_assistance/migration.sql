-- B7: proveedores operativos, cobertura PostGIS, requests de auxilio y acciones de un solo uso.
BEGIN;

ALTER TABLE public.assistance_providers
  ADD COLUMN phone_ciphertext BYTEA NULL,
  ADD COLUMN phone_nonce BYTEA NULL,
  ADD COLUMN phone_tag BYTEA NULL,
  ADD COLUMN phone_encrypted_dek BYTEA NULL,
  ADD COLUMN phone_key_version VARCHAR(100) NULL,
  ADD COLUMN phone_aad_version SMALLINT NULL,
  ADD COLUMN phone_hmac BYTEA NULL,
  ADD COLUMN phone_hmac_key_version VARCHAR(100) NULL,
  ADD COLUMN whatsapp_ciphertext BYTEA NULL,
  ADD COLUMN whatsapp_nonce BYTEA NULL,
  ADD COLUMN whatsapp_tag BYTEA NULL,
  ADD COLUMN whatsapp_encrypted_dek BYTEA NULL,
  ADD COLUMN whatsapp_key_version VARCHAR(100) NULL,
  ADD COLUMN whatsapp_aad_version SMALLINT NULL,
  ADD COLUMN whatsapp_hmac BYTEA NULL,
  ADD COLUMN whatsapp_hmac_key_version VARCHAR(100) NULL,
  ADD COLUMN coverage_area geometry(MultiPolygon,4326) NULL,
  ADD COLUMN is_24_hours BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN availability_status VARCHAR(20) NOT NULL DEFAULT 'available';

ALTER TABLE public.assistance_providers
  ADD CONSTRAINT chk_assistance_providers_phone_metadata CHECK (
    (phone_ciphertext IS NULL AND phone_nonce IS NULL AND phone_tag IS NULL AND phone_encrypted_dek IS NULL
      AND phone_key_version IS NULL AND phone_aad_version IS NULL AND phone_hmac IS NULL AND phone_hmac_key_version IS NULL)
    OR (phone_ciphertext IS NOT NULL AND phone_nonce IS NOT NULL AND phone_tag IS NOT NULL AND phone_encrypted_dek IS NOT NULL
      AND phone_key_version IS NOT NULL AND phone_aad_version IN (1,2) AND phone_hmac IS NOT NULL AND phone_hmac_key_version IS NOT NULL)
  ),
  ADD CONSTRAINT chk_assistance_providers_whatsapp_metadata CHECK (
    (whatsapp_ciphertext IS NULL AND whatsapp_nonce IS NULL AND whatsapp_tag IS NULL AND whatsapp_encrypted_dek IS NULL
      AND whatsapp_key_version IS NULL AND whatsapp_aad_version IS NULL AND whatsapp_hmac IS NULL AND whatsapp_hmac_key_version IS NULL)
    OR (whatsapp_ciphertext IS NOT NULL AND whatsapp_nonce IS NOT NULL AND whatsapp_tag IS NOT NULL AND whatsapp_encrypted_dek IS NOT NULL
      AND whatsapp_key_version IS NOT NULL AND whatsapp_aad_version IN (1,2) AND whatsapp_hmac IS NOT NULL AND whatsapp_hmac_key_version IS NOT NULL)
  ),
  ADD CONSTRAINT chk_assistance_providers_availability CHECK (availability_status IN ('available','busy','unavailable')),
  ADD CONSTRAINT chk_assistance_providers_coverage_valid CHECK (
    coverage_area IS NULL OR (ST_SRID(coverage_area) = 4326 AND ST_IsValid(coverage_area) AND NOT ST_IsEmpty(coverage_area))
  ),
  ADD CONSTRAINT chk_assistance_providers_published_complete CHECK (
    status <> 'active' OR (
      verified_at IS NOT NULL AND coverage_area IS NOT NULL AND base_location IS NOT NULL
      AND nullif(btrim(address_reference_text), '') IS NOT NULL
      AND phone_ciphertext IS NOT NULL
    )
  );
CREATE INDEX idx_assistance_providers_coverage_gist ON public.assistance_providers USING GIST(coverage_area) WHERE coverage_area IS NOT NULL;
CREATE INDEX idx_assistance_providers_availability ON public.assistance_providers(availability_status, is_24_hours, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_assistance_providers_verified ON public.assistance_providers(status, verified_at) WHERE deleted_at IS NULL;

-- Alinear estados del request con el contrato B7. Los datos históricos conservan su significado.
ALTER TABLE public.assistance_requests
  DROP CONSTRAINT chk_assistance_requests_status,
  ADD COLUMN sent_at TIMESTAMPTZ(6) NULL,
  ADD COLUMN en_camino_at TIMESTAMPTZ(6) NULL,
  ALTER COLUMN status SET DEFAULT 'created';
UPDATE public.assistance_requests SET status = CASE status
  WHEN 'requested' THEN 'created'
  WHEN 'notified' THEN 'sent'
  WHEN 'in_progress' THEN 'en_camino'
  WHEN 'expired' THEN 'cancelled'
  ELSE status END,
  sent_at = CASE WHEN status = 'notified' THEN COALESCE(sent_at, requested_at) ELSE sent_at END,
  cancelled_at = CASE WHEN status = 'expired' THEN COALESCE(cancelled_at, updated_at) ELSE cancelled_at END;
ALTER TABLE public.assistance_requests
  ADD CONSTRAINT chk_assistance_requests_status CHECK (status IN ('created','sent','accepted','en_camino','completed','cancelled'));
DROP INDEX IF EXISTS public.uq_assistance_requests_user_active_vehicle;
CREATE UNIQUE INDEX uq_assistance_requests_user_active_vehicle
  ON public.assistance_requests(user_id, COALESCE(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL AND status IN ('created','sent','accepted','en_camino');

ALTER TABLE public.assistance_requests
  ADD CONSTRAINT fk_assistance_requests_provider
  FOREIGN KEY (assistance_provider_id) REFERENCES public.assistance_providers(id) ON DELETE RESTRICT;

CREATE TABLE public.assistance_action_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.assistance_requests(id) ON DELETE RESTRICT,
  token_hash BYTEA NOT NULL,
  target_status VARCHAR(24) NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  used_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_assistance_action_tokens_hash UNIQUE(token_hash),
  CONSTRAINT chk_assistance_action_tokens_target CHECK (target_status IN ('accepted','en_camino','completed','cancelled')),
  CONSTRAINT chk_assistance_action_tokens_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idx_assistance_action_tokens_request_expiry ON public.assistance_action_tokens(request_id, expires_at);
CREATE INDEX idx_assistance_action_tokens_expiry ON public.assistance_action_tokens(expires_at) WHERE used_at IS NULL;

CREATE TABLE public.assistance_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.assistance_requests(id) ON DELETE RESTRICT,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NOT NULL,
  actor_type VARCHAR(16) NOT NULL,
  actor_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_assistance_request_events_actor CHECK (actor_type IN ('driver','provider','system')),
  CONSTRAINT chk_assistance_request_events_status CHECK (to_status IN ('created','sent','accepted','en_camino','completed','cancelled'))
);
CREATE INDEX idx_assistance_request_events_request_created ON public.assistance_request_events(request_id, created_at);

GRANT SELECT, INSERT, UPDATE ON public.assistance_action_tokens TO app_runtime;
GRANT SELECT, INSERT ON public.assistance_request_events TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.assistance_providers, public.assistance_requests TO app_runtime;

COMMENT ON COLUMN public.assistance_providers.coverage_area IS 'Cobertura operativa como MultiPolygon SRID 4326; filtrar con ST_Covers y GIST.';
COMMENT ON COLUMN public.assistance_providers.is_24_hours IS 'Indica servicio continuo 24/7, no una garantía de tiempo de llegada.';
COMMENT ON COLUMN public.assistance_providers.availability_status IS 'available, busy o unavailable; snapshot operativo del proveedor.';
COMMENT ON TABLE public.assistance_action_tokens IS 'Tokens hash de un solo uso para transiciones del proveedor; nunca almacena token en claro.';
COMMENT ON TABLE public.assistance_request_events IS 'Historial append-only de transiciones de solicitudes de asistencia.';

COMMIT;
