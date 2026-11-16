-- B1: identidad, autenticación, consentimiento y dispositivos.
CREATE TYPE public.user_role AS ENUM ('user', 'workshop_owner', 'provider_owner', 'admin');
CREATE TYPE public.user_status AS ENUM ('pending_verification', 'active', 'suspended', 'deletion_pending', 'deleted');

CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_ciphertext BYTEA NULL,
  phone_nonce BYTEA NULL,
  phone_tag BYTEA NULL,
  phone_encrypted_dek BYTEA NULL,
  phone_key_version VARCHAR(100) NULL,
  phone_hmac BYTEA NULL,
  phone_hmac_key_version VARCHAR(100) NULL,
  display_name VARCHAR(120) NOT NULL,
  email_ciphertext BYTEA NULL,
  email_nonce BYTEA NULL,
  email_tag BYTEA NULL,
  email_encrypted_dek BYTEA NULL,
  email_key_version VARCHAR(100) NULL,
  email_hmac BYTEA NULL,
  email_hmac_key_version VARCHAR(100) NULL,
  role public.user_role NOT NULL DEFAULT 'user',
  status public.user_status NOT NULL DEFAULT 'active',
  phone_verified_at TIMESTAMPTZ(6) NULL,
  last_login_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  CONSTRAINT users_active_phone_required CHECK (
    status NOT IN ('active', 'suspended') OR (
      phone_ciphertext IS NOT NULL AND phone_nonce IS NOT NULL AND phone_tag IS NOT NULL
      AND phone_encrypted_dek IS NOT NULL AND phone_key_version IS NOT NULL
      AND phone_hmac IS NOT NULL AND phone_hmac_key_version IS NOT NULL
    )
  ),
  CONSTRAINT users_email_metadata_consistent CHECK (
    (email_ciphertext IS NULL AND email_nonce IS NULL AND email_tag IS NULL
      AND email_encrypted_dek IS NULL AND email_key_version IS NULL
      AND email_hmac IS NULL AND email_hmac_key_version IS NULL)
    OR
    (email_ciphertext IS NOT NULL AND email_nonce IS NOT NULL AND email_tag IS NOT NULL
      AND email_encrypted_dek IS NOT NULL AND email_key_version IS NOT NULL
      AND email_hmac IS NOT NULL AND email_hmac_key_version IS NOT NULL)
  ),
  CONSTRAINT users_display_name_nonempty CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT users_deleted_at_consistent CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL AND phone_ciphertext IS NULL AND phone_hmac IS NULL)
    OR status <> 'deleted'
  )
);
CREATE UNIQUE INDEX ux_users_phone_hmac ON public.users(phone_hmac);
CREATE UNIQUE INDEX ux_users_email_hmac ON public.users(email_hmac);
CREATE INDEX idx_users_role_status ON public.users(role, status);
CREATE INDEX idx_users_deleted_at ON public.users(deleted_at);
COMMENT ON TABLE public.users IS 'Identidad del usuario; teléfono y correo cifrados por la aplicación.';

CREATE TABLE public.sync_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  platform VARCHAR(16) NOT NULL,
  device_label VARCHAR(100) NULL,
  client_version VARCHAR(40) NULL,
  last_seen_at TIMESTAMPTZ(6) NULL,
  last_cursor BIGINT NULL,
  revoked_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  CONSTRAINT sync_devices_platform_check CHECK (platform IN ('android', 'ios')),
  CONSTRAINT sync_devices_cursor_nonnegative CHECK (last_cursor IS NULL OR last_cursor >= 0),
  CONSTRAINT sync_devices_id_user_unique UNIQUE (user_id, id)
);
CREATE INDEX idx_sync_devices_user_seen ON public.sync_devices(user_id, last_seen_at DESC);
CREATE INDEX idx_sync_devices_revoked ON public.sync_devices(revoked_at);
COMMENT ON TABLE public.sync_devices IS 'Registro de dispositivo y control de revocación; no se replica como contenido.';

CREATE TABLE public.refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  token_hash BYTEA NOT NULL,
  family_id UUID NOT NULL,
  device_id UUID NOT NULL REFERENCES public.sync_devices(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  revoked_at TIMESTAMPTZ(6) NULL,
  replaced_by_id UUID NULL REFERENCES public.refresh_tokens(id) ON DELETE RESTRICT,
  last_used_at TIMESTAMPTZ(6) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  user_agent_hash BYTEA NULL,
  ip_hash BYTEA NULL,
  CONSTRAINT refresh_tokens_hash_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT refresh_tokens_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT refresh_tokens_id_not_self CHECK (replaced_by_id IS NULL OR replaced_by_id <> id)
);
CREATE UNIQUE INDEX uq_refresh_tokens_token_hash ON public.refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_user_expiry ON public.refresh_tokens(user_id, expires_at);
CREATE INDEX idx_refresh_tokens_family ON public.refresh_tokens(family_id);
CREATE INDEX idx_refresh_tokens_replaced_by ON public.refresh_tokens(replaced_by_id);
CREATE INDEX idx_refresh_tokens_user_device ON public.refresh_tokens(user_id, device_id);
COMMENT ON TABLE public.refresh_tokens IS 'Solo hash de refresh JWT; nunca almacenar el token en claro.';

CREATE TABLE public.device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  sync_device_id UUID NULL REFERENCES public.sync_devices(id) ON DELETE RESTRICT,
  platform VARCHAR(16) NOT NULL,
  token_ciphertext BYTEA NULL,
  token_nonce BYTEA NULL,
  token_tag BYTEA NULL,
  token_encrypted_dek BYTEA NULL,
  token_key_version VARCHAR(100) NULL,
  token_hash BYTEA NULL,
  token_hmac_key_version VARCHAR(100) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ(6) NULL,
  revoked_at TIMESTAMPTZ(6) NULL,
  CONSTRAINT device_tokens_platform_check CHECK (platform IN ('android', 'ios')),
  CONSTRAINT device_tokens_status_check CHECK (status IN ('active', 'invalid', 'revoked')),
  CONSTRAINT device_tokens_hash_length CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  CONSTRAINT device_tokens_active_material CHECK (
    status <> 'active' OR (token_ciphertext IS NOT NULL AND token_nonce IS NOT NULL
      AND token_tag IS NOT NULL AND token_encrypted_dek IS NOT NULL
      AND token_key_version IS NOT NULL AND token_hash IS NOT NULL
      AND token_hmac_key_version IS NOT NULL)
  )
);
CREATE UNIQUE INDEX ux_device_tokens_token_hash ON public.device_tokens(token_hash);
CREATE INDEX idx_device_tokens_user_status ON public.device_tokens(user_id, status);
CREATE INDEX idx_device_tokens_sync_device ON public.device_tokens(sync_device_id);
COMMENT ON TABLE public.device_tokens IS 'Token FCM cifrado; nunca se devuelve al cliente después del registro.';

CREATE TABLE public.consent_logs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  consent_type VARCHAR(40) NOT NULL,
  policy_version VARCHAR(40) NOT NULL,
  accepted BOOLEAN NOT NULL,
  client_captured_at TIMESTAMPTZ(6) NULL,
  received_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  source VARCHAR(24) NOT NULL DEFAULT 'mobile',
  app_version VARCHAR(40) NULL,
  ip_ciphertext BYTEA NULL,
  ip_nonce BYTEA NULL,
  ip_tag BYTEA NULL,
  ip_encrypted_dek BYTEA NULL,
  ip_key_version VARCHAR(100) NULL,
  user_agent_ciphertext BYTEA NULL,
  user_agent_nonce BYTEA NULL,
  user_agent_tag BYTEA NULL,
  user_agent_encrypted_dek BYTEA NULL,
  user_agent_key_version VARCHAR(100) NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  CONSTRAINT consent_logs_policy_version_nonempty CHECK (length(btrim(policy_version)) > 0),
  CONSTRAINT consent_logs_source_check CHECK (source IN ('mobile', 'web_admin', 'migration')),
  CONSTRAINT consent_logs_ip_metadata_consistent CHECK (
    (ip_ciphertext IS NULL AND ip_nonce IS NULL AND ip_tag IS NULL AND ip_encrypted_dek IS NULL AND ip_key_version IS NULL)
    OR (ip_ciphertext IS NOT NULL AND ip_nonce IS NOT NULL AND ip_tag IS NOT NULL AND ip_encrypted_dek IS NOT NULL AND ip_key_version IS NOT NULL)
  ),
  CONSTRAINT consent_logs_user_agent_metadata_consistent CHECK (
    (user_agent_ciphertext IS NULL AND user_agent_nonce IS NULL AND user_agent_tag IS NULL AND user_agent_encrypted_dek IS NULL AND user_agent_key_version IS NULL)
    OR (user_agent_ciphertext IS NOT NULL AND user_agent_nonce IS NOT NULL AND user_agent_tag IS NOT NULL AND user_agent_encrypted_dek IS NOT NULL AND user_agent_key_version IS NOT NULL)
  )
);
CREATE INDEX idx_consent_logs_user_received ON public.consent_logs(user_id, received_at DESC);
CREATE INDEX idx_consent_logs_user_type_received ON public.consent_logs(user_id, consent_type, received_at DESC);
CREATE INDEX idx_consent_logs_policy_type ON public.consent_logs(policy_version, consent_type);

-- Únicamente se permite una actualización para anonimizar IP y User-Agent.
CREATE OR REPLACE FUNCTION public.protect_consent_log()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_logs es append-only; DELETE no permitido';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.consent_type IS DISTINCT FROM OLD.consent_type
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.accepted IS DISTINCT FROM OLD.accepted
    OR NEW.client_captured_at IS DISTINCT FROM OLD.client_captured_at
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.app_version IS DISTINCT FROM OLD.app_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR (NEW.ip_ciphertext IS DISTINCT FROM OLD.ip_ciphertext AND NEW.ip_ciphertext IS NOT NULL)
    OR (NEW.ip_nonce IS DISTINCT FROM OLD.ip_nonce AND NEW.ip_nonce IS NOT NULL)
    OR (NEW.ip_tag IS DISTINCT FROM OLD.ip_tag AND NEW.ip_tag IS NOT NULL)
    OR (NEW.ip_encrypted_dek IS DISTINCT FROM OLD.ip_encrypted_dek AND NEW.ip_encrypted_dek IS NOT NULL)
    OR (NEW.ip_key_version IS DISTINCT FROM OLD.ip_key_version AND NEW.ip_key_version IS NOT NULL)
    OR (NEW.user_agent_ciphertext IS DISTINCT FROM OLD.user_agent_ciphertext AND NEW.user_agent_ciphertext IS NOT NULL)
    OR (NEW.user_agent_nonce IS DISTINCT FROM OLD.user_agent_nonce AND NEW.user_agent_nonce IS NOT NULL)
    OR (NEW.user_agent_tag IS DISTINCT FROM OLD.user_agent_tag AND NEW.user_agent_tag IS NOT NULL)
    OR (NEW.user_agent_encrypted_dek IS DISTINCT FROM OLD.user_agent_encrypted_dek AND NEW.user_agent_encrypted_dek IS NOT NULL)
    OR (NEW.user_agent_key_version IS DISTINCT FROM OLD.user_agent_key_version AND NEW.user_agent_key_version IS NOT NULL) THEN
    RAISE EXCEPTION 'consent_logs es inmutable salvo anonimización de IP y User-Agent';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_consent_log() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_consent_log() TO app_runtime;
CREATE TRIGGER a_consent_logs_immutable
  BEFORE UPDATE OR DELETE ON public.consent_logs
  FOR EACH ROW EXECUTE FUNCTION public.protect_consent_log();

-- Verifica en BD que los dispositivos ligados a sesiones/tokens pertenezcan al mismo usuario.
CREATE OR REPLACE FUNCTION public.enforce_device_token_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sync_device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sync_devices d
    WHERE d.id = NEW.sync_device_id AND d.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'sync_device_id no pertenece al user_id indicado';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_device_token_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_device_token_owner() TO app_runtime;
CREATE TRIGGER device_tokens_owner_guard
  BEFORE INSERT OR UPDATE OF user_id, sync_device_id ON public.device_tokens
  FOR EACH ROW EXECUTE FUNCTION public.enforce_device_token_owner();

CREATE OR REPLACE FUNCTION public.enforce_refresh_device_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sync_devices d
    WHERE d.id = NEW.device_id AND d.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'device_id no pertenece al user_id indicado';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_refresh_device_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_refresh_device_owner() TO app_runtime;
CREATE TRIGGER refresh_tokens_owner_guard
  BEFORE INSERT OR UPDATE OF user_id, device_id ON public.refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION public.enforce_refresh_device_owner();

COMMENT ON TABLE public.consent_logs IS 'Evidencia append-only de consentimiento; solo se permite borrar IP/User-Agent como anonimización.';

GRANT SELECT, INSERT, UPDATE ON public.users, public.sync_devices, public.refresh_tokens,
  public.device_tokens, public.consent_logs TO app_runtime;
