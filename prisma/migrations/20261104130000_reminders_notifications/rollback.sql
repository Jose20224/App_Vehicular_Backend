DROP TABLE IF EXISTS public.notification_logs;
DROP TABLE IF EXISTS public.notification_preferences;
DROP TABLE IF EXISTS public.reminders;
DROP TYPE IF EXISTS public.reminder_status;

ALTER TABLE public.device_tokens DROP CONSTRAINT IF EXISTS ck_device_tokens_aad_version;
ALTER TABLE public.device_tokens DROP CONSTRAINT IF EXISTS uq_device_tokens_id_user;
ALTER TABLE public.device_tokens DROP COLUMN IF EXISTS token_aad_version;
