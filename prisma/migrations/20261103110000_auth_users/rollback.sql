-- Reversa B1. Ejecutar únicamente en BD aislada de pruebas o conforme al procedimiento
-- expandir/contraer aprobado. La reversa elimina las tablas y sus datos.
DROP TRIGGER IF EXISTS refresh_tokens_owner_guard ON public.refresh_tokens;
DROP TRIGGER IF EXISTS device_tokens_owner_guard ON public.device_tokens;
DROP TRIGGER IF EXISTS a_consent_logs_immutable ON public.consent_logs;
DROP FUNCTION IF EXISTS public.enforce_refresh_device_owner();
DROP FUNCTION IF EXISTS public.enforce_device_token_owner();
DROP FUNCTION IF EXISTS public.protect_consent_log();
DROP TABLE IF EXISTS public.device_tokens;
DROP TABLE IF EXISTS public.refresh_tokens;
DROP TABLE IF EXISTS public.consent_logs;
DROP TABLE IF EXISTS public.sync_devices;
DROP TABLE IF EXISTS public.users;
DROP TYPE IF EXISTS public.user_status;
DROP TYPE IF EXISTS public.user_role;
