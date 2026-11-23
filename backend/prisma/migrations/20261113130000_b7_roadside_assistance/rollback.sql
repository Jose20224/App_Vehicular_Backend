-- Reversa B7. Ejecutar solo en entornos aislados o de pruebas; producción debe preferir forward-fix.
BEGIN;

ALTER TABLE public.assistance_requests
  DROP CONSTRAINT IF EXISTS fk_assistance_requests_provider;
DROP INDEX IF EXISTS public.uq_assistance_requests_user_active_vehicle;
ALTER TABLE public.assistance_requests
  DROP CONSTRAINT IF EXISTS chk_assistance_requests_status;
UPDATE public.assistance_requests
SET status = CASE status
  WHEN 'created' THEN 'requested'
  WHEN 'sent' THEN 'notified'
  WHEN 'en_camino' THEN 'in_progress'
  ELSE status
END;
ALTER TABLE public.assistance_requests
  ADD CONSTRAINT chk_assistance_requests_status
    CHECK (status IN ('requested','notified','accepted','in_progress','completed','cancelled','expired')),
  ALTER COLUMN status SET DEFAULT 'requested',
  DROP COLUMN IF EXISTS en_camino_at,
  DROP COLUMN IF EXISTS sent_at;
CREATE UNIQUE INDEX uq_assistance_requests_user_active_vehicle
  ON public.assistance_requests(user_id, COALESCE(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL AND status IN ('requested','notified','accepted','in_progress');

REVOKE SELECT, INSERT, UPDATE ON public.assistance_action_tokens FROM app_runtime;
DROP TABLE IF EXISTS public.assistance_request_events;
DROP TABLE IF EXISTS public.assistance_action_tokens;

ALTER TABLE public.assistance_providers
  DROP CONSTRAINT IF EXISTS chk_assistance_providers_published_complete,
  DROP CONSTRAINT IF EXISTS chk_assistance_providers_coverage_valid,
  DROP CONSTRAINT IF EXISTS chk_assistance_providers_availability,
  DROP CONSTRAINT IF EXISTS chk_assistance_providers_whatsapp_metadata,
  DROP CONSTRAINT IF EXISTS chk_assistance_providers_phone_metadata;
DROP INDEX IF EXISTS public.idx_assistance_providers_verified;
DROP INDEX IF EXISTS public.idx_assistance_providers_availability;
DROP INDEX IF EXISTS public.idx_assistance_providers_coverage_gist;
ALTER TABLE public.assistance_providers
  DROP COLUMN IF EXISTS availability_status,
  DROP COLUMN IF EXISTS is_24_hours,
  DROP COLUMN IF EXISTS coverage_area,
  DROP COLUMN IF EXISTS whatsapp_hmac_key_version,
  DROP COLUMN IF EXISTS whatsapp_hmac,
  DROP COLUMN IF EXISTS whatsapp_aad_version,
  DROP COLUMN IF EXISTS whatsapp_key_version,
  DROP COLUMN IF EXISTS whatsapp_encrypted_dek,
  DROP COLUMN IF EXISTS whatsapp_tag,
  DROP COLUMN IF EXISTS whatsapp_nonce,
  DROP COLUMN IF EXISTS whatsapp_ciphertext,
  DROP COLUMN IF EXISTS phone_hmac_key_version,
  DROP COLUMN IF EXISTS phone_hmac,
  DROP COLUMN IF EXISTS phone_aad_version,
  DROP COLUMN IF EXISTS phone_key_version,
  DROP COLUMN IF EXISTS phone_encrypted_dek,
  DROP COLUMN IF EXISTS phone_tag,
  DROP COLUMN IF EXISTS phone_nonce,
  DROP COLUMN IF EXISTS phone_ciphertext;

COMMIT;
