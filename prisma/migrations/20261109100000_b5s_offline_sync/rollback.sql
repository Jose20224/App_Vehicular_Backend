-- Reversión explícita de B5S. Respaldar los datos antes de ejecutar.
BEGIN;
DROP TABLE IF EXISTS public.processed_mutations;
DROP TABLE IF EXISTS public.sync_retention_state;
DROP TABLE IF EXISTS public.sync_bootstraps;
DROP TABLE IF EXISTS public.sync_channel_states;
DROP TABLE IF EXISTS public.assistance_requests;
DROP TRIGGER IF EXISTS users_profile_sync_metadata ON public.users;
DROP FUNCTION IF EXISTS public.assign_user_profile_sync_metadata();
ALTER TABLE public.users DROP COLUMN IF EXISTS sync_version;
COMMIT;
