ALTER TABLE public.device_tokens ADD COLUMN token_aad_version INTEGER DEFAULT 1;
ALTER TABLE public.device_tokens ADD CONSTRAINT uq_device_tokens_id_user UNIQUE (id, user_id);
ALTER TABLE public.device_tokens ADD CONSTRAINT ck_device_tokens_aad_version CHECK (token_aad_version IS NULL OR token_aad_version IN (1,2));

CREATE TYPE public.reminder_status AS ENUM ('scheduled', 'processing', 'sent', 'cancelled', 'failed');

CREATE TABLE public.reminders (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  vehicle_document_id UUID NOT NULL,
  title VARCHAR(120) NOT NULL,
  description VARCHAR(500),
  reminder_type VARCHAR(24) NOT NULL DEFAULT 'document_expiry' CHECK (reminder_type IN ('document_expiry')),
  due_at TIMESTAMPTZ NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  lead_time_days SMALLINT NOT NULL CHECK (lead_time_days IN (30, 15, 7, 1, 0)),
  channel VARCHAR(16) NOT NULL DEFAULT 'push' CHECK (channel IN ('push', 'in_app')),
  status public.reminder_status NOT NULL DEFAULT 'scheduled',
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT fk_reminders_document_owner FOREIGN KEY (vehicle_document_id, user_id)
    REFERENCES public.vehicle_documents(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT uq_reminders_id_user UNIQUE (id, user_id),
  CONSTRAINT ck_reminders_uuid_v7 CHECK (substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')),
  CONSTRAINT ck_reminders_title CHECK (length(btrim(title)) > 0),
  CONSTRAINT ck_reminders_status_timestamps CHECK (
    (status = 'sent' AND sent_at IS NOT NULL) OR status <> 'sent'
  )
);
CREATE INDEX idx_reminders_user_id ON public.reminders(user_id);
CREATE INDEX idx_reminders_user_sync_version ON public.reminders(user_id, sync_version);
CREATE INDEX idx_reminders_dispatch ON public.reminders(status, scheduled_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_reminders_user_schedule ON public.reminders(user_id, scheduled_at) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_reminders_document_offset_channel_active
  ON public.reminders(vehicle_document_id, lead_time_days, channel)
  WHERE deleted_at IS NULL AND status IN ('scheduled', 'processing');
CREATE TRIGGER reminders_sync_metadata BEFORE INSERT OR UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();

CREATE TABLE public.notification_preferences (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  category VARCHAR(30) NOT NULL DEFAULT 'document_expiry' CHECK (category IN ('document_expiry')),
  enabled_offsets INTEGER[] NOT NULL DEFAULT ARRAY[30,15,7,1,0]::INTEGER[],
  preferred_time VARCHAR(5) NOT NULL DEFAULT '09:00',
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  local_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  timezone VARCHAR(40) NOT NULL DEFAULT 'America/Managua' CHECK (timezone = 'America/Managua'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT uq_notification_preferences_id_user UNIQUE (id, user_id),
  CONSTRAINT ck_notification_preferences_uuid_v7 CHECK (substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')),
  CONSTRAINT ck_notification_preferences_time CHECK (preferred_time ~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT ck_notification_preferences_offsets CHECK (
    cardinality(enabled_offsets) <= 5 AND enabled_offsets <@ ARRAY[30,15,7,1,0]::INTEGER[]
  )
);
CREATE UNIQUE INDEX uq_notification_preferences_user_category
  ON public.notification_preferences(user_id, category) WHERE deleted_at IS NULL;
CREATE INDEX idx_notification_preferences_user_id ON public.notification_preferences(user_id);
CREATE INDEX idx_notification_preferences_user_sync_version ON public.notification_preferences(user_id, sync_version);
CREATE TRIGGER notification_preferences_sync_metadata BEFORE INSERT OR UPDATE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();

CREATE TABLE public.notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reminder_id UUID,
  device_token_id UUID,
  channel VARCHAR(16) NOT NULL CHECK (channel IN ('push', 'in_app')),
  provider VARCHAR(32) NOT NULL CHECK (provider IN ('fcm', 'internal')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'invalid_token')),
  provider_message_id VARCHAR(180),
  error_code VARCHAR(80),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  read_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_notification_logs_reminder_owner FOREIGN KEY (reminder_id, user_id) REFERENCES public.reminders(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_notification_logs_device_owner FOREIGN KEY (device_token_id, user_id) REFERENCES public.device_tokens(id, user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_notification_logs_reminder_channel
  ON public.notification_logs(reminder_id, channel) WHERE reminder_id IS NOT NULL;
CREATE INDEX idx_notification_logs_user_created ON public.notification_logs(user_id, created_at DESC);
CREATE INDEX idx_notification_logs_reminder_created ON public.notification_logs(reminder_id, created_at);
CREATE INDEX idx_notification_logs_status_created ON public.notification_logs(status, created_at);

GRANT SELECT, INSERT, UPDATE ON public.reminders, public.notification_preferences TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.notification_logs TO app_runtime;
COMMENT ON TABLE public.reminders IS 'Recordatorios de vencimiento calculados por servidor. Sync pull-only; el móvil no muta estado ni programación.';
COMMENT ON TABLE public.notification_preferences IS 'Preferencias de recordatorios por usuario. Sync-ready; propietario autenticado.';
COMMENT ON TABLE public.notification_logs IS 'Historial operativo de entregas; no contiene tokens ni texto sensible.';
